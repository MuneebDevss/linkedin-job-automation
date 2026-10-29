import {ConfigService} from '@nestjs/config';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseService} from './database.service';

describe('DatabaseService application tracking', () => {
  let directory: string;
  let database: DatabaseService;

  afterEach(async () => {
    database?.onModuleDestroy();
    if (directory) await rm(directory, {recursive: true, force: true});
  });

  it('migrates the legacy schema without deleting applications or workflows', async () => {
    directory = await mkdtemp(join(tmpdir(), 'jobs-db-migration-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE applications (
        id TEXT PRIMARY KEY, source_url TEXT, content_hash TEXT NOT NULL, method TEXT NOT NULL,
        payload_json TEXT NOT NULL, emails_json TEXT NOT NULL, forms_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY, application_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('email', 'form')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'needs_manual_action', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0, response_json TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(application_id, type)
      );
      INSERT INTO applications VALUES (
        'app-1', 'https://linkedin.test/post/1', 'hash', 'form',
        '{"text":"Legacy role","url":"https://linkedin.test/post/1"}', '[]',
        '["https://docs.google.com/forms/d/example/viewform"]',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO workflow_runs VALUES (
        'form-1', 'app-1', 'form', 'completed', 1, '{"submission":{"attempted":true}}', NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z'
      );
    `);
    legacy.close();

    database = new DatabaseService(new ConfigService({databasePath: path}) as never);
    database.onModuleInit();
    const application = database.getApplication('app-1');

    expect(application).toMatchObject({
      id: 'app-1', jobDescription: 'Legacy role', linkedinPostUrl: 'https://linkedin.test/post/1',
      applicationUrl: 'https://docs.google.com/forms/d/example/viewform', applicationChannel: 'Form'
    });
    expect(application?.workflows[0]).toMatchObject({status: 'completed', completedAt: '2026-01-01T00:05:00.000Z'});
    expect(application?.formSubmissionAttempts).toEqual([
      expect.objectContaining({attemptNumber: 1, attempted: true, outcome: 'completed'})
    ]);
    expect(application?.sheetsSync).toMatchObject({status: 'pending'});
  });

  it('persists normalized answers, failures, evidence, and every form attempt transactionally', async () => {
    directory = await mkdtemp(join(tmpdir(), 'jobs-db-form-'));
    const path = join(directory, 'jobs.sqlite');
    database = new DatabaseService(new ConfigService({databasePath: path}) as never);
    database.onModuleInit();
    database.insertApplication({
      id: 'app-2', sourceUrl: 'https://linkedin.test/post/2', contentHash: 'hash-2', method: 'form',
      payload: {text: 'Mobile Developer'}, emails: [], forms: ['https://docs.google.com/forms/d/example/viewform'],
      company: 'Acme', role: 'Mobile Developer', location: 'Islamabad', description: 'Mobile Developer'
    });
    database.insertWorkflow('form-2', 'app-2', 'form');
    database.updateWorkflow('form-2', 'processing');
    database.recordFormOutcome('form-2', 'needs_manual_action', {
      url: 'https://docs.google.com/forms/d/example/viewform',
      filled: [
        {questionId: 'gform-p0-q0', label: 'Name', fieldType: 'text', required: true,
          source: 'verified_profile', confidence: 'high', value: 'Muneeb'},
        {questionId: 'gform-p0-q1', label: 'Why us?', fieldType: 'long_text', required: true,
          source: 'gemini', confidence: 'medium', value: 'Strong product fit.'}
      ],
      issues: [{questionId: 'gform-p0-q2', label: 'Portfolio', code: 'required_answer_unresolved', required: true, message: 'Missing'}],
      screenshots: ['/evidence/manual.png'], resume: {fileName: 'resume.pdf'}, submission: {attempted: false}
    });

    expect(database.getApplication('app-2')?.formQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({questionId: 'gform-p0-q0', answerSource: 'profile', confidence: 'high'}),
      expect.objectContaining({questionId: 'gform-p0-q1', answerSource: 'gemini', confidence: 'medium'}),
      expect.objectContaining({questionId: 'gform-p0-q2', outcome: 'unresolved', errorCode: 'required_answer_unresolved'})
    ]));

    expect(database.claimWorkflowRetry('form-2', 'needs_manual_action')).toBe(true);
    database.recordFormOutcome('form-2', 'completed', {
      url: 'https://docs.google.com/forms/d/example/viewform',
      questions: [
        {questionId: 'gform-p0-q2', pageIndex: 0, label: 'Portfolio', fieldType: 'text', required: true},
        {questionId: 'gform-p0-q3', pageIndex: 0, label: 'Optional note', fieldType: 'long_text', required: false}
      ],
      filled: [{questionId: 'gform-p0-q2', label: 'Portfolio', fieldType: 'text', required: true,
        source: 'approved_suggestion', confidence: 'high', value: 'https://portfolio.test'}],
      issues: [], screenshots: [], resume: {fileName: 'resume.pdf'},
      submission: {attempted: true, evidence: {kind: 'confirmation_message', message: 'Recorded', url: 'https://forms.test/thanks'}}
    });

    const application = database.getApplication('app-2')!;
    expect(application).toMatchObject({
      company: 'Acme', role: 'Mobile Developer', location: 'Islamabad', selectedResume: 'resume.pdf'
    });
    expect(application.formQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({questionId: 'gform-p0-q2', answerSource: 'approved_memory', confidence: 'high'}),
      expect.objectContaining({questionId: 'gform-p0-q3', outcome: 'unanswered', required: false})
    ]));
    expect(application.formSubmissionAttempts).toHaveLength(2);
    expect(application.formSubmissionAttempts[0]).toMatchObject({
      attemptNumber: 1, attempted: false, outcome: 'needs_manual_action', screenshots: ['/evidence/manual.png']
    });
    expect(application.formSubmissionAttempts[1]).toMatchObject({
      attemptNumber: 2, attempted: true, outcome: 'completed', evidence: {kind: 'confirmation_message'}
    });
    expect(application.sheetsSync).toMatchObject({status: 'pending', attempts: 0});
  });
});
