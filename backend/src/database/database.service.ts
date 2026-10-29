import {Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseSync, StatementSync} from 'node:sqlite';
import {dirname} from 'node:path';
import {mkdirSync} from 'node:fs';
import {AppConfiguration} from '../config/app.config';

export type WorkflowType = 'email' | 'form';
export type WorkflowStatus = 'pending' | 'processing' | 'completed' | 'needs_manual_action' | 'failed';

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
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: DatabaseSync;

  /**
   * **Summary:** Creates the database service with access to the configured storage location.
   * **Inputs:** `config` provides the path for persistent or in-memory application storage.
   * **Returns:** A database service instance that will initialize with the application module.
   */
  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  /**
   * **Summary:** Opens application storage, creates the required job tables, and upgrades older workflow records when needed.
   * **Inputs:** No parameters; initialization uses the configured database path.
   * **Returns:** No value; the service becomes ready for application and workflow operations.
   */
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('email', 'form')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'needs_manual_action', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(application_id, type),
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_application_id_idx ON workflow_runs(application_id);
    `);
    this.migrateWorkflowStatuses();
  }

  /**
   * **Summary:** Closes application storage when the module shuts down so pending database resources are released safely.
   * **Inputs:** No parameters.
   * **Returns:** No value.
   */
  onModuleDestroy(): void {
    this.db?.close();
  }

  /**
   * **Summary:** Records a newly discovered job application once so repeated captures do not create duplicate work.
   * **Inputs:** `input` contains the stable identity, source details, classification, payload, and application destinations.
   * **Returns:** `true` when a new application was stored, or `false` when it already existed.
   */
  insertApplication(input: {
    id: string; sourceUrl: string | null; contentHash: string; method: string;
    payload: unknown; emails: string[]; forms: string[];
  }): boolean {
    const now = new Date().toISOString();
    const result = this.prepare(`
      INSERT OR IGNORE INTO applications
      (id, source_url, content_hash, method, payload_json, emails_json, forms_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.sourceUrl, input.contentHash, input.method, JSON.stringify(input.payload),
      JSON.stringify(input.emails), JSON.stringify(input.forms), now, now);
    return Number(result.changes) === 1;
  }

  /**
   * **Summary:** Creates one pending delivery workflow for an application while preserving idempotency for each channel.
   * **Inputs:** `id` identifies the workflow; `applicationId` links its application; `type` selects email or form delivery.
   * **Returns:** `true` when the workflow was created, or `false` when an equivalent workflow already existed.
   */
  insertWorkflow(id: string, applicationId: string, type: WorkflowType): boolean {
    const now = new Date().toISOString();
    const result = this.prepare(`
      INSERT OR IGNORE INTO workflow_runs
      (id, application_id, type, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)
    `).run(id, applicationId, type, now, now);
    return Number(result.changes) === 1;
  }

  /**
   * **Summary:** Atomically reclaims a safely retryable workflow so concurrent duplicate requests cannot execute it twice.
   * **Inputs:** `id` identifies the workflow; `expectedStatus` is the retryable terminal state observed by the caller.
   * **Returns:** `true` when this caller claimed the retry, or `false` when another caller changed the workflow first.
   */
  claimWorkflowRetry(id: string, expectedStatus: 'failed' | 'needs_manual_action'): boolean {
    const result = this.prepare(`
      UPDATE workflow_runs
      SET status = 'processing', attempts = attempts + 1, response_json = NULL, error = NULL, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(new Date().toISOString(), id, expectedStatus);
    return Number(result.changes) === 1;
  }

  /**
   * **Summary:** Advances a workflow's lifecycle and records its latest outcome for status reporting and retries.
   * **Inputs:** `id` identifies the workflow; `status` is its new state; `response` and `error` describe the outcome when available.
   * **Returns:** No value; the matching workflow record is updated.
   */
  updateWorkflow(id: string, status: WorkflowStatus, response?: unknown, error?: string): void {
    this.prepare(`
      UPDATE workflow_runs SET status = ?, attempts = attempts + ?, response_json = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status === 'processing' ? 1 : 0, response === undefined ? null : JSON.stringify(response),
      error || null, new Date().toISOString(), id);
  }

  /**
   * **Summary:** Retrieves the current state and recorded outcome of a workflow.
   * **Inputs:** `id` identifies the workflow to retrieve.
   * **Returns:** The normalized workflow record.
   */
  getWorkflow(id: string): WorkflowRecord {
    const row = this.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Record<string, unknown>;
    return this.mapWorkflow(row);
  }

  /**
   * **Summary:** Retrieves an application summary together with every workflow created for its application channels.
   * **Inputs:** `id` identifies the application to retrieve.
   * **Returns:** The application and its workflows, or `null` when the application is unknown.
   */
  getApplication(id: string): {id: string; method: string; workflows: WorkflowRecord[]} | null {
    const application = this.prepare('SELECT id, method FROM applications WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!application) return null;
    const rows = this.prepare('SELECT * FROM workflow_runs WHERE application_id = ? ORDER BY type').all(id) as Record<string, unknown>[];
    return {id: String(application.id), method: String(application.method), workflows: rows.map(row => this.mapWorkflow(row))};
  }

  /**
   * **Summary:** Creates a reusable database operation for an application-storage query.
   * **Inputs:** `sql` is the database statement to prepare.
   * **Returns:** The prepared statement used by the service's storage operations.
   */
  private prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  /**
   * **Summary:** Upgrades legacy workflow storage to support manual-action outcomes without losing existing records.
   * **Inputs:** No parameters; the function examines the current workflow table definition.
   * **Returns:** No value; storage is migrated only when the newer status is missing.
   */
  private migrateWorkflowStatuses(): void {
    const row = this.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get() as
      {sql?: string} | undefined;
    if (!row?.sql || row.sql.includes('needs_manual_action')) return;
    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE workflow_runs RENAME TO workflow_runs_legacy;
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('email', 'form')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'needs_manual_action', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(application_id, type),
        FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE
      );
      INSERT INTO workflow_runs SELECT * FROM workflow_runs_legacy;
      DROP TABLE workflow_runs_legacy;
      CREATE INDEX workflow_runs_application_id_idx ON workflow_runs(application_id);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  /**
   * **Summary:** Converts a stored workflow row into the typed model returned to application services and API callers.
   * **Inputs:** `row` is the raw workflow data read from application storage.
   * **Returns:** A normalized workflow record with parsed response and timestamp fields.
   */
  private mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
    return {
      id: String(row.id),
      applicationId: String(row.application_id),
      type: row.type as WorkflowType,
      status: row.status as WorkflowStatus,
      attempts: Number(row.attempts),
      response: row.response_json ? JSON.parse(String(row.response_json)) : null,
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
