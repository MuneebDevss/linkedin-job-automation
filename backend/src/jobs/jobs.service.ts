import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import {ClassificationService} from '../classification/classification.service';
import {DatabaseService, WorkflowRecord, WorkflowType} from '../database/database.service';
import {IdentityService} from '../identity/identity.service';
import {N8nService} from '../n8n/n8n.service';
import {UrlService} from '../url/url.service';
import {ProcessJobDto} from './dto/process-job.dto';

export interface WorkflowResult {
  id: string;
  status: WorkflowRecord['status'];
  duplicate: boolean;
  response?: unknown;
  error?: string | null;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly urls: UrlService,
    private readonly classifier: ClassificationService,
    private readonly identity: IdentityService,
    private readonly database: DatabaseService,
    private readonly n8n: N8nService
  ) {}

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

    const applicationCreated = this.database.insertApplication({
      id: identity.applicationId,
      sourceUrl,
      contentHash: identity.contentHash,
      method: classification.method,
      payload,
      emails: classification.emails,
      forms: classification.formUrls
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

    const email = created.has('email') ? await this.runEmail(created.get('email')!, payload) : null;
    const form = created.has('form') ? this.formResult(created.get('form')!) : null;
    this.logger.log(`Processed ${identity.applicationId}: method=${classification.method}, new=${applicationCreated}.`);

    return {
      applicationId: identity.applicationId,
      applicationIdSource: identity.source,
      duplicate: !applicationCreated,
      method: classification.method,
      emails: classification.emails,
      formUrls: classification.formUrls,
      links,
      workflows: {email, form}
    };
  }

  get(applicationId: string) {
    const result = this.database.getApplication(applicationId);
    if (!result) throw new NotFoundException('Application not found.');
    return result;
  }

  private async runEmail(run: {id: string; created: boolean}, payload: ProcessJobDto): Promise<WorkflowResult> {
    if (!run.created) return this.existingResult(run.id);
    this.database.updateWorkflow(run.id, 'processing');
    try {
      const response = await this.n8n.forward(payload);
      this.database.updateWorkflow(run.id, 'completed', response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.updateWorkflow(run.id, 'failed', undefined, message);
      this.logger.error(`Email workflow ${run.id} failed: ${message}`);
    }
    return this.recordResult(this.database.getWorkflow(run.id), false);
  }

  private formResult(run: {id: string; created: boolean}): WorkflowResult {
    return this.recordResult(this.database.getWorkflow(run.id), !run.created);
  }

  private existingResult(id: string): WorkflowResult {
    return this.recordResult(this.database.getWorkflow(id), true);
  }

  private recordResult(record: WorkflowRecord, duplicate: boolean): WorkflowResult {
    return {id: record.id, status: record.status, duplicate, response: record.response, error: record.error};
  }
}
