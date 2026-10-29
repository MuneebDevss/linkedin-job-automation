import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {access, realpath} from 'node:fs/promises';
import {basename, join, relative, resolve} from 'node:path';
import {Page} from 'playwright';
import {AppConfiguration} from '../../config/app.config';
import {ProfileStoreService} from '../../profile/profile-store.service';
import {ApplicationDocumentProfile, ProfileDocument, ResumeProfile} from '../../profile/profile.types';
import {AnswerEngineService} from '../answer-engine.service';
import {AnswerValue, GeneratedAnswer} from '../answering.types';
import {FormProcessingInput, FormProcessingResult, FormProcessor} from '../form-processor.interface';
import {FormAdapterRegistryService} from './form-adapter-registry.service';
import {FormArtifactService} from './form-artifact.service';
import {ExtractedFormQuestion, FillRecord, FormIssue} from './form-automation.types';
import {FormPlatformAdapter} from './form-platform-adapter.interface';
import {PlaywrightBrowserService} from './playwright-browser.service';
import {AuthenticationStateStoreService} from './authentication-state-store.service';

interface AutomationDetails {
  platform?: string;
  url?: string;
  attempts: number;
  pages: Array<{pageIndex: number; title: string; questions: number}>;
  filled: FillRecord[];
  issues: FormIssue[];
  screenshots: string[];
  browserErrors: string[];
  resume?: {id: string; fileName: string; path: string} | null;
  attachments: Array<{questionId: string; fileName: string; kind: 'resume' | 'application_document'; verified: boolean}>;
  authentication?: {state: string; updatedAt: string | null};
  submission?: {attempted: boolean; evidence?: unknown};
}

@Injectable()
export class PlaywrightFormProcessor implements FormProcessor {
  private readonly logger = new Logger(PlaywrightFormProcessor.name);

  /**
   * **Summary:** Creates the form processor with the browser, platform, answer, profile, artifact, and authentication services required for safe application automation.
   * **Inputs:** The injected services provide configuration, browser sessions, form adapters, answers, profile data, evidence capture, and authentication state.
   * **Returns:** A processor instance ready to execute form-application workflows.
   */
  constructor(
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly browser: PlaywrightBrowserService,
    private readonly adapters: FormAdapterRegistryService,
    private readonly answers: AnswerEngineService,
    private readonly profiles: ProfileStoreService,
    private readonly artifacts: FormArtifactService,
    private readonly authenticationStates: AuthenticationStateStoreService
  ) {}

  /**
   * **Summary:** Validates a form workflow, selects its platform adapter, and runs retry-safe automation without risking duplicate submissions.
   * **Inputs:** `input` contains the job identity, post text, and discovered application-form URLs.
   * **Returns:** The completed, failed, or manual-action result with a detailed automation audit trail.
   */
  async process(input: FormProcessingInput): Promise<FormProcessingResult> {
    const details: AutomationDetails = {
      attempts: 0, pages: [], filled: [], issues: [], screenshots: [], browserErrors: [], attachments: [],
      submission: {attempted: false}
    };
    if (!this.config.get('formAutomationEnabled', {infer: true})) {
      return this.manual(details, 'automation_disabled', 'Form automation is disabled by configuration.');
    }
    const uniqueUrls = [...new Set(input.formUrls)];
    if (uniqueUrls.length !== 1) {
      return this.manual(details, 'ambiguous_form_url',
        uniqueUrls.length ? 'More than one application form was found; automatic submission would be ambiguous.' : 'No application form URL was found.');
    }
    const url = uniqueUrls[0];
    const adapter = this.adapters.forUrl(url);
    details.url = url;
    if (!adapter) return this.manual(details, 'unsupported_platform', 'Only Google Forms are automated in this patch.');
    details.platform = adapter.platform;

    const attempts = this.config.get('formMaxRetries', {infer: true}) + 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      details.attempts = attempt;
      try {
        return await this.browser.withIsolatedContext(input.jobId, async context => {
          const page = await context.newPage();
          this.recordBrowserErrors(page, details);
          return this.run(input, url, adapter, page, details);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        details.browserErrors.push(message);
        this.logger.warn(`Form job ${input.jobId} attempt ${attempt}/${attempts} failed: ${message}`);
        if (details.submission?.attempted) {
          details.issues.push({
            code: 'submission_state_unknown',
            message: 'The browser failed after submission began, so the job was not retried to avoid a duplicate application.'
          });
          return {status: 'needs_manual_action', details};
        }
        if (attempt === attempts) {
          details.issues.push({code: 'browser_failure', message});
          return {status: 'failed', details};
        }
      }
    }
    return {status: 'failed', details};
  }

  /**
   * **Summary:** Completes the supported pages of one form by generating trusted answers, attaching approved documents, validating fields, and submitting only with consent.
   * **Inputs:** `input` supplies job context; `url`, `adapter`, and `page` identify the form; `details` accumulates the audit trail.
   * **Returns:** The final form-processing result and recorded evidence.
   */
  private async run(
    input: FormProcessingInput,
    url: string,
    adapter: FormPlatformAdapter,
    page: Page,
    details: AutomationDetails
  ): Promise<FormProcessingResult> {
    await page.goto(url, {waitUntil: 'domcontentloaded'});
    let blocker = await adapter.detectBlocker(page);
    if (blocker) return this.blockerResult(page, input.jobId, details, blocker.code, blocker.message);

    const profile = await this.profiles.load();
    const maxPages = this.config.get('formMaxPages', {infer: true});
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const snapshot = await adapter.inspect(page, pageIndex);
      details.pages.push({pageIndex, title: snapshot.title, questions: snapshot.questions.length});
      if (!snapshot.questions.length) {
        return this.manualWithScreenshot(page, input.jobId, details, 'no_questions', 'No supported form questions were visible.');
      }

      const pageIssues: FormIssue[] = [];
      const ordinary = snapshot.questions.filter(question =>
        question.controlKind !== 'file' && question.controlKind !== 'unsupported' && !question.legalDeclaration);
      const generated = await this.answers.generate({
        job: {title: snapshot.title, description: input.text},
        questions: ordinary
      });
      if (generated.resume?.resume) {
        details.resume = {
          id: generated.resume.resume.id,
          fileName: generated.resume.resume.fileName,
          path: generated.resume.resume.path
        };
      }
      const byQuestion = new Map<string, GeneratedAnswer>(generated.answers.map(answer => [answer.questionId, answer]));

      for (const question of snapshot.questions) {
        if (question.controlKind === 'unsupported') {
          pageIssues.push({
            questionId: question.id, label: question.label, code: 'unsupported_field', required: question.required,
            message: 'This form control is not supported by the Google Forms adapter.'
          });
          continue;
        }
        if (question.legalDeclaration) {
          const allowed = profile.verified.automationConsents?.legalDeclarations[this.normalize(question.label)] === true;
          if (!allowed) {
            if (question.required) pageIssues.push({
              questionId: question.id, label: question.label, code: 'legal_consent_required', required: true,
              message: 'A required legal declaration has no explicit consent in profile.json.'
            });
            continue;
          }
          const consentValue = this.consentValue(question);
          try {
            await this.fillWithRetries(adapter, page, question, consentValue);
            details.filled.push({
              questionId: question.id, label: question.label, source: 'configured_consent', confidence: 'high', value: consentValue
            });
          } catch (error) {
            pageIssues.push(this.fillIssue(question, error));
          }
          continue;
        }
        if (question.controlKind === 'file') {
          const selected = this.selectAttachment(question.label, generated.resume?.resume || null, profile);
          if (!selected || (selected.kind === 'resume' && generated.resume.confidence === 'low')) {
            if (question.required) pageIssues.push({
              questionId: question.id, label: question.label, code: 'matching_document_unavailable', required: true,
              message: 'No existing document safely matches this required upload field.'
            });
            continue;
          }
          try {
            if (question.constraints.accept && !this.fileAccepted(selected.document.fileName, question.constraints.accept)) {
              throw new Error(`The selected resume does not satisfy the upload constraint “${question.constraints.accept}”.`);
            }
            const directory = selected.kind === 'resume'
              ? this.config.get('resumeDirectory', {infer: true})
              : this.config.get('applicationDocumentsDirectory', {infer: true});
            const path = await this.documentPath(selected.document.fileName, directory);
            await this.attachFileWithRetries(adapter, page, question, path, selected.document.fileName);
            details.filled.push({
              questionId: question.id, label: question.label,
              source: selected.kind === 'resume' ? 'resume' : 'application_document', confidence: 'high', value: path
            });
            details.attachments.push({
              questionId: question.id, fileName: selected.document.fileName, kind: selected.kind, verified: true
            });
          } catch (error) {
            pageIssues.push(this.fillIssue(question, error));
          }
          continue;
        }

        const answer = byQuestion.get(question.id);
        if (!answer || answer.value === null || answer.confidence === 'low' || answer.provenance.source === 'unresolved') {
          if (question.required) pageIssues.push({
            questionId: question.id, label: question.label, code: 'required_answer_unresolved', required: true,
            message: 'No reliable answer is available for this required field.'
          });
          continue;
        }
        const constraintIssue = this.constraintIssue(question, answer.value);
        if (constraintIssue) {
          if (question.required) pageIssues.push(constraintIssue);
          continue;
        }
        try {
          await this.fillWithRetries(adapter, page, question, answer.value);
          details.filled.push({
            questionId: question.id, label: question.label, source: answer.provenance.source,
            confidence: answer.confidence, value: answer.value
          });
        } catch (error) {
          pageIssues.push(this.fillIssue(question, error));
        }
      }

      const blockingIssues = pageIssues.filter(issue => issue.required);
      details.issues.push(...pageIssues);
      if (blockingIssues.length) {
        return this.manualWithScreenshot(page, input.jobId, details, 'required_fields_unresolved',
          `${blockingIssues.length} required field(s) could not be completed reliably.`);
      }
      const validation = await adapter.validate(page, snapshot.questions);
      details.issues.push(...validation.issues);
      if (!validation.valid) {
        return this.manualWithScreenshot(page, input.jobId, details, 'validation_failed', 'The populated form did not pass validation.');
      }

      const action = await adapter.action(page);
      if (action.kind === 'none') {
        return this.manualWithScreenshot(page, input.jobId, details, 'navigation_control_missing',
          'No supported Next or Submit control was found.');
      }
      if (action.kind === 'next') {
        await adapter.clickAction(page, action);
        try {
          await adapter.waitForNextPage(page, snapshot.signature, this.config.get('formNavigationTimeoutMs', {infer: true}));
        } catch {
          const afterClick = await adapter.validate(page, snapshot.questions);
          details.issues.push(...afterClick.issues);
          return this.manualWithScreenshot(page, input.jobId, details, 'next_page_not_reached',
            'The form did not advance after clicking Next.');
        }
        blocker = await adapter.detectBlocker(page);
        if (blocker) return this.blockerResult(page, input.jobId, details, blocker.code, blocker.message);
        continue;
      }

      if (!this.config.get('formAutoSubmit', {infer: true}) || profile.verified.automationConsents?.automaticSubmission !== true) {
        return this.manualWithScreenshot(page, input.jobId, details, 'automatic_submission_not_consented',
          'Automatic submission is not enabled in both configuration and profile consent.');
      }
      details.submission = {attempted: true};
      await adapter.clickAction(page, action);
      const evidence = await adapter.detectSubmissionSuccess(page, this.config.get('formNavigationTimeoutMs', {infer: true}));
      if (!evidence) {
        const afterSubmit = await adapter.validate(page, snapshot.questions);
        details.issues.push(...afterSubmit.issues);
        return this.manualWithScreenshot(page, input.jobId, details, 'submission_unconfirmed',
          'Submit was clicked, but no reliable submission confirmation was detected.');
      }
      details.submission = {attempted: true, evidence};
      this.logger.log(`Form workflow ${input.jobId} completed with ${evidence.kind}.`);
      return {status: 'completed', details};
    }
    return this.manual(details, 'page_limit_exceeded', `The form exceeded the configured ${maxPages}-page limit.`);
  }

  /**
   * **Summary:** Records an issue that requires a person to finish or review the application.
   * **Inputs:** `details` is the workflow audit trail; `code` and `message` describe the blocking condition.
   * **Returns:** A manual-action processing result.
   */
  private manual(details: AutomationDetails, code: string, message: string): FormProcessingResult {
    details.issues.push({code, message});
    return {status: 'needs_manual_action', details};
  }

  /**
   * **Summary:** Records a manual-action issue and captures the current form page to support human review.
   * **Inputs:** `page` and `jobId` identify the evidence; `details`, `code`, and `message` describe the workflow and issue.
   * **Returns:** A manual-action result containing the screenshot when capture succeeds.
   */
  private async manualWithScreenshot(
    page: Page, jobId: string, details: AutomationDetails, code: string, message: string
  ): Promise<FormProcessingResult> {
    details.issues.push({code, message});
    const screenshot = await this.artifacts.screenshot(page, jobId, code);
    if (screenshot) details.screenshots.push(screenshot);
    return {status: 'needs_manual_action', details};
  }

  /**
   * **Summary:** Converts a field-population failure into a structured issue tied to the affected form question.
   * **Inputs:** `question` identifies the field; `error` describes why it could not be populated.
   * **Returns:** The structured form issue used for audit and manual review.
   */
  private fillIssue(question: ExtractedFormQuestion, error: unknown): FormIssue {
    return {
      questionId: question.id, label: question.label, code: 'field_fill_failed', required: question.required,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  /**
   * **Summary:** Checks an answer against the field's declared length, pattern, and numeric boundaries before entering it.
   * **Inputs:** `question` contains the constraints; `value` is the proposed answer.
   * **Returns:** A constraint-mismatch issue, or `null` when the answer satisfies known limits.
   */
  private constraintIssue(question: ExtractedFormQuestion, value: AnswerValue): FormIssue | null {
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    const {minLength, maxLength, pattern, min, max} = question.constraints;
    let message = '';
    if (minLength !== undefined && text.length < minLength) message = `Answer is shorter than the minimum length of ${minLength}.`;
    if (maxLength !== undefined && text.length > maxLength) message = `Answer is longer than the maximum length of ${maxLength}.`;
    if (pattern) {
      try { if (!new RegExp(`^(?:${pattern})$`).test(text)) message = 'Answer does not match the field pattern.'; } catch { /* browser validates invalid patterns */ }
    }
    const numeric = Number(value);
    if (question.controlKind === 'number' && Number.isFinite(numeric)) {
      if (min !== undefined && numeric < Number(min)) message = `Answer is below the minimum value ${min}.`;
      if (max !== undefined && numeric > Number(max)) message = `Answer is above the maximum value ${max}.`;
    }
    return message ? {
      questionId: question.id, label: question.label, code: 'answer_constraint_mismatch',
      required: question.required, message
    } : null;
  }

  /**
   * **Summary:** Produces an affirmative value for a legal declaration that the profile has explicitly authorized.
   * **Inputs:** `question` describes the declaration's control type and available choices.
   * **Returns:** The compatible consent value to enter into the field.
   */
  private consentValue(question: ExtractedFormQuestion): AnswerValue {
    if (question.controlKind === 'checkbox') return [question.options?.[0] || question.label];
    if (question.controlKind === 'radio' || question.controlKind === 'select') {
      return question.options?.find(option => /^(?:yes|i agree|agree|accept)$/i.test(option.trim())) || question.options?.[0] || 'Yes';
    }
    return 'I agree';
  }

  /**
   * **Summary:** Resolves an approved application document while ensuring it remains inside its configured document directory.
   * **Inputs:** `fileName` identifies the catalogued document; `configuredDirectory` defines its trusted storage boundary.
   * **Returns:** The verified absolute path of the accessible document.
   */
  private async documentPath(fileName: string, configuredDirectory: string): Promise<string> {
    const directory = await realpath(configuredDirectory);
    const candidate = resolve(join(directory, basename(fileName)));
    const resolved = await realpath(candidate);
    const inside = relative(directory, resolved);
    if (inside.startsWith('..') || resolve(directory, inside) !== resolved) throw new Error('Selected document is outside its configured directory.');
    await access(resolved);
    return resolved;
  }

  /**
   * **Summary:** Selects the resume or supporting document whose approved purpose matches an upload question.
   * **Inputs:** `label` describes the upload request; `resume` is the job-matched resume; `profile` contains other approved documents.
   * **Returns:** The selected document and its kind, or `null` when no safe match exists.
   */
  private selectAttachment(
    label: string, resume: ResumeProfile | null, profile: ProfileDocument
  ): {kind: 'resume'; document: ResumeProfile} | {kind: 'application_document'; document: ApplicationDocumentProfile} | null {
    const normalized = this.normalize(label);
    if (/\b(?:resume|cv|curriculum vitae)\b/i.test(label)) {
      return resume ? {kind: 'resume', document: resume} : null;
    }
    const document = (profile.documentCatalog || []).find(item =>
      item.labels.some(alias => normalized.includes(this.normalize(alias))));
    return document ? {kind: 'application_document', document} : null;
  }

  /**
   * **Summary:** Retries transient field interactions while preserving the same approved answer and bounded attempt count.
   * **Inputs:** `adapter` and `page` operate the form; `question` identifies the field; `value` is the answer to enter.
   * **Returns:** A promise that resolves after the field is populated or rejects with the final failure.
   */
  private async fillWithRetries(
    adapter: FormPlatformAdapter, page: Page, question: ExtractedFormQuestion, value: AnswerValue | string
  ): Promise<void> {
    const attempts = this.config.get('formMaxRetries', {infer: true}) + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await adapter.fill(page, question, value);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await page.waitForTimeout(150 * attempt);
      }
    }
    throw lastError;
  }

  /**
   * **Summary:** Retries a document upload and requires positive attachment verification before treating the field as complete.
   * **Inputs:** `adapter`, `page`, and `question` identify the upload control; `path` and `fileName` identify the approved document.
   * **Returns:** A promise that resolves after verified attachment or rejects with the final failure.
   */
  private async attachFileWithRetries(
    adapter: FormPlatformAdapter, page: Page, question: ExtractedFormQuestion, path: string, fileName: string
  ): Promise<void> {
    const attempts = this.config.get('formMaxRetries', {infer: true}) + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await adapter.fill(page, question, path);
        const verified = await adapter.verifyFileAttachment(
          page, question, fileName, this.config.get('formNavigationTimeoutMs', {infer: true})
        );
        if (!verified) throw new Error(`The form did not confirm attachment of ${fileName}.`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await page.waitForTimeout(250 * attempt);
      }
    }
    throw lastError;
  }

  /**
   * **Summary:** Converts an external form blocker into a manual-action result with authentication context and screenshot evidence.
   * **Inputs:** `page` and `jobId` identify the form; `details` stores the audit; `code` and `message` classify the blocker.
   * **Returns:** The manual-action result appropriate to the detected blocker.
   */
  private async blockerResult(
    page: Page, jobId: string, details: AutomationDetails,
    code: 'captcha' | 'authentication_required' | 'form_closed' | 'access_denied', message: string
  ): Promise<FormProcessingResult> {
    if (code === 'authentication_required') {
      const state = await this.authenticationStates.status();
      details.authentication = {state: state.status, updatedAt: state.updatedAt};
      const authenticationCode = state.status === 'available' || state.status === 'expired'
        ? 'reauthentication_required' : 'authentication_required';
      const authenticationMessage = state.status === 'available' || state.status === 'expired'
        ? 'The saved authentication session is expired or no longer accepted. Reauthenticate through the local auth endpoint.'
        : `${message} Create a local authenticated session through the auth endpoint.`;
      return this.manualWithScreenshot(page, jobId, details, authenticationCode, authenticationMessage);
    }
    return this.manualWithScreenshot(page, jobId, details, code, message);
  }

  /**
   * **Summary:** Determines whether a selected document satisfies the upload field's accepted extension or media type.
   * **Inputs:** `fileName` identifies the document format; `accept` contains the form's allowed formats.
   * **Returns:** `true` when the document is accepted, otherwise `false`.
   */
  private fileAccepted(fileName: string, accept: string): boolean {
    const extension = `.${fileName.split('.').pop()?.toLowerCase() || ''}`;
    return accept.split(',').map(value => value.trim().toLowerCase()).some(value =>
      value === extension || (value === 'application/pdf' && extension === '.pdf') || value === '*/*');
  }

  /**
   * **Summary:** Adds browser and request failures to the workflow audit so incomplete automation can be diagnosed safely.
   * **Inputs:** `page` is the active browser page; `details` receives relevant browser errors.
   * **Returns:** No value; event reporting remains active for the page lifetime.
   */
  private recordBrowserErrors(page: Page, details: AutomationDetails): void {
    page.on('pageerror', error => details.browserErrors.push(`page: ${error.message}`));
    page.on('requestfailed', request => {
      const failure = request.failure();
      if (failure && !/ERR_ABORTED/i.test(failure.errorText)) {
        details.browserErrors.push(`request: ${new URL(request.url()).hostname}: ${failure.errorText}`);
      }
    });
  }

  /**
   * **Summary:** Normalizes human-written document and question labels for reliable matching across formatting differences.
   * **Inputs:** `value` is the label text to normalize.
   * **Returns:** The normalized comparison text.
   */
  private normalize(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
}
