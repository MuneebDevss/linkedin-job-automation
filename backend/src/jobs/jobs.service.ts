import {Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {ClassificationService} from '../classification/classification.service';
import {DatabaseService, WorkflowRecord, WorkflowType} from '../database/database.service';
import {IdentityService} from '../identity/identity.service';
import {FORM_PROCESSOR, FormProcessor} from '../forms/form-processor.interface';
import {N8nService} from '../n8n/n8n.service';
import {UrlService} from '../url/url.service';
import {ProcessJobDto} from './dto/process-job.dto';
import {GoogleSheetsService} from '../sheets/google-sheets.service';

export interface WorkflowResult {
  id: string;
  status: WorkflowRecord['status'];
  duplicate: boolean;
  response?: unknown;
  error?: string | null;
  outcome: string;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  /**
   * **Summary:** Creates the job coordinator with URL, classification, identity, storage, email, and form workflow services.
   * **Inputs:** The injected services normalize captures, classify channels, preserve idempotency, and execute application delivery.
   * **Returns:** A jobs service instance ready to process captured opportunities.
   */
  constructor(
    private readonly urls: UrlService,
    private readonly classifier: ClassificationService,
    private readonly identity: IdentityService,
    private readonly database: DatabaseService,
    private readonly n8n: N8nService,
    @Inject(FORM_PROCESSOR) private readonly forms: FormProcessor,
    private readonly sheets: GoogleSheetsService
  ) {}

  /**
   * **Summary:** Normalizes a captured job, classifies its application channels, stores it once, and executes each new delivery workflow.
   * **Inputs:** `input` contains the captured job-post text, source URL, links, and timestamp.
   * **Returns:** The stable application identity, duplicate status, classification, destinations, and workflow results.
   */
  async process(input: ProcessJobDto) {
    const rawLinks = [...(input.links || []), ...this.urls.extractTextUrls(input.text)];
    const links = await this.urls.normalizeAndResolve(rawLinks);
    const sourceUrl = this.urls.normalize(input.url || '') || null;
    const classification = this.classifier.classify(input.text, links);
    const identity = this.identity.create(sourceUrl, input.text, links);
    const payload: ProcessJobDto = {
      text: input.text.trim(),
      url: sourceUrl || input.url || '',
      links,
      capturedAt: input.capturedAt
    };
    const metadata = this.extractMetadata(input);

    const applicationCreated = this.database.insertApplication({
      id: identity.applicationId,
      sourceUrl,
      contentHash: identity.contentHash,
      method: classification.method,
      payload,
      emails: classification.emails,
      forms: classification.formUrls,
      company: metadata.company,
      role: metadata.role,
      location: metadata.location,
      description: payload.text
    });

    const created = new Map<WorkflowType, {id: string; created: boolean}>();
    if (classification.method === 'email' || classification.method === 'email_and_form') {
      const id = this.identity.workflowId(identity.applicationId, 'email');
      created.set('email', {id, created: this.database.insertWorkflow(id, identity.applicationId, 'email')});
    }
    if (classification.method === 'form' || classification.method === 'email_and_form') {
      const id = this.identity.workflowId(identity.applicationId, 'form');
      created.set('form', {id, created: this.database.insertWorkflow(id, identity.applicationId, 'form')});
    }

    const [email, form] = await Promise.all([
      created.has('email') ? this.runEmail(created.get('email')!, payload) : Promise.resolve(null),
      created.has('form')
        ? this.runForm(created.get('form')!, identity.applicationId, classification.formUrls, payload.text)
        : Promise.resolve(null)
    ]);
    const workflowResults = [email, form].filter((result): result is WorkflowResult => result !== null);
    const sheetsSync = created.has('form') ? await this.synchronizeSheets(identity.applicationId) : null;
    const duplicate = workflowResults.length > 0 &&
      workflowResults.every(result => result.status === 'completed' && result.duplicate);
    this.logger.log(`Processed ${identity.applicationId}: method=${classification.method}, new=${applicationCreated}.`);

    return {
      applicationId: identity.applicationId,
      applicationIdSource: identity.source,
      duplicate,
      method: classification.method,
      emails: classification.emails,
      formUrls: classification.formUrls,
      links,
      workflows: {email, form},
      sheetsSync
    };
  }

  /**
   * **Summary:** Retrieves a processed application and its workflow history for status reporting.
   * **Inputs:** `applicationId` identifies the stored application.
   * **Returns:** The application summary and workflows; unknown IDs cause a not-found error.
   */
  get(applicationId: string) {
    const result = this.database.getApplication(applicationId);
    if (!result) throw new NotFoundException('Application not found.');
    return result;
  }

  /** Retries tracker synchronization without executing an email or form workflow. */
  async retrySheetSync(applicationId: string) {
    if (!this.database.getApplication(applicationId)) throw new NotFoundException('Application not found.');
    if (!this.sheets.isEnabled()) {
      throw new ServiceUnavailableException('Google Sheets synchronization is not enabled.');
    }
    this.database.requestSheetSync(applicationId);
    await this.synchronizeSheets(applicationId);
    return this.database.getApplication(applicationId)!.sheetsSync;
  }

  /**
   * **Summary:** Runs a new or previously failed email-application workflow through n8n and records its durable outcome.
   * **Inputs:** `run` identifies whether the workflow is new; `payload` contains the normalized captured job.
   * **Returns:** The email workflow result, reusing completed or active outcomes for duplicate requests.
   */
  private async runEmail(run: {id: string; created: boolean}, payload: ProcessJobDto): Promise<WorkflowResult> {
    if (run.created) {
      this.database.updateWorkflow(run.id, 'processing');
    } else {
      const existing = this.database.getWorkflow(run.id);
      if (existing.status !== 'failed') return this.existingResult(run.id);
      if (!this.database.claimWorkflowRetry(run.id, 'failed')) return this.existingResult(run.id);
    }
    try {
      const response = await this.n8n.forward(payload);
      this.database.updateWorkflow(run.id, 'completed', response);
      this.updateMetadataFromN8n(this.database.getWorkflow(run.id).applicationId, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.updateWorkflow(run.id, 'failed', undefined, message);
      this.logger.error(`Email workflow ${run.id} failed: ${message}`);
    }
    return this.recordResult(this.database.getWorkflow(run.id), false);
  }

  /**
   * **Summary:** Runs a newly created form-application workflow and records whether it completed, failed, or needs manual action.
   * **Inputs:** `run` identifies the workflow; `applicationId`, `formUrls`, and `text` provide its form-processing context.
   * **Returns:** The form workflow result, reusing the stored result for duplicate requests.
   */
  private async runForm(
    run: {id: string; created: boolean}, applicationId: string, formUrls: string[], text: string
  ): Promise<WorkflowResult> {
    if (run.created) {
      this.database.updateWorkflow(run.id, 'processing');
    } else {
      const existing = this.database.getWorkflow(run.id);
      if (!this.canRetryForm(existing)) return this.existingResult(run.id);
      if (!this.database.claimWorkflowRetry(run.id, existing.status)) return this.existingResult(run.id);
    }
    try {
      const result = await this.forms.process({jobId: run.id, applicationId, formUrls, text});
      this.database.recordFormOutcome(run.id, result.status, result.details);
      this.updateMetadataFromForm(applicationId, result.details);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.recordFormOutcome(run.id, 'failed', undefined, message);
      this.logger.error(`Form workflow ${run.id} failed: ${message}`);
    }
    return this.recordResult(this.database.getWorkflow(run.id), false);
  }

  /**
   * **Summary:** Returns the durable outcome of an already-created workflow without executing it again.
   * **Inputs:** `id` identifies the existing workflow.
   * **Returns:** The stored workflow result marked as a duplicate request.
   */
  private existingResult(id: string): WorkflowResult {
    const record = this.database.getWorkflow(id);
    return this.recordResult(record, record.status === 'completed');
  }

  /**
   * **Summary:** Determines whether a terminal form outcome can be run again without risking a duplicate submission.
   * **Inputs:** `record` is the existing durable form-workflow outcome.
   * **Returns:** `true` for failed or manual-action outcomes where submission never started, otherwise `false`.
   */
  private canRetryForm(record: WorkflowRecord): record is WorkflowRecord & {
    status: 'failed' | 'needs_manual_action';
  } {
    if (record.status !== 'failed' && record.status !== 'needs_manual_action') return false;
    const response = record.response as {submission?: {attempted?: unknown}} | null;
    return response?.submission?.attempted !== true;
  }

  private async synchronizeSheets(applicationId: string) {
    if (!this.sheets.isEnabled()) return this.database.getApplication(applicationId)?.sheetsSync || null;
    this.database.ensureSheetSync(applicationId);
    if (!this.database.claimSheetSync(applicationId)) return this.database.getApplication(applicationId)?.sheetsSync || null;
    try {
      const application = this.database.getApplication(applicationId);
      if (!application) throw new Error('Application disappeared before Sheets synchronization.');
      const result = await this.sheets.sync(application);
      this.database.completeSheetSync(applicationId, result.rowNumber, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.failSheetSync(applicationId, message);
      this.logger.error(`Google Sheets synchronization failed for ${applicationId}: ${message}`);
    }
    return this.database.getApplication(applicationId)?.sheetsSync || null;
  }

  private extractMetadata(input: ProcessJobDto): {company: string | null; role: string | null; location: string | null} {
    const lines = input.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const roleLine = lines[0] && lines[0].length <= 200 &&
      /(?:developer|engineer|designer|manager|analyst|specialist|architect|consultant|intern|officer|executive)/i.test(lines[0])
      ? lines[0].replace(/\s*\([^)]*(?:candidate|only|location)[^)]*\)\s*/gi, ' ').replace(/\s+/g, ' ').trim()
      : null;
    const companyMatch = /(?:^|[,.!?]\s+)([A-Z][A-Za-z0-9&.' -]{1,80}?)\s+(?:is\s+)?(?:looking|hiring|seeking|requires)\b/m.exec(input.text);
    const locationMatch = /\b(?:location|based in)\s*[:\-]?\s*([^\n.!?]{2,100})/i.exec(input.text);
    const parentheticalLocation = /\(([^)]*(?:candidate|location)[^)]*)\)/i.exec(lines[0] || '');
    return {
      company: input.company || companyMatch?.[1]?.trim() || null,
      role: input.role || roleLine,
      location: input.location || locationMatch?.[1]?.trim() ||
        parentheticalLocation?.[1]?.replace(/\b(?:only|candidates?|location)\b/gi, '').replace(/\s+/g, ' ').trim() || null
    };
  }

  private updateMetadataFromN8n(applicationId: string, response: unknown): void {
    if (!response || typeof response !== 'object') return;
    const value = Array.isArray(response) ? response[0] : response;
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    this.database.updateApplicationMetadata(applicationId, {
      company: typeof record.company === 'string' ? record.company : null,
      role: typeof record.roleCandidate === 'string' ? record.roleCandidate : null,
      location: typeof record.location === 'string' ? record.location : null,
      selectedResume: this.resumeName(record.selectedResume)
    });
  }

  private updateMetadataFromForm(applicationId: string, details: unknown): void {
    if (!details || typeof details !== 'object') return;
    const value = details as {url?: unknown; pages?: Array<{title?: unknown}>; resume?: {fileName?: unknown}};
    const title = value.pages?.find(page => typeof page.title === 'string' && page.title.trim())?.title;
    this.database.updateApplicationMetadata(applicationId, {
      role: typeof title === 'string' ? title.trim() : null,
      applicationUrl: typeof value.url === 'string' ? value.url : null,
      selectedResume: typeof value.resume?.fileName === 'string' ? value.resume.fileName : null
    });
  }

  private resumeName(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const fileName = (value as {fileName?: unknown}).fileName;
    return typeof fileName === 'string' ? fileName : null;
  }

  /**
   * **Summary:** Converts a stored workflow record into the result shape returned by job processing.
   * **Inputs:** `record` contains durable workflow state; `duplicate` indicates whether this request reused it.
   * **Returns:** The normalized workflow result.
   */
  private recordResult(record: WorkflowRecord, duplicate: boolean): WorkflowResult {
    return {
      id: record.id, status: record.status, outcome: record.outcome,
      duplicate, response: record.response, error: record.error
    };
  }
}
