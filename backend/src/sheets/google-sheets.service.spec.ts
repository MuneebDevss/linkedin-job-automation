import {ConfigService} from '@nestjs/config';
import {AppConfiguration} from '../config/app.config';
import {ApplicationRecord} from '../database/database.service';
import {GoogleSheetsService} from './google-sheets.service';

describe('GoogleSheetsService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('adopts an n8n row by Job Link, adds stable columns, and preserves manual and email-owned cells', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({
        values: [
          ['Company', 'Role', 'Job Link', 'Application Channel', 'Date Found', 'Date Applied', 'Status', 'Location', 'Notes'],
          ['Manual Company', 'Existing Role', 'https://linkedin.test/post/1', 'Email', '2026-10-29', '', 'Draft created', 'Lahore', 'Keep this manual note']
        ]
      }))
      .mockResolvedValueOnce(response({updatedCells: 16}))
      .mockResolvedValueOnce(response({totalUpdatedCells: 8}));
    global.fetch = fetchMock as typeof fetch;
    const service = new GoogleSheetsService(config());

    const result = await service.sync(application());

    expect(result).toMatchObject({rowNumber: 2, operation: 'updated'});
    const batchBody = JSON.parse(String(fetchMock.mock.calls[2][1].body)) as {
      data: Array<{range: string; values: string[][]}>;
    };
    const values = new Map(batchBody.data.map(item => [item.range, item.values[0][0]]));
    expect([...values.values()]).toContain('app-1');
    expect([...values.values()]).toContain('Email + Form');
    expect([...values.values()]).toContain('completed');
    expect([...values.values()]).not.toContain('Acme');
    expect([...values.values()]).not.toContain('Form submitted');
    expect(JSON.stringify(batchBody)).not.toContain('Keep this manual note');
    expect(JSON.stringify(batchBody)).not.toContain('Draft created');
  });

  it('appends a form-only application once when no stable ID or legacy Job Link matches', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response({values: [['Company', 'Role', 'Job Link']]}))
      .mockResolvedValueOnce(response({updatedCells: 10}))
      .mockResolvedValueOnce(response({updates: {updatedRange: "'Applications'!A5:J5"}}));
    global.fetch = fetchMock as typeof fetch;
    const service = new GoogleSheetsService(config());
    const value = application();
    value.method = 'form';
    value.applicationChannel = 'Form';

    const result = await service.sync(value);

    expect(result).toMatchObject({rowNumber: 5, operation: 'appended'});
    expect(String(fetchMock.mock.calls[2][0])).toContain(':append');
    const appendBody = JSON.parse(String(fetchMock.mock.calls[2][1].body)) as {values: string[][]};
    expect(appendBody.values[0]).toEqual(expect.arrayContaining(['app-1', 'https://linkedin.test/post/1', 'completed']));
  });

  function config(): ConfigService<AppConfiguration, true> {
    return new ConfigService<AppConfiguration, true>({
      googleSheetsSyncEnabled: true,
      googleSheetsSpreadsheetId: 'sheet-id',
      googleSheetsTab: 'Applications',
      googleSheetsCredentialPath: '',
      googleSheetsAccessToken: 'test-token',
      googleSheetsTimeoutMs: 1000
    } as AppConfiguration);
  }

  function application(): ApplicationRecord {
    return {
      id: 'app-1', sourceUrl: 'https://linkedin.test/post/1', contentHash: 'hash', method: 'email_and_form',
      payload: {}, emails: ['jobs@acme.test'], formUrls: ['https://forms.test/apply'], company: 'Acme',
      role: 'Developer', location: 'Islamabad', jobDescription: 'Developer role',
      linkedinPostUrl: 'https://linkedin.test/post/1', applicationUrl: 'https://forms.test/apply',
      selectedResume: 'resume.pdf', applicationChannel: 'Email + Form',
      createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:10:00.000Z',
      workflows: [
        {id: 'email-1', applicationId: 'app-1', type: 'email', status: 'completed', attempts: 1,
          response: {status: 'draft_created'}, error: null, createdAt: '2026-10-30T08:00:00.000Z',
          updatedAt: '2026-10-30T08:01:00.000Z', completedAt: '2026-10-30T08:01:00.000Z', outcome: 'draft_created'},
        {id: 'form-1', applicationId: 'app-1', type: 'form', status: 'completed', attempts: 1,
          response: {submission: {attempted: true, evidence: {message: 'Your response has been recorded.', url: 'https://forms.test/thanks'}}},
          error: null, createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:10:00.000Z',
          completedAt: '2026-10-30T08:10:00.000Z', outcome: 'form_submitted'}
      ],
      formQuestions: [], formSubmissionAttempts: [], sheetsSync: null
    };
  }

  function response(body: unknown): Response {
    return {ok: true, status: 200, text: async () => JSON.stringify(body)} as Response;
  }
});
