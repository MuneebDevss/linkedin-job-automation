import {Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseSync, StatementSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {AppConfiguration} from '../config/app.config';

export type WorkflowType = 'email' | 'form';
export type WorkflowStatus =
  'pending' | 'processing' | 'completed' | 'needs_manual_action' | 'failed' | 'submission_unknown';
export type ProcessingStage =
  'queued' | 'processing' | 'classifying' | 'generating_answers' | 'filling_form' | 'uploading_resume' |
  'submitting_form' | 'verifying_submission' | 'completed' | 'failed' | 'needs_manual_action' | 'submission_unknown';
export type BatchItemStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type SheetSyncStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type StoredAnswerSource = 'profile' | 'derived' | 'approved_memory' | 'gemini' | 'attachment' | 'consent';

export interface WorkflowRecord {
  id: string;
  applicationId: string;
  type: WorkflowType;
  status: WorkflowStatus;
  attempts: number;
  response: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  outcome: string;
  stage: ProcessingStage;
}

export interface WorkflowAttemptRecord {
  id: number;
  workflowId: string;
  attemptNumber: number;
  idempotencyKey: string;
  status: WorkflowStatus;
  stage: ProcessingStage;
  request: unknown;
  response: unknown;
  error: string | null;
  transient: boolean;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface ProcessingEventRecord {
  id: number;
  batchId: string | null;
  applicationId: string | null;
  workflowId: string | null;
  stage: ProcessingStage;
  status: string;
  message: string | null;
  data: unknown;
  createdAt: string;
}

export interface BatchItemRecord {
  id: string;
  batchId: string;
  position: number;
  input: unknown;
  applicationId: string | null;
  targetWorkflowType: WorkflowType | null;
  retryOfWorkflowId: string | null;
  status: BatchItemStatus;
  attempts: number;
  result: unknown;
  error: string | null;
  availableAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRecord {
  id: string;
  idempotencyKey: string;
  status: 'queued' | 'processing' | 'completed' | 'completed_with_errors';
  concurrency: number;
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  items: BatchItemRecord[];
}

export interface FormQuestionRecord {
  workflowId: string;
  questionId: string;
  pageIndex: number | null;
  label: string;
  fieldType: string | null;
  required: boolean | null;
  answer: unknown;
  answerSource: StoredAnswerSource | null;
  confidence: string | null;
  outcome: string;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface FormSubmissionAttemptRecord {
  id: number;
  workflowId: string;
  attemptNumber: number;
  attempted: boolean;
  outcome: WorkflowStatus;
  evidence: unknown;
  validationErrors: unknown;
  screenshots: string[];
  details: unknown;
  createdAt: string;
}

export interface SheetSyncRecord {
  applicationId: string;
  status: SheetSyncStatus;
  attempts: number;
  rowNumber: number | null;
  response: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

export interface ApplicationRecord {
  id: string;
  sourceUrl: string | null;
  contentHash: string;
  method: string;
  payload: unknown;
  emails: string[];
  formUrls: string[];
  company: string | null;
  role: string | null;
  location: string | null;
  jobDescription: string;
  linkedinPostUrl: string | null;
  applicationUrl: string | null;
  selectedResume: string | null;
  applicationChannel: string;
  createdAt: string;
  updatedAt: string;
  workflows: WorkflowRecord[];
  formQuestions: FormQuestionRecord[];
  formSubmissionAttempts: FormSubmissionAttemptRecord[];
  workflowAttempts: WorkflowAttemptRecord[];
  processingEvents: ProcessingEventRecord[];
  sheetsSync: SheetSyncRecord | null;
}

interface FormDetails {
  url?: unknown;
  questions?: Array<Record<string, unknown>>;
  filled?: Array<Record<string, unknown>>;
  issues?: Array<Record<string, unknown>>;
  screenshots?: unknown;
  resume?: {fileName?: unknown} | null;
  submission?: {attempted?: unknown; evidence?: unknown};
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: DatabaseSync;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  onModuleInit(): void {
    const path = this.config.get('databasePath', {infer: true});
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        source_url TEXT,
        content_hash TEXT NOT NULL,
        method TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        emails_json TEXT NOT NULL,
        forms_json TEXT NOT NULL,
        company TEXT,
        role TEXT,
        location TEXT,
        job_description TEXT NOT NULL DEFAULT '',
        linkedin_post_url TEXT,
        application_url TEXT,
        selected_resume TEXT,
        application_channel TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('email', 'form')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'needs_manual_action', 'failed', 'submission_unknown')),
        attempts INTEGER NOT NULL DEFAULT 0,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(application_id, type),
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
      );
    `);
    this.migrateWorkflowStatuses();
    this.migrateApplicationColumns();
    this.migrateWorkflowColumns();
    this.createTrackingTables();
    this.createDashboardTables();
    this.addColumnIfMissing('sheet_syncs', 'resync_requested', 'INTEGER NOT NULL DEFAULT 0');
    this.backfillFormTracking();
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  insertApplication(input: {
    id: string; sourceUrl: string | null; contentHash: string; method: string;
    payload: unknown; emails: string[]; forms: string[];
    company?: string | null; role?: string | null; location?: string | null; description?: string;
  }): boolean {
    const now = new Date().toISOString();
    const result = this.prepare(`
      INSERT OR IGNORE INTO applications
      (id, source_url, content_hash, method, payload_json, emails_json, forms_json, company, role, location,
       job_description, linkedin_post_url, application_url, application_channel, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.sourceUrl, input.contentHash, input.method, JSON.stringify(input.payload),
      JSON.stringify(input.emails), JSON.stringify(input.forms), input.company || null, input.role || null,
      input.location || null, input.description || '', input.sourceUrl, input.forms.length === 1 ? input.forms[0] : null,
      this.channelLabel(input.method), now, now
    );
    return Number(result.changes) === 1;
  }

  insertWorkflow(id: string, applicationId: string, type: WorkflowType): boolean {
    const now = new Date().toISOString();
    const result = this.prepare(`
      INSERT OR IGNORE INTO workflow_runs
      (id, application_id, type, status, attempts, stage, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, 'queued', ?, ?)
    `).run(id, applicationId, type, now, now);
    return Number(result.changes) === 1;
  }

  claimWorkflowRetry(id: string, expectedStatus: 'failed' | 'needs_manual_action'): boolean {
    const result = this.prepare(`
      UPDATE workflow_runs
      SET status = 'processing', stage = 'processing', attempts = attempts + 1, response_json = NULL, error = NULL,
          completed_at = NULL, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(new Date().toISOString(), id, expectedStatus);
    return Number(result.changes) === 1;
  }

  updateWorkflow(id: string, status: WorkflowStatus, response?: unknown, error?: string): void {
    const now = new Date().toISOString();
    this.prepare(`
      UPDATE workflow_runs
      SET status = ?, stage = CASE WHEN ? IN ('completed', 'failed', 'needs_manual_action', 'submission_unknown') THEN ? ELSE stage END,
          attempts = attempts + ?, response_json = ?, error = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
      WHERE id = ?
    `).run(
      status, status, status, status === 'processing' ? 1 : 0, response === undefined ? null : JSON.stringify(response),
      error || null, now, status, now, id
    );
  }

  recordFormOutcome(id: string, status: WorkflowStatus, response?: unknown, error?: string): void {
    const details = (response && typeof response === 'object' ? response : {}) as FormDetails;
    this.transaction(() => {
      this.updateWorkflow(id, status, response, error);
      const workflow = this.getWorkflow(id);
      const now = new Date().toISOString();
      this.persistLatestQuestions(id, details, now);
      this.prepare(`
        INSERT OR REPLACE INTO form_submission_attempts
        (workflow_id, attempt_number, attempted, outcome, evidence_json, validation_errors_json,
         screenshots_json, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, workflow.attempts, details.submission?.attempted === true ? 1 : 0, status,
        this.jsonOrNull(details.submission?.evidence), JSON.stringify(details.issues || []),
        JSON.stringify(Array.isArray(details.screenshots) ? details.screenshots : []),
        response === undefined ? null : JSON.stringify(response), now
      );
      this.prepare(`
        UPDATE applications
        SET application_url = COALESCE(?, application_url), selected_resume = COALESCE(?, selected_resume), updated_at = ?
        WHERE id = ?
      `).run(
        typeof details.url === 'string' ? details.url : null,
        typeof details.resume?.fileName === 'string' ? details.resume.fileName : null,
        now, workflow.applicationId
      );
    });
  }

  updateApplicationMetadata(id: string, input: {
    company?: string | null; role?: string | null; location?: string | null;
    applicationUrl?: string | null; selectedResume?: string | null;
  }): void {
    this.prepare(`
      UPDATE applications SET
        company = COALESCE(company, ?), role = COALESCE(role, ?), location = COALESCE(location, ?),
        application_url = COALESCE(?, application_url), selected_resume = COALESCE(?, selected_resume), updated_at = ?
      WHERE id = ?
    `).run(
      input.company || null, input.role || null, input.location || null, input.applicationUrl || null,
      input.selectedResume || null, new Date().toISOString(), id
    );
  }

  getWorkflow(id: string): WorkflowRecord {
    const row = this.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Workflow not found: ${id}`);
    return this.mapWorkflow(row);
  }

  getApplication(id: string): ApplicationRecord | null {
    const row = this.prepare('SELECT * FROM applications WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const workflows = this.prepare('SELECT * FROM workflow_runs WHERE application_id = ? ORDER BY type').all(id) as Record<string, unknown>[];
    const questions = this.prepare(`
      SELECT fq.* FROM form_questions fq JOIN workflow_runs wr ON wr.id = fq.workflow_id
      WHERE wr.application_id = ? ORDER BY fq.page_index, fq.question_id
    `).all(id) as Record<string, unknown>[];
    const attempts = this.prepare(`
      SELECT fsa.* FROM form_submission_attempts fsa JOIN workflow_runs wr ON wr.id = fsa.workflow_id
      WHERE wr.application_id = ? ORDER BY fsa.attempt_number
    `).all(id) as Record<string, unknown>[];
    const workflowAttempts = this.prepare(`
      SELECT wa.* FROM workflow_attempts wa JOIN workflow_runs wr ON wr.id = wa.workflow_id
      WHERE wr.application_id = ? ORDER BY wa.started_at, wa.id
    `).all(id) as Record<string, unknown>[];
    const events = this.prepare('SELECT * FROM processing_events WHERE application_id = ? ORDER BY id')
      .all(id) as Record<string, unknown>[];
    const sync = this.prepare('SELECT * FROM sheet_syncs WHERE application_id = ?').get(id) as Record<string, unknown> | undefined;
    return {
      id: String(row.id), sourceUrl: this.nullableString(row.source_url), contentHash: String(row.content_hash),
      method: String(row.method), payload: this.parseJson(row.payload_json, null),
      emails: this.parseJson(row.emails_json, []), formUrls: this.parseJson(row.forms_json, []),
      company: this.nullableString(row.company), role: this.nullableString(row.role),
      location: this.nullableString(row.location), jobDescription: String(row.job_description || ''),
      linkedinPostUrl: this.nullableString(row.linkedin_post_url), applicationUrl: this.nullableString(row.application_url),
      selectedResume: this.nullableString(row.selected_resume),
      applicationChannel: String(row.application_channel || this.channelLabel(String(row.method))),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      workflows: workflows.map(item => this.mapWorkflow(item)),
      formQuestions: questions.map(item => this.mapQuestion(item)),
      formSubmissionAttempts: attempts.map(item => this.mapSubmissionAttempt(item)),
      workflowAttempts: workflowAttempts.map(item => this.mapWorkflowAttempt(item)),
      processingEvents: events.map(item => this.mapEvent(item)),
      sheetsSync: sync ? this.mapSheetSync(sync) : null
    };
  }

  ensureSheetSync(applicationId: string): void {
    const now = new Date().toISOString();
    this.prepare(`
      INSERT INTO sheet_syncs (application_id, status, attempts, created_at, updated_at)
      VALUES (?, 'pending', 0, ?, ?) ON CONFLICT(application_id) DO NOTHING
    `).run(applicationId, now, now);
  }

  markSheetSyncPending(applicationId: string): void {
    const now = new Date().toISOString();
    this.prepare(`
      INSERT INTO sheet_syncs (application_id, status, attempts, created_at, updated_at)
      VALUES (?, 'pending', 0, ?, ?)
      ON CONFLICT(application_id) DO UPDATE SET
        status = CASE WHEN sheet_syncs.status = 'processing' THEN sheet_syncs.status ELSE 'pending' END,
        resync_requested = CASE WHEN sheet_syncs.status = 'processing' THEN 1 ELSE 0 END,
        error = CASE WHEN sheet_syncs.status = 'processing' THEN sheet_syncs.error ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(applicationId, now, now);
  }

  claimSheetSync(applicationId: string): boolean {
    const now = new Date();
    const result = this.prepare(`
      UPDATE sheet_syncs SET status = 'processing', attempts = attempts + 1, resync_requested = 0,
        error = NULL, updated_at = ?
      WHERE application_id = ? AND
        (status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < ?))
    `).run(now.toISOString(), applicationId, new Date(now.getTime() - 10 * 60_000).toISOString());
    return Number(result.changes) === 1;
  }

  completeSheetSync(applicationId: string, rowNumber: number, response?: unknown): void {
    const now = new Date().toISOString();
    this.prepare(`
      UPDATE sheet_syncs SET
        status = CASE WHEN resync_requested = 1 THEN 'pending' ELSE 'completed' END,
        row_number = ?, response_json = ?, error = NULL, updated_at = ?,
        synced_at = CASE WHEN resync_requested = 1 THEN synced_at ELSE ? END
      WHERE application_id = ?
    `).run(rowNumber, this.jsonOrNull(response), now, now, applicationId);
  }

  failSheetSync(applicationId: string, error: string): void {
    this.prepare(`UPDATE sheet_syncs SET status = 'failed', error = ?, updated_at = ? WHERE application_id = ?`)
      .run(error, new Date().toISOString(), applicationId);
  }

  requestSheetSync(applicationId: string): void {
    this.ensureSheetSync(applicationId);
    this.prepare(`
      UPDATE sheet_syncs SET
        status = CASE WHEN status = 'processing' THEN status ELSE 'pending' END,
        resync_requested = CASE WHEN status = 'processing' THEN 1 ELSE 0 END,
        error = CASE WHEN status = 'processing' THEN error ELSE NULL END,
        updated_at = ? WHERE application_id = ?
    `).run(new Date().toISOString(), applicationId);
  }

  listApplications(query: {
    page: number; pageSize: number; search?: string; status?: string; method?: string;
    sort: string; direction: 'asc' | 'desc';
  }): {items: ApplicationRecord[]; page: number; pageSize: number; total: number; pages: number} {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.search) {
      where.push(`(a.company LIKE ? OR a.role LIKE ? OR a.location LIKE ? OR a.job_description LIKE ? OR a.source_url LIKE ?)`);
      const value = `%${query.search}%`;
      params.push(value, value, value, value, value);
    }
    if (query.method) { where.push('a.method = ?'); params.push(query.method); }
    if (query.status) {
      where.push('EXISTS (SELECT 1 FROM workflow_runs wf WHERE wf.application_id = a.id AND wf.status = ?)');
      params.push(query.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortColumns: Record<string, string> = {
      createdAt: 'a.created_at', updatedAt: 'a.updated_at', company: 'a.company', role: 'a.role',
      status: `(SELECT MAX(status) FROM workflow_runs wf WHERE wf.application_id = a.id)`
    };
    const order = sortColumns[query.sort] || sortColumns.updatedAt;
    const totalRow = this.prepare(`SELECT COUNT(*) total FROM applications a ${clause}`).get(...params) as {total: number};
    const rows = this.prepare(`SELECT a.id FROM applications a ${clause} ORDER BY ${order} ${query.direction.toUpperCase()}, a.id ASC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as Array<{id: string}>;
    const total = Number(totalRow.total);
    return {
      items: rows.map(row => this.getApplication(String(row.id))!).filter(Boolean),
      page: query.page, pageSize: query.pageSize, total, pages: Math.max(1, Math.ceil(total / query.pageSize))
    };
  }

  dashboard(): Record<string, unknown> {
    const count = (sql: string): number => Number((this.prepare(sql).get() as {value: number}).value);
    return {
      totals: {
        applications: count('SELECT COUNT(*) value FROM applications'),
        submitted: count("SELECT COUNT(DISTINCT application_id) value FROM workflow_runs WHERE type = 'form' AND status = 'completed'"),
        gmailDrafts: count("SELECT COUNT(*) value FROM workflow_runs WHERE type = 'email' AND status = 'completed' AND COALESCE(json_extract(response_json, '$.status'), json_extract(response_json, '$[0].status'), '') != 'skipped_duplicate'"),
        processing: count("SELECT COUNT(DISTINCT application_id) value FROM workflow_runs WHERE status IN ('pending', 'processing')"),
        failed: count("SELECT COUNT(DISTINCT application_id) value FROM workflow_runs WHERE status = 'failed'"),
        needsManualAction: count("SELECT COUNT(DISTINCT application_id) value FROM workflow_runs WHERE status = 'needs_manual_action'"),
        submissionUnknown: count("SELECT COUNT(DISTINCT application_id) value FROM workflow_runs WHERE status = 'submission_unknown'")
      },
      recentApplications: this.listApplications({page: 1, pageSize: 8, sort: 'updatedAt', direction: 'desc'}).items,
      recentActivity: this.listEvents({after: 0, limit: 12, newestFirst: true}),
      batches: {
        total: count('SELECT COUNT(*) value FROM batches'),
        active: count("SELECT COUNT(*) value FROM batches WHERE status IN ('queued', 'processing')"),
        completed: count("SELECT COUNT(*) value FROM batches WHERE status = 'completed'"),
        withErrors: count("SELECT COUNT(*) value FROM batches WHERE status = 'completed_with_errors'")
      }
    };
  }

  createBatch(input: {
    id: string; idempotencyKey: string; concurrency: number;
    items: Array<{id: string; position: number; input: unknown; targetWorkflowType?: WorkflowType | null;
      retryOfWorkflowId?: string | null; availableAt?: string}>;
  }): {batch: BatchRecord; created: boolean} {
    const existing = this.prepare('SELECT id FROM batches WHERE idempotency_key = ?').get(input.idempotencyKey) as {id: string} | undefined;
    if (existing) return {batch: this.getBatch(existing.id)!, created: false};
    const now = new Date().toISOString();
    this.transaction(() => {
      this.prepare(`INSERT INTO batches (id, idempotency_key, status, concurrency, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?, ?)`).run(input.id, input.idempotencyKey, input.concurrency, now, now);
      const statement = this.prepare(`INSERT INTO batch_items
        (id, batch_id, position, input_json, target_workflow_type, retry_of_workflow_id, status, attempts,
         available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`);
      for (const item of input.items) statement.run(
        item.id, input.id, item.position, JSON.stringify(item.input), item.targetWorkflowType || null,
        item.retryOfWorkflowId || null, item.availableAt || now, now, now
      );
      this.recordEvent({batchId: input.id, stage: 'queued', status: 'queued', message: `${input.items.length} job(s) queued.`});
    });
    return {batch: this.getBatch(input.id)!, created: true};
  }

  getBatch(id: string): BatchRecord | null {
    const row = this.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const items = this.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position').all(id) as Record<string, unknown>[];
    return this.mapBatch(row, items);
  }

  listBatches(page: number, pageSize: number): {items: BatchRecord[]; page: number; pageSize: number; total: number; pages: number} {
    const total = Number((this.prepare('SELECT COUNT(*) total FROM batches').get() as {total: number}).total);
    const rows = this.prepare('SELECT * FROM batches ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    return {
      items: rows.map(row => this.mapBatch(row, this.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position')
        .all(String(row.id)) as Record<string, unknown>[])),
      page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize))
    };
  }

  claimNextBatchItem(workerId: string, leaseMs: number): BatchItemRecord | null {
    let claimed: BatchItemRecord | null = null;
    this.transaction(() => {
      const now = new Date();
      const row = this.prepare(`SELECT bi.* FROM batch_items bi JOIN batches b ON b.id = bi.batch_id
        WHERE ((bi.status = 'queued' AND bi.available_at <= ?) OR
          (bi.status = 'processing' AND bi.lease_expires_at < ?))
          AND (SELECT COUNT(*) FROM batch_items active
            WHERE active.batch_id = bi.batch_id AND active.status = 'processing' AND active.lease_expires_at >= ?) < b.concurrency
        ORDER BY bi.available_at, bi.created_at, bi.position LIMIT 1`)
        .get(now.toISOString(), now.toISOString(), now.toISOString()) as Record<string, unknown> | undefined;
      if (!row) return;
      const result = this.prepare(`UPDATE batch_items SET status = 'processing', attempts = attempts + 1,
        lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?), error = NULL, updated_at = ?
        WHERE id = ? AND (status = 'queued' OR lease_expires_at < ?)`)
        .run(workerId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), now.toISOString(), String(row.id), now.toISOString());
      if (Number(result.changes) !== 1) return;
      this.prepare("UPDATE batches SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now.toISOString(), String(row.batch_id));
      const updated = this.prepare('SELECT * FROM batch_items WHERE id = ?').get(String(row.id)) as Record<string, unknown>;
      claimed = this.mapBatchItem(updated);
    });
    return claimed;
  }

  completeBatchItem(id: string, applicationId: string, result: unknown): void {
    const now = new Date().toISOString();
    const row = this.prepare('SELECT batch_id FROM batch_items WHERE id = ?').get(id) as {batch_id: string};
    this.prepare(`UPDATE batch_items SET status = 'completed', application_id = ?, result_json = ?, error = NULL,
      lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(applicationId, JSON.stringify(result), now, now, id);
    this.refreshBatch(row.batch_id);
  }

  failBatchItem(id: string, error: string, applicationId?: string, result?: unknown): void {
    const now = new Date().toISOString();
    const row = this.prepare('SELECT batch_id FROM batch_items WHERE id = ?').get(id) as {batch_id: string};
    this.prepare(`UPDATE batch_items SET status = 'failed', application_id = COALESCE(?, application_id), result_json = ?,
      error = ?, lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(applicationId || null, this.jsonOrNull(result), error, now, now, id);
    this.refreshBatch(row.batch_id);
  }

  beginWorkflowAttempt(workflowId: string, idempotencyKey: string, request: unknown, batchId?: string): number {
    const workflow = this.getWorkflow(workflowId);
    const now = new Date().toISOString();
    this.prepare(`INSERT OR IGNORE INTO workflow_attempts
      (workflow_id, attempt_number, idempotency_key, status, stage, request_json, started_at)
      VALUES (?, ?, ?, 'processing', ?, ?, ?)`)
      .run(workflowId, workflow.attempts, idempotencyKey, workflow.stage, this.jsonOrNull(request), now);
    const row = (this.prepare('SELECT id FROM workflow_attempts WHERE idempotency_key = ?').get(idempotencyKey) ||
      this.prepare('SELECT id FROM workflow_attempts WHERE workflow_id = ? ORDER BY id DESC LIMIT 1').get(workflowId)) as {id: number};
    this.recordEvent({batchId, applicationId: workflow.applicationId, workflowId, stage: workflow.stage,
      status: 'processing', message: `${workflow.type} workflow attempt ${workflow.attempts} started.`});
    return Number(row.id);
  }

  finishWorkflowAttempt(attemptId: number, status: WorkflowStatus, stage: ProcessingStage, response?: unknown, error?: string, transient = false): void {
    const now = new Date();
    const row = this.prepare('SELECT started_at FROM workflow_attempts WHERE id = ?').get(attemptId) as {started_at: string};
    this.prepare(`UPDATE workflow_attempts SET status = ?, stage = ?, response_json = ?, error = ?, transient = ?,
      completed_at = ?, duration_ms = ? WHERE id = ?`).run(
      status, stage, this.jsonOrNull(response), error || null, transient ? 1 : 0, now.toISOString(),
      Math.max(0, now.getTime() - new Date(row.started_at).getTime()), attemptId
    );
  }

  updateWorkflowStage(workflowId: string, stage: ProcessingStage, message?: string, batchId?: string, data?: unknown): void {
    const workflow = this.getWorkflow(workflowId);
    const now = new Date().toISOString();
    this.prepare('UPDATE workflow_runs SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now, workflowId);
    this.prepare("UPDATE workflow_attempts SET stage = ? WHERE workflow_id = ? AND status = 'processing'")
      .run(stage, workflowId);
    this.recordEvent({batchId, applicationId: workflow.applicationId, workflowId, stage, status: 'processing', message, data});
  }

  recordEvent(input: {batchId?: string; applicationId?: string; workflowId?: string; stage: ProcessingStage;
    status: string; message?: string; data?: unknown}): void {
    this.prepare(`INSERT INTO processing_events
      (batch_id, application_id, workflow_id, stage, status, message, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.batchId || null, input.applicationId || null, input.workflowId || null, input.stage,
      input.status, input.message || null, this.jsonOrNull(input.data), new Date().toISOString()
    );
  }

  listEvents(query: {after: number; limit: number; batchId?: string; applicationId?: string; newestFirst?: boolean}): ProcessingEventRecord[] {
    const where = [query.newestFirst ? '1 = 1' : 'id > ?'];
    const params: Array<string | number> = query.newestFirst ? [] : [query.after];
    if (query.batchId) { where.push('batch_id = ?'); params.push(query.batchId); }
    if (query.applicationId) { where.push('application_id = ?'); params.push(query.applicationId); }
    const direction = query.newestFirst ? 'DESC' : 'ASC';
    const rows = this.prepare(`SELECT * FROM processing_events WHERE ${where.join(' AND ')} ORDER BY id ${direction} LIMIT ?`)
      .all(...params, query.limit) as Record<string, unknown>[];
    return rows.map(row => this.mapEvent(row));
  }

  getFailures(): Array<{application: ApplicationRecord; workflow: WorkflowRecord; retryEligible: boolean; reason: string}> {
    const rows = this.prepare(`SELECT id FROM workflow_runs
      WHERE status IN ('failed', 'needs_manual_action', 'submission_unknown') ORDER BY updated_at DESC`).all() as Array<{id: string}>;
    return rows.map(row => {
      const workflow = this.getWorkflow(row.id);
      const application = this.getApplication(workflow.applicationId)!;
      const attempted = (workflow.response as {submission?: {attempted?: unknown}} | null)?.submission?.attempted === true;
      const retryEligible = workflow.status === 'failed' || (workflow.status === 'needs_manual_action' && !attempted);
      const reason = workflow.status === 'submission_unknown' || attempted
        ? 'Submission may already have occurred; retry is blocked.'
        : workflow.error || 'This workflow can be retried safely.';
      return {application, workflow, retryEligible, reason};
    });
  }

  recoverInterruptedWork(): void {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.prepare(`UPDATE batch_items SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
        available_at = ?, updated_at = ? WHERE status = 'processing'`).run(now, now);
      this.prepare(`UPDATE workflow_runs SET status = 'submission_unknown', stage = 'submission_unknown',
        error = COALESCE(error, 'Backend restarted while form submission was being verified.'), updated_at = ?
        WHERE status = 'processing' AND type = 'form' AND stage IN ('submitting_form', 'verifying_submission')`).run(now);
      this.prepare(`UPDATE workflow_runs SET status = 'needs_manual_action', stage = 'needs_manual_action',
        error = COALESCE(error, 'Backend restarted while n8n was creating a Gmail draft; verify Gmail before retrying.'), updated_at = ?
        WHERE status = 'processing' AND type = 'email'`).run(now);
      this.prepare(`UPDATE workflow_runs SET status = 'failed', stage = 'failed',
        error = COALESCE(error, 'Backend restarted before this workflow completed.'), updated_at = ?
        WHERE status = 'processing'`).run(now);
      this.prepare(`UPDATE workflow_attempts SET
        status = COALESCE((SELECT status FROM workflow_runs WHERE id = workflow_attempts.workflow_id), 'failed'),
        stage = COALESCE((SELECT stage FROM workflow_runs WHERE id = workflow_attempts.workflow_id), 'failed'),
        error = COALESCE(error, 'Backend restarted before this attempt completed.'), completed_at = ?,
        duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
        WHERE status = 'processing'`).run(now, now);
      this.prepare("UPDATE batches SET status = 'queued', updated_at = ? WHERE status = 'processing'").run(now);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private createTrackingTables(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS workflow_runs_application_id_idx ON workflow_runs(application_id);
      CREATE TABLE IF NOT EXISTS form_questions (
        workflow_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        page_index INTEGER,
        label TEXT NOT NULL,
        field_type TEXT,
        required INTEGER,
        answer_json TEXT,
        answer_source TEXT CHECK(answer_source IS NULL OR answer_source IN ('profile', 'derived', 'approved_memory', 'gemini', 'attachment', 'consent')),
        confidence TEXT,
        outcome TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workflow_id, question_id),
        FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS form_submission_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        attempted INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        evidence_json TEXT,
        validation_errors_json TEXT NOT NULL,
        screenshots_json TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(workflow_id, attempt_number),
        FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sheet_syncs (
        application_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        row_number INTEGER,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT,
        resync_requested INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
      );
    `);
  }

  private createDashboardTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'completed', 'completed_with_errors')),
        concurrency INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        application_id TEXT,
        target_workflow_type TEXT CHECK(target_workflow_type IS NULL OR target_workflow_type IN ('email', 'form')),
        retry_of_workflow_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error TEXT,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, position),
        FOREIGN KEY(batch_id) REFERENCES batches(id) ON DELETE CASCADE,
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE SET NULL,
        FOREIGN KEY(retry_of_workflow_id) REFERENCES workflow_runs(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        error TEXT,
        transient INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
        UNIQUE(workflow_id, attempt_number)
      );
      CREATE TABLE IF NOT EXISTS processing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT,
        application_id TEXT,
        workflow_id TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        data_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(batch_id) REFERENCES batches(id) ON DELETE SET NULL,
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE,
        FOREIGN KEY(workflow_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
      );
    `);

    const batchColumns: Array<[string, string]> = [
      ['idempotency_key', "TEXT NOT NULL DEFAULT ''"],
      ['status', "TEXT NOT NULL DEFAULT 'queued'"],
      ['concurrency', 'INTEGER NOT NULL DEFAULT 1'],
      ['created_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
      ['updated_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
      ['completed_at', 'TEXT']
    ];
    for (const [name, definition] of batchColumns) this.addColumnIfMissing('batches', name, definition);

    // The dashboard tables were added after the original application schema.
    // Existing installations may already have an older batch_items table, so
    // migrate its queue columns before creating indexes that reference them.
    const batchItemColumns: Array<[string, string]> = [
      ['batch_id', "TEXT NOT NULL DEFAULT ''"],
      ['position', 'INTEGER NOT NULL DEFAULT 0'],
      ['input_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['application_id', 'TEXT'],
      ['target_workflow_type', 'TEXT'],
      ['retry_of_workflow_id', 'TEXT'],
      ['status', "TEXT NOT NULL DEFAULT 'queued'"],
      ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['result_json', 'TEXT'],
      ['error', 'TEXT'],
      ['available_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
      ['lease_owner', 'TEXT'],
      ['lease_expires_at', 'TEXT'],
      ['started_at', 'TEXT'],
      ['completed_at', 'TEXT'],
      ['created_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
      ['updated_at', "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"]
    ];
    for (const [name, definition] of batchItemColumns) this.addColumnIfMissing('batch_items', name, definition);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS batch_items_claim_idx ON batch_items(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS batch_items_batch_idx ON batch_items(batch_id, position);
      CREATE INDEX IF NOT EXISTS workflow_attempts_workflow_idx ON workflow_attempts(workflow_id, attempt_number);
      CREATE INDEX IF NOT EXISTS processing_events_created_idx ON processing_events(id, created_at);
      CREATE INDEX IF NOT EXISTS processing_events_application_idx ON processing_events(application_id, id);
    `);
  }

  private migrateApplicationColumns(): void {
    const additions: Array<[string, string]> = [
      ['company', 'TEXT'], ['role', 'TEXT'], ['location', 'TEXT'],
      ['job_description', "TEXT NOT NULL DEFAULT ''"], ['linkedin_post_url', 'TEXT'],
      ['application_url', 'TEXT'], ['selected_resume', 'TEXT'], ['application_channel', "TEXT NOT NULL DEFAULT ''"]
    ];
    for (const [name, definition] of additions) this.addColumnIfMissing('applications', name, definition);
    this.db.exec(`
      UPDATE applications SET
        job_description = COALESCE(NULLIF(job_description, ''), json_extract(payload_json, '$.text'), ''),
        linkedin_post_url = COALESCE(linkedin_post_url, source_url),
        application_url = COALESCE(application_url, json_extract(forms_json, '$[0]')),
        application_channel = CASE method
          WHEN 'email' THEN 'Email' WHEN 'form' THEN 'Form' WHEN 'email_and_form' THEN 'Email + Form'
          ELSE method END
      WHERE job_description = '' OR linkedin_post_url IS NULL OR application_url IS NULL OR application_channel = '';
    `);
  }

  private migrateWorkflowColumns(): void {
    this.addColumnIfMissing('workflow_runs', 'completed_at', 'TEXT');
    this.addColumnIfMissing('workflow_runs', 'stage', "TEXT NOT NULL DEFAULT 'queued'");
    this.db.exec("UPDATE workflow_runs SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL;");
    this.db.exec(`UPDATE workflow_runs SET stage = CASE status
      WHEN 'pending' THEN 'queued' WHEN 'processing' THEN 'processing' WHEN 'completed' THEN 'completed'
      WHEN 'failed' THEN 'failed' WHEN 'needs_manual_action' THEN 'needs_manual_action'
      WHEN 'submission_unknown' THEN 'submission_unknown' ELSE stage END WHERE stage = 'queued';`);
  }

  private migrateWorkflowStatuses(): void {
    const row = this.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get() as
      {sql?: string} | undefined;
    if (!row?.sql || row.sql.includes('submission_unknown')) return;
    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE workflow_runs RENAME TO workflow_runs_legacy;
        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('email', 'form')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'needs_manual_action', 'failed', 'submission_unknown')),
          attempts INTEGER NOT NULL DEFAULT 0,
          response_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(application_id, type),
          FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
        );
        INSERT INTO workflow_runs
          (id, application_id, type, status, attempts, response_json, error, created_at, updated_at, completed_at)
        SELECT id, application_id, type, status, attempts, response_json, error, created_at, updated_at,
          CASE WHEN status = 'completed' THEN updated_at ELSE NULL END FROM workflow_runs_legacy;
        DROP TABLE workflow_runs_legacy;
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* no active transaction */ }
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  private persistLatestQuestions(workflowId: string, details: FormDetails, now: string): void {
    this.prepare('DELETE FROM form_questions WHERE workflow_id = ?').run(workflowId);
    const questions = new Map<string, Record<string, unknown>>();
    for (const item of details.questions || []) {
      if (typeof item.questionId !== 'string' || typeof item.label !== 'string') continue;
      questions.set(item.questionId, {
        questionId: item.questionId, label: item.label,
        fieldType: typeof item.fieldType === 'string' ? item.fieldType : null,
        pageIndex: typeof item.pageIndex === 'number' ? item.pageIndex : null,
        required: typeof item.required === 'boolean' ? item.required : null,
        answer: null, source: null, confidence: null, outcome: 'unanswered', errorCode: null, errorMessage: null
      });
    }
    for (const item of details.filled || []) {
      if (typeof item.questionId !== 'string' || typeof item.label !== 'string') continue;
      questions.set(item.questionId, {
        questionId: item.questionId, label: item.label,
        fieldType: typeof item.fieldType === 'string' ? item.fieldType : null,
        required: typeof item.required === 'boolean' ? item.required : null,
        answer: item.value, source: this.answerSource(item.source),
        confidence: typeof item.confidence === 'string' ? item.confidence : null,
        outcome: 'filled', errorCode: null, errorMessage: null
      });
    }
    for (const issue of details.issues || []) {
      if (typeof issue.questionId !== 'string') continue;
      const existing = questions.get(issue.questionId);
      if (existing) {
        existing.errorCode = typeof issue.code === 'string' ? issue.code : null;
        existing.errorMessage = typeof issue.message === 'string' ? issue.message : null;
      } else {
        questions.set(issue.questionId, {
          questionId: issue.questionId,
          label: typeof issue.label === 'string' ? issue.label : issue.questionId,
          fieldType: null, required: typeof issue.required === 'boolean' ? issue.required : null,
          answer: null, source: null, confidence: null, outcome: 'unresolved',
          errorCode: typeof issue.code === 'string' ? issue.code : null,
          errorMessage: typeof issue.message === 'string' ? issue.message : null
        });
      }
    }
    const statement = this.prepare(`
      INSERT INTO form_questions
      (workflow_id, question_id, page_index, label, field_type, required, answer_json, answer_source,
       confidence, outcome, error_code, error_message, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of questions.values()) {
      const questionId = String(item.questionId);
      const pageMatch = /^gform-p(\d+)-/.exec(questionId);
      const required = item.required;
      statement.run(
        workflowId, questionId,
        typeof item.pageIndex === 'number' ? item.pageIndex : pageMatch ? Number(pageMatch[1]) : null,
        String(item.label), item.fieldType as string | null,
        required === null ? null : required ? 1 : 0, this.jsonOrNull(item.answer), item.source as string | null,
        item.confidence as string | null, String(item.outcome), item.errorCode as string | null,
        item.errorMessage as string | null, now
      );
    }
  }

  private backfillFormTracking(): void {
    const rows = this.prepare(`
      SELECT * FROM workflow_runs WHERE type = 'form' AND status NOT IN ('pending', 'processing')
    `).all() as Record<string, unknown>[];
    this.transaction(() => {
      for (const row of rows) {
        const workflowId = String(row.id);
        const existing = this.prepare('SELECT 1 FROM form_submission_attempts WHERE workflow_id = ? LIMIT 1')
          .get(workflowId);
        if (existing) continue;
        const response = this.parseJson<FormDetails>(row.response_json, {});
        const createdAt = String(row.updated_at);
        this.persistLatestQuestions(workflowId, response, createdAt);
        this.prepare(`
          INSERT INTO form_submission_attempts
          (workflow_id, attempt_number, attempted, outcome, evidence_json, validation_errors_json,
           screenshots_json, details_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          workflowId, Math.max(1, Number(row.attempts)), response.submission?.attempted === true ? 1 : 0,
          String(row.status), this.jsonOrNull(response.submission?.evidence), JSON.stringify(response.issues || []),
          JSON.stringify(Array.isArray(response.screenshots) ? response.screenshots : []),
          row.response_json ? String(row.response_json) : null, createdAt
        );
        this.prepare(`
          UPDATE applications SET application_url = COALESCE(application_url, ?),
            selected_resume = COALESCE(selected_resume, ?) WHERE id = ?
        `).run(
          typeof response.url === 'string' ? response.url : null,
          typeof response.resume?.fileName === 'string' ? response.resume.fileName : null,
          String(row.application_id)
        );
      }
    });
  }

  private answerSource(value: unknown): StoredAnswerSource | null {
    if (value === 'verified_profile') return 'profile';
    if (value === 'deterministic') return 'derived';
    if (value === 'approved_suggestion') return 'approved_memory';
    if (value === 'gemini') return 'gemini';
    if (value === 'resume' || value === 'application_document') return 'attachment';
    if (value === 'configured_consent') return 'consent';
    return null;
  }

  private addColumnIfMissing(table: string, name: string, definition: string): void {
    const columns = this.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
    if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
  }

  private transaction(task: () => void): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      task();
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  private mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
    const response = this.parseJson(row.response_json, null);
    const type = row.type as WorkflowType;
    const status = row.status as WorkflowStatus;
    return {
      id: String(row.id), applicationId: String(row.application_id), type, status, attempts: Number(row.attempts),
      response, error: this.nullableString(row.error), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      completedAt: this.nullableString(row.completed_at), outcome: this.workflowOutcome(type, status, response),
      stage: (row.stage || (status === 'pending' ? 'queued' : status)) as ProcessingStage
    };
  }

  private mapWorkflowAttempt(row: Record<string, unknown>): WorkflowAttemptRecord {
    return {
      id: Number(row.id), workflowId: String(row.workflow_id), attemptNumber: Number(row.attempt_number),
      idempotencyKey: String(row.idempotency_key), status: String(row.status), stage: row.stage as ProcessingStage,
      request: this.parseJson(row.request_json, null), response: this.parseJson(row.response_json, null),
      error: this.nullableString(row.error), transient: Boolean(row.transient), startedAt: String(row.started_at),
      completedAt: this.nullableString(row.completed_at),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms)
    } as WorkflowAttemptRecord & {idempotencyKey: string; request: unknown; response: unknown; transient: boolean;
      startedAt: string; completedAt: string | null; durationMs: number | null};
  }

  private mapEvent(row: Record<string, unknown>): ProcessingEventRecord {
    return {
      id: Number(row.id), batchId: this.nullableString(row.batch_id), applicationId: this.nullableString(row.application_id),
      workflowId: this.nullableString(row.workflow_id), stage: row.stage as ProcessingStage, status: String(row.status),
      message: this.nullableString(row.message), data: this.parseJson(row.data_json, null), createdAt: String(row.created_at)
    } as ProcessingEventRecord & {batchId: string | null; applicationId: string | null; workflowId: string | null};
  }

  private mapBatch(row: Record<string, unknown>, itemRows: Record<string, unknown>[]): BatchRecord {
    const items = itemRows.map(item => this.mapBatchItem(item));
    const count = (status: BatchItemStatus) => items.filter(item => item.status === status).length;
    return {
      id: String(row.id), idempotencyKey: String(row.idempotency_key), status: row.status as BatchRecord['status'],
      concurrency: Number(row.concurrency), total: items.length, queued: count('queued'), processing: count('processing'),
      completed: count('completed'), failed: count('failed'), createdAt: String(row.created_at),
      updatedAt: String(row.updated_at), completedAt: this.nullableString(row.completed_at), items
    };
  }

  private mapBatchItem(row: Record<string, unknown>): BatchItemRecord {
    return {
      id: String(row.id), batchId: String(row.batch_id), position: Number(row.position),
      input: this.parseJson(row.input_json, {}), applicationId: this.nullableString(row.application_id),
      targetWorkflowType: row.target_workflow_type as WorkflowType | null,
      retryOfWorkflowId: this.nullableString(row.retry_of_workflow_id), status: row.status as BatchItemStatus,
      attempts: Number(row.attempts), result: this.parseJson(row.result_json, null), error: this.nullableString(row.error),
      availableAt: String(row.available_at), startedAt: this.nullableString(row.started_at),
      completedAt: this.nullableString(row.completed_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  private refreshBatch(batchId: string): void {
    const counts = this.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) processing,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed
      FROM batch_items WHERE batch_id = ?`).get(batchId) as Record<string, number>;
    const finished = Number(counts.queued) === 0 && Number(counts.processing) === 0;
    const status = finished ? (Number(counts.failed) > 0 ? 'completed_with_errors' : 'completed') : 'processing';
    const now = new Date().toISOString();
    this.prepare(`UPDATE batches SET status = ?, updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE NULL END WHERE id = ?`)
      .run(status, now, finished ? 1 : 0, now, batchId);
    if (finished) this.recordEvent({batchId, stage: Number(counts.failed) ? 'failed' : 'completed', status,
      message: Number(counts.failed) ? `${counts.failed} batch item(s) failed.` : 'Batch completed.'});
  }

  private workflowOutcome(type: WorkflowType, status: WorkflowStatus, response: unknown): string {
    if (type === 'form' && status === 'completed') return 'form_submitted';
    if (type === 'form' && status === 'submission_unknown') return 'submission_unknown';
    if (type === 'email' && status === 'completed') {
      const value = response && typeof response === 'object' ? response as {status?: unknown} : null;
      return typeof value?.status === 'string' ? value.status : 'email_workflow_completed';
    }
    return status;
  }

  private mapQuestion(row: Record<string, unknown>): FormQuestionRecord {
    return {
      workflowId: String(row.workflow_id), questionId: String(row.question_id),
      pageIndex: row.page_index === null ? null : Number(row.page_index), label: String(row.label),
      fieldType: this.nullableString(row.field_type), required: row.required === null ? null : Boolean(row.required),
      answer: this.parseJson(row.answer_json, null), answerSource: row.answer_source as StoredAnswerSource | null,
      confidence: this.nullableString(row.confidence), outcome: String(row.outcome),
      errorCode: this.nullableString(row.error_code), errorMessage: this.nullableString(row.error_message),
      updatedAt: String(row.updated_at)
    };
  }

  private mapSubmissionAttempt(row: Record<string, unknown>): FormSubmissionAttemptRecord {
    return {
      id: Number(row.id), workflowId: String(row.workflow_id), attemptNumber: Number(row.attempt_number),
      attempted: Boolean(row.attempted), outcome: row.outcome as WorkflowStatus,
      evidence: this.parseJson(row.evidence_json, null), validationErrors: this.parseJson(row.validation_errors_json, []),
      screenshots: this.parseJson(row.screenshots_json, []), details: this.parseJson(row.details_json, null),
      createdAt: String(row.created_at)
    };
  }

  private mapSheetSync(row: Record<string, unknown>): SheetSyncRecord {
    return {
      applicationId: String(row.application_id), status: row.status as SheetSyncStatus,
      attempts: Number(row.attempts), rowNumber: row.row_number === null ? null : Number(row.row_number),
      response: this.parseJson(row.response_json, null), error: this.nullableString(row.error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), syncedAt: this.nullableString(row.synced_at)
    };
  }

  private parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string' || !value) return fallback;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }

  private jsonOrNull(value: unknown): string | null {
    return value === undefined || value === null ? null : JSON.stringify(value);
  }

  private nullableString(value: unknown): string | null {
    return value === undefined || value === null || value === '' ? null : String(value);
  }

  private channelLabel(method: string): string {
    if (method === 'email') return 'Email';
    if (method === 'form') return 'Form';
    if (method === 'email_and_form') return 'Email + Form';
    return method;
  }
}
