import {ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHash, randomUUID} from 'node:crypto';
import {ClassificationService} from '../classification/classification.service';
import {BatchItemRecord, DatabaseService, ProcessingStage, WorkflowRecord, WorkflowType} from '../database/database.service';
import {AppConfiguration} from '../config/app.config';
import {IdentityService} from '../identity/identity.service';
import {FORM_PROCESSOR, FormProcessor} from '../forms/form-processor.interface';
import {N8nService} from '../n8n/n8n.service';
import {GoogleSheetsService} from '../sheets/google-sheets.service';
import {UrlService} from '../url/url.service';
import {ProcessJobDto} from './dto/process-job.dto';
import {ApplicationListQueryDto, CreateBatchDto, EventsQueryDto, PageQueryDto, WorkflowCallbackDto} from './dto/jobs-dashboard.dto';

export interface WorkflowResult {
  id: string;
  status: WorkflowRecord['status'];
  duplicate: boolean;
  response?: unknown;
  error?: string | null;
  outcome: string;
}

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private queueTimer: NodeJS.Timeout | null = null;
  private activeBatchWorkers = 0;
  private workflowActive: Record<WorkflowType, number> = {email: 0, form: 0};
  private workflowWaiters: Record<WorkflowType, Array<() => void>> = {email: [], form: []};

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
    private readonly sheets: GoogleSheetsService,
    private readonly config: ConfigService<AppConfiguration, true>
  ) {}

  onModuleInit(): void {
    this.database.recoverInterruptedWork();
    this.queueTimer = setInterval(() => void this.drainQueue(), this.setting('queuePollIntervalMs', 1000));
    this.queueTimer.unref();
    void this.drainQueue();
  }

  onModuleDestroy(): void {
    if (this.queueTimer) clearInterval(this.queueTimer);
  }

  /**
   * **Summary:** Normalizes a captured job, classifies its application channels, stores it once, and executes each new delivery workflow.
   * **Inputs:** `input` contains the captured job-post text, source URL, links, and timestamp.
   * **Returns:** The stable application identity, duplicate status, classification, destinations, and workflow results.
   */
  async process(input: ProcessJobDto, options: {batchId?: string; targetWorkflowType?: WorkflowType | null; queueItemId?: string} = {}) {
    this.database.recordEvent({batchId: options.batchId, stage: 'classifying', status: 'processing',
      message: 'Normalizing and classifying application destinations.'});
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
    this.database.recordEvent({batchId: options.batchId, applicationId: identity.applicationId,
      stage: 'classifying', status: 'completed', message: `Classified as ${classification.method}.`});

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
      created.has('email') && (!options.targetWorkflowType || options.targetWorkflowType === 'email')
        ? this.withWorkflowLimit('email', () => this.runEmail(created.get('email')!, payload, options.batchId))
        : Promise.resolve(null),
      created.has('form') && (!options.targetWorkflowType || options.targetWorkflowType === 'form')
        ? this.withWorkflowLimit('form', () => this.runForm(
          created.get('form')!, identity.applicationId, classification.formUrls, payload.text, options.batchId))
        : Promise.resolve(null)
    ]);
    const workflowResults = [email, form].filter((result): result is WorkflowResult => result !== null);
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
      workflows: {email, form}
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

  dashboard() { return this.database.dashboard(); }

  listApplications(query: ApplicationListQueryDto) { return this.database.listApplications(query); }

  listBatches(query: PageQueryDto) { return this.database.listBatches(query.page, query.pageSize); }

  getBatch(batchId: string) {
    const batch = this.database.getBatch(batchId);
    if (!batch) throw new NotFoundException('Batch not found.');
    return batch;
  }

  events(query: EventsQueryDto) { return this.database.listEvents(query); }

  failures() { return this.database.getFailures(); }

  health() { return {status: 'ok', database: 'sqlite', queue: 'running', timestamp: new Date().toISOString()}; }

  async importGoogleSheets() {
    const rows = await this.sheets.readLegacyApplications();
    let imported = 0;
    let duplicates = 0;
    for (const row of rows) {
      const text = [row.role, row.company, row.location, row.notes].filter(Boolean).join('\n') || 'Legacy tracker application';
      const links = await this.urls.normalizeAndResolve([row.applicationUrl].filter(Boolean));
      const sourceUrl = this.urls.normalize(row.sourceUrl || '') || null;
      const identity = this.identity.create(sourceUrl, text, links);
      const channel = row.channel.toLowerCase();
      const method = channel.includes('email') && channel.includes('form') ? 'email_and_form'
        : channel.includes('email') ? 'email' : channel.includes('form') ? 'form' : 'needs_review';
      const created = this.database.insertApplication({
        id: identity.applicationId, sourceUrl, contentHash: identity.contentHash, method,
        payload: {text, url: sourceUrl || '', links, capturedAt: this.legacyDate(row.dateFound)},
        emails: [], forms: row.applicationUrl ? [row.applicationUrl] : [], company: row.company || null,
        role: row.role || null, location: row.location || null, description: text
      });
      if (!created) { duplicates += 1; continue; }
      imported += 1;
      const types: WorkflowType[] = method === 'email_and_form' ? ['email', 'form']
        : method === 'email' || method === 'form' ? [method] : [];
      for (const type of types) {
        const workflowId = this.identity.workflowId(identity.applicationId, type);
        this.database.insertWorkflow(workflowId, identity.applicationId, type);
        const completed = /draft|submitted|applied|complete/i.test(row.status);
        this.database.updateWorkflow(workflowId, completed ? 'completed' : 'needs_manual_action', {
          importedFrom: 'google_sheets', legacyStatus: row.status, notes: row.notes
        });
      }
    }
    return {source: 'google_sheets', totalRows: rows.length, imported, duplicates};
  }

  createBatch(input: CreateBatchDto) {
    const idempotencyKey = input.idempotencyKey || this.hash(JSON.stringify(input.entries));
    const batchId = `batch_${randomUUID()}`;
    const maximum = this.setting('batchConcurrency', 3);
    const result = this.database.createBatch({
      id: batchId, idempotencyKey, concurrency: Math.min(input.concurrency || maximum, maximum),
      items: input.entries.map((entry, position) => ({id: `${batchId}:${position}`, position, input: entry}))
    });
    void this.drainQueue();
    return {...result.batch, duplicate: !result.created};
  }

  retryWorkflow(workflowId: string, requestedKey?: string) {
    const workflow = this.database.getWorkflow(workflowId);
    const application = this.database.getApplication(workflow.applicationId);
    if (!application) throw new NotFoundException('Application not found.');
    const decision = this.retryDecision(workflow);
    if (!decision.eligible) throw new ConflictException(decision.reason);
    const delayMs = Math.min(30_000, 1000 * 2 ** Math.max(0, workflow.attempts - 1));
    const batchId = `batch_${randomUUID()}`;
    const result = this.database.createBatch({
      id: batchId, idempotencyKey: requestedKey || `retry:${workflowId}:${workflow.attempts + 1}`, concurrency: 1,
      items: [{id: `${batchId}:0`, position: 0, input: application.payload,
        targetWorkflowType: workflow.type, retryOfWorkflowId: workflow.id,
        availableAt: new Date(Date.now() + delayMs).toISOString()}]
    });
    void this.drainQueue();
    return {...result.batch, duplicate: !result.created, retryAfterMs: result.created ? delayMs : 0};
  }

  retryBatch(batchId: string) {
    const batch = this.getBatch(batchId);
    const candidates = new Map<string, {input: ProcessJobDto; type: WorkflowType; workflowId: string}>();
    for (const item of batch.items) {
      if (!item.applicationId) continue;
      const application = this.database.getApplication(item.applicationId);
      if (!application) continue;
      for (const workflow of application.workflows) {
        if (this.retryDecision(workflow).eligible) candidates.set(workflow.id, {
          input: application.payload as ProcessJobDto, type: workflow.type, workflowId: workflow.id
        });
      }
    }
    if (!candidates.size) throw new ConflictException('This batch has no workflows that can be retried safely.');
    const retryBatchId = `batch_${randomUUID()}`;
    const result = this.database.createBatch({
      id: retryBatchId, idempotencyKey: `batch-retry:${batchId}:${new Date().toISOString()}`,
      concurrency: Math.min(batch.concurrency, this.setting('batchConcurrency', 3)),
      items: [...candidates.values()].map((item, position) => ({id: `${retryBatchId}:${position}`,
        position, input: item.input, targetWorkflowType: item.type, retryOfWorkflowId: item.workflowId}))
    });
    void this.drainQueue();
    return result.batch;
  }

  workflowCallback(workflowId: string, input: WorkflowCallbackDto) {
    const workflow = this.database.getWorkflow(workflowId);
    if (workflow.status === 'completed') return workflow;
    const attempt = this.database.beginWorkflowAttempt(workflowId, input.idempotencyKey, {source: 'n8n_callback'});
    const status = input.status === 'completed' ? 'completed' : 'failed';
    this.database.updateWorkflow(workflowId, status, input.response, input.error);
    this.database.finishWorkflowAttempt(attempt, status, status, input.response, input.error);
    return this.database.getWorkflow(workflowId);
  }

  /**
   * **Summary:** Runs a new or previously failed email-application workflow through n8n and records its durable outcome.
   * **Inputs:** `run` identifies whether the workflow is new; `payload` contains the normalized captured job.
   * **Returns:** The email workflow result, reusing completed or active outcomes for duplicate requests.
   */
  private async runEmail(run: {id: string; created: boolean}, payload: ProcessJobDto, batchId?: string): Promise<WorkflowResult> {
    if (run.created) {
      this.database.updateWorkflow(run.id, 'processing');
    } else {
      const existing = this.database.getWorkflow(run.id);
      if (existing.status !== 'failed') return this.existingResult(run.id);
      if (existing.attempts >= this.setting('workflowRetryLimit', 3)) return this.existingResult(run.id);
      if (!this.database.claimWorkflowRetry(run.id, 'failed')) return this.existingResult(run.id);
    }
    this.database.updateWorkflowStage(run.id, 'processing', 'Requesting Gmail draft creation from n8n.', batchId);
    const workflow = this.database.getWorkflow(run.id);
    const attempt = this.database.beginWorkflowAttempt(run.id, `${run.id}:${workflow.attempts}`, payload, batchId);
    try {
      const response = await this.n8n.forward(payload, {workflowId: run.id, idempotencyKey: `${run.id}:${workflow.attempts}`});
      this.database.updateWorkflow(run.id, 'completed', response);
      this.updateMetadataFromN8n(this.database.getWorkflow(run.id).applicationId, response);
      this.database.finishWorkflowAttempt(attempt, 'completed', 'completed', response);
      this.database.recordEvent({batchId, applicationId: workflow.applicationId, workflowId: run.id,
        stage: 'completed', status: 'completed', message: 'Gmail draft workflow completed.'});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.updateWorkflow(run.id, 'failed', undefined, message);
      this.database.finishWorkflowAttempt(attempt, 'failed', 'failed', undefined, message, this.isTransient(error));
      this.database.recordEvent({batchId, applicationId: workflow.applicationId, workflowId: run.id,
        stage: 'failed', status: 'failed', message});
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
    run: {id: string; created: boolean}, applicationId: string, formUrls: string[], text: string, batchId?: string
  ): Promise<WorkflowResult> {
    if (run.created) {
      this.database.updateWorkflow(run.id, 'processing');
    } else {
      const existing = this.database.getWorkflow(run.id);
      if (!this.canRetryForm(existing)) return this.existingResult(run.id);
      if (existing.attempts >= this.setting('workflowRetryLimit', 3)) return this.existingResult(run.id);
      if (!this.database.claimWorkflowRetry(run.id, existing.status)) return this.existingResult(run.id);
    }
    const workflow = this.database.getWorkflow(run.id);
    const request = {applicationId, formUrls, text};
    const attempt = this.database.beginWorkflowAttempt(run.id, `${run.id}:${workflow.attempts}`, request, batchId);
    try {
      const result = await this.forms.process({jobId: run.id, applicationId, formUrls, text}, (stage, message, data) =>
        this.database.updateWorkflowStage(run.id, stage as ProcessingStage, message, batchId, data));
      this.database.recordFormOutcome(run.id, result.status, result.details);
      this.updateMetadataFromForm(applicationId, result.details);
      const stage = result.status as ProcessingStage;
      this.database.finishWorkflowAttempt(attempt, result.status, stage, result.details);
      this.database.recordEvent({batchId, applicationId, workflowId: run.id, stage, status: result.status,
        message: `Form workflow finished with ${result.status}.`});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.recordFormOutcome(run.id, 'failed', undefined, message);
      this.database.finishWorkflowAttempt(attempt, 'failed', 'failed', undefined, message, this.isTransient(error));
      this.database.recordEvent({batchId, applicationId, workflowId: run.id, stage: 'failed', status: 'failed', message});
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

  private async drainQueue(): Promise<void> {
    const maximum = this.setting('batchConcurrency', 3);
    while (this.activeBatchWorkers < maximum) {
      const item = this.database.claimNextBatchItem(`worker-${process.pid}-${this.activeBatchWorkers + 1}`,
        this.setting('queueLeaseMs', 300000));
      if (!item) return;
      this.activeBatchWorkers += 1;
      void this.runBatchItem(item).finally(() => {
        this.activeBatchWorkers -= 1;
        void this.drainQueue();
      });
    }
  }

  private async runBatchItem(item: BatchItemRecord): Promise<void> {
    try {
      const result = await this.process(item.input as ProcessJobDto, {
        batchId: item.batchId, queueItemId: item.id, targetWorkflowType: item.targetWorkflowType
      });
      const failed = [result.workflows.email, result.workflows.form]
        .filter((workflow): workflow is WorkflowResult => workflow !== null)
        .find(workflow => workflow.status === 'failed');
      if (failed) this.database.failBatchItem(item.id, failed.error || `${failed.id} failed.`, result.applicationId, result);
      else this.database.completeBatchItem(item.id, result.applicationId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.failBatchItem(item.id, message);
      this.database.recordEvent({batchId: item.batchId, stage: 'failed', status: 'failed', message});
      this.logger.error(`Batch item ${item.id} failed: ${message}`);
    }
  }

  private async withWorkflowLimit<T>(type: WorkflowType, task: () => Promise<T>): Promise<T> {
    const limit = type === 'email'
      ? this.setting('emailWorkflowConcurrency', 3)
      : this.setting('formWorkflowConcurrency', 1);
    if (this.workflowActive[type] >= limit) await new Promise<void>(resolve => this.workflowWaiters[type].push(resolve));
    this.workflowActive[type] += 1;
    try {
      return await task();
    } finally {
      this.workflowActive[type] -= 1;
      this.workflowWaiters[type].shift()?.();
    }
  }

  private retryDecision(workflow: WorkflowRecord): {eligible: boolean; reason: string} {
    if (workflow.attempts >= this.setting('workflowRetryLimit', 3)) {
      return {eligible: false, reason: `Retry limit of ${this.setting('workflowRetryLimit', 3)} attempts reached.`};
    }
    if (workflow.status === 'completed') return {eligible: false, reason: 'Successful workflows are never retried.'};
    if (workflow.status === 'processing' || workflow.status === 'pending') {
      return {eligible: false, reason: 'The workflow is already queued or processing.'};
    }
    if (workflow.status === 'submission_unknown') {
      return {eligible: false, reason: 'Submission outcome is uncertain; retrying could create a duplicate application.'};
    }
    if (workflow.type === 'email' && workflow.status === 'needs_manual_action') {
      return {eligible: false, reason: 'A Gmail draft may already exist. Verify Gmail before taking any manual action.'};
    }
    if (workflow.type === 'form' && !this.canRetryForm(workflow)) {
      return {eligible: false, reason: 'Form submission may already have started; retry is blocked.'};
    }
    return {eligible: workflow.status === 'failed' || workflow.status === 'needs_manual_action',
      reason: 'This workflow can be retried safely.'};
  }

  private isTransient(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|temporar|unavailable|ECONN|fetch failed|HTTP 5\d\d/i.test(message);
  }

  private setting<K extends keyof AppConfiguration>(key: K, fallback: number): number {
    const value = this.config?.get(key, {infer: true});
    return typeof value === 'number' && value > 0 ? value : fallback;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private legacyDate(value: string): string {
    if (value) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date().toISOString();
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
