import {ConfigService} from '@nestjs/config';
import {IncomingMessage, Server, ServerResponse} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AddressInfo} from 'node:net';
import {AppConfiguration} from '../../config/app.config';
import {ProfileStoreService} from '../../profile/profile-store.service';
import {AnswerEngineService} from '../answer-engine.service';
import {FormAdapterRegistryService} from './form-adapter-registry.service';
import {FormArtifactService} from './form-artifact.service';
import {GoogleFormsAdapter} from './google-forms.adapter';
import {PlaywrightBrowserService} from './playwright-browser.service';
import {PlaywrightFormProcessor} from './playwright-form.processor';
import {AuthenticationStateStoreService} from './authentication-state-store.service';

jest.setTimeout(30000);

describe('PlaywrightFormProcessor with safe local mock forms', () => {
  let directory: string;
  let browser: PlaywrightBrowserService;
  let server: Server;
  let origin: string;
  let processor: PlaywrightFormProcessor;
  let authenticationStates: AuthenticationStateStoreService;
  let profile: {
    verified: {automationConsents: {automaticSubmission: boolean; legalDeclarations: Record<string, boolean>}};
    documentCatalog?: Array<{id: string; fileName: string; path: string; labels: string[]}>;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'job-form-test-'));
    await writeFile(join(directory, 'resume.pdf'), '%PDF-1.4 safe mock resume');
    const config = new ConfigService<AppConfiguration, true>({
      formAutomationEnabled: true,
      formAutoSubmit: true,
      formAllowLocalhost: true,
      formTimeoutMs: 5000,
      formNavigationTimeoutMs: 3000,
      formMaxRetries: 0,
      formMaxPages: 5,
      formArtifactsDirectory: join(directory, 'artifacts'),
      resumeDirectory: directory,
      applicationDocumentsDirectory: directory,
      formAuthStatePath: join(directory, 'auth', 'state.json'),
      formAuthLoginUrl: 'https://accounts.google.com/',
      formAuthLoginTimeoutMs: 5000,
      playwrightHeadless: true,
      playwrightBrowserExecutablePath: ''
    } as AppConfiguration);
    authenticationStates = new AuthenticationStateStoreService(config);
    browser = new PlaywrightBrowserService(config, authenticationStates);
    const adapter = new GoogleFormsAdapter(config);
    const registry = new FormAdapterRegistryService(adapter);
    const artifacts = new FormArtifactService(config);
    profile = {verified: {automationConsents: {automaticSubmission: true, legalDeclarations: {}}}};
    const profiles = {load: jest.fn(async () => profile)};
    const answers = {
      generate: jest.fn(async ({questions}: {questions: Array<{id: string; label: string; type: string}>}) => ({
        answers: questions.map(question => ({
          questionId: question.id,
          question: question.label,
          fieldType: question.type,
          value: answerFor(question.label),
          confidence: 'high',
          provenance: {source: 'verified_profile', detail: 'safe test answer'}
        })),
        resume: {
          resume: {id: 'fullstack', fileName: 'resume.pdf', path: join(directory, 'resume.pdf'), skills: [], summary: ''},
          confidence: 'high', reason: 'safe test selection', scores: {fullstack: 10}
        },
        conflicts: [],
        priority: []
      }))
    };
    processor = new PlaywrightFormProcessor(
      config,
      browser,
      registry,
      answers as unknown as AnswerEngineService,
      profiles as unknown as ProfileStoreService,
      artifacts,
      authenticationStates
    );
  });

  afterEach(async () => {
    await browser.onModuleDestroy();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  });

  it('fills and confirms a multi-page mock form without contacting a real application', async () => {
    await serve(mockMultiPageForm());
    const result = await processor.process({
      jobId: 'safe-mock-job', applicationId: 'safe-app', formUrls: [`${origin}/form`],
      text: 'Full Stack Developer using Node.js, NestJS, and React.'
    });

    expect(result.status).toBe('completed');
    expect(result.details).toMatchObject({
      platform: 'google_forms',
      pages: [{pageIndex: 0}, {pageIndex: 1}],
      submission: {attempted: true, evidence: {kind: 'confirmation_container'}}
    });
    expect((result.details as {filled: Array<{source: string}>}).filled).toEqual(expect.arrayContaining([
      expect.objectContaining({source: 'resume'})
    ]));
    expect(result.details).toMatchObject({
      attachments: [{fileName: 'resume.pdf', kind: 'resume', verified: true}]
    });
  });

  it('reuses a persisted authenticated session for a protected form', async () => {
    await authenticationStates.save({
      cookies: [{
        name: 'mock_session', value: 'authenticated', domain: '127.0.0.1', path: '/', expires: -1,
        httpOnly: true, secure: false, sameSite: 'Lax'
      }],
      origins: []
    });
    await serveRequest((request, response) => {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(request.headers.cookie?.includes('mock_session=authenticated')
        ? mockSinglePageForm()
        : '<form><input type="password"><p>Sign in to continue</p></form>');
    });
    const result = await processor.process({
      jobId: 'authenticated-mock', applicationId: 'safe-app', formUrls: [`${origin}/form`], text: 'Developer role'
    });
    expect(result.status).toBe('completed');
  });

  it('uses only a cataloged matching file for a non-resume upload', async () => {
    await writeFile(join(directory, 'cover-letter.pdf'), '%PDF-1.4 safe mock cover letter');
    profile.documentCatalog = [{
      id: 'cover-letter', fileName: 'cover-letter.pdf', path: join(directory, 'cover-letter.pdf'),
      labels: ['cover letter']
    }];
    await serve(`<!doctype html><form>
      <div data-question data-required="true"><span data-question-label>Attach cover letter *</span>
        <input type="file" required accept="application/pdf"></div>
      <button type="button" data-form-action="submit">Submit</button>
      <script>document.querySelector('button').addEventListener('click', () => {
        const name = document.querySelector('input[type="file"]').files?.[0]?.name;
        document.body.innerHTML = name === 'cover-letter.pdf'
          ? '<div data-submission-success>Your response has been recorded.</div>'
          : '<div role="alert">Wrong document.</div>';
      });</script></form>`);
    const result = await processor.process({
      jobId: 'document-mock', applicationId: 'safe-app', formUrls: [`${origin}/form`], text: 'Developer role'
    });
    expect(result.status).toBe('completed');
    expect(result.details).toMatchObject({
      attachments: [{fileName: 'cover-letter.pdf', kind: 'application_document', verified: true}]
    });
  });

  it('requests reauthentication when a saved session is expired', async () => {
    await authenticationStates.save({
      cookies: [{
        name: 'expired', value: 'old', domain: '127.0.0.1', path: '/', expires: 1,
        httpOnly: true, secure: false, sameSite: 'Lax'
      }],
      origins: []
    });
    await serve('<form><input type="password"><p>Sign in to continue</p></form>');
    const result = await processor.process({
      jobId: 'expired-auth-mock', applicationId: 'safe-app', formUrls: [`${origin}/form`], text: 'Developer role'
    });
    expect(result.status).toBe('needs_manual_action');
    expect((result.details as {issues: Array<{code: string}>}).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'reauthentication_required'})
    ]));
  });

  it('returns needs_manual_action for CAPTCHA without clicking Submit', async () => {
    await serve(`<!doctype html><form><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor"></iframe>
      <button data-form-action="submit">Submit</button></form>`);
    const result = await processor.process({
      jobId: 'captcha-mock', applicationId: 'safe-app', formUrls: [`${origin}/form`], text: 'Developer role'
    });
    expect(result.status).toBe('needs_manual_action');
    expect(result.details).toMatchObject({submission: {attempted: false}});
    expect((result.details as {issues: Array<{code: string}>}).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'captcha'})
    ]));
  });

  it('does not accept a required legal declaration without explicit profile consent', async () => {
    await serve(`<!doctype html><form>
      <div data-question data-required="true"><span data-question-label>I certify that all information is accurate *</span>
        <label><input type="checkbox" required> I agree</label></div>
      <button data-form-action="submit">Submit</button></form>`);
    const result = await processor.process({
      jobId: 'legal-mock', applicationId: 'safe-app', formUrls: [`${origin}/form`], text: 'Developer role'
    });
    expect(result.status).toBe('needs_manual_action');
    expect((result.details as {issues: Array<{code: string}>}).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'legal_consent_required'})
    ]));
  });

  it('does not infer success from a Submit click without confirmation evidence', async () => {
    await serve(`<!doctype html><form>
      <div data-question data-required="true"><span data-question-label>Full Name *</span><input type="text" required></div>
      <button type="button" data-form-action="submit">Submit</button></form>`);
    const result = await processor.process({
      jobId: 'unconfirmed-mock', applicationId: 'safe-app', formUrls: [`${origin}/form`], text: 'Developer role'
    });
    expect(result.status).toBe('needs_manual_action');
    expect(result.details).toMatchObject({submission: {attempted: true}});
    expect((result.details as {issues: Array<{code: string}>}).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'submission_unconfirmed'})
    ]));
  });

  async function serve(html: string): Promise<void> {
    await serveRequest((_request, response) => {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(html);
    });
  }

  async function serveRequest(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<void> {
    server = new Server(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});

function answerFor(label: string): string | string[] {
  if (/name/i.test(label)) return 'Muneeb Ur Rehman';
  if (/email/i.test(label)) return 'munib.urehmann@gmail.com';
  if (/relocat/i.test(label)) return 'Yes';
  if (/skills/i.test(label)) return ['Node.js'];
  if (/start date/i.test(label)) return '2026-11-01';
  if (/availability/i.test(label)) return 'Immediate';
  return 'I am interested in this role.';
}

function mockMultiPageForm(): string {
  return `<!doctype html><html><body><h1 data-form-title>Full Stack Developer</h1><form id="application">
    <section id="page-one">
      <div data-question data-required="true"><span data-question-label>Full Name *</span><input type="text" required></div>
      <button type="button" data-form-action="next">Next</button>
    </section>
    <section id="page-two" style="display:none">
      <div data-question data-required="true"><span data-question-label>Email Address *</span><input type="email" required></div>
      <div data-question data-required="true"><span data-question-label>Are you willing to relocate? *</span>
        <label><input type="radio" name="relocate" required>Yes</label><label><input type="radio" name="relocate">No</label></div>
      <div data-question><span data-question-label>Key Skills</span>
        <label><input type="checkbox">Node.js</label><label><input type="checkbox">Python</label></div>
      <div data-question data-required="true"><span data-question-label>Earliest Start Date *</span><input type="date" required></div>
      <div data-question data-required="true"><span data-question-label>Availability *</span>
        <select required><option value="">Choose</option><option>Immediate</option><option>Two weeks</option></select></div>
      <div data-question><span data-question-label>Why are you interested in this role?</span><textarea></textarea></div>
      <div data-question data-required="true"><span data-question-label>Upload resume *</span><input type="file" required accept="application/pdf"></div>
      <button type="button" data-form-action="submit">Submit</button>
    </section>
  </form><script>
    document.querySelector('[data-form-action="next"]').addEventListener('click', () => {
      document.querySelector('#page-one').style.display = 'none';
      document.querySelector('#page-two').style.display = 'block';
    });
    document.querySelector('[data-form-action="submit"]').addEventListener('click', () => {
      const attached = document.querySelector('input[type="file"]').files?.[0]?.name === 'resume.pdf';
      document.body.innerHTML = attached
        ? '<div data-submission-success>Your response has been recorded.</div>'
        : '<div role="alert">Resume was not attached.</div>';
    });
  </script></body></html>`;
}

function mockSinglePageForm(): string {
  return `<!doctype html><form>
    <div data-question data-required="true"><span data-question-label>Full Name *</span><input type="text" required></div>
    <button type="button" data-form-action="submit">Submit</button>
    <script>document.querySelector('button').addEventListener('click', () => {
      document.body.innerHTML = '<div data-submission-success>Your response has been recorded.</div>';
    });</script>
  </form>`;
}
