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

  onModuleDestroy(): void {
    this.db?.close();
  }

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

  insertWorkflow(id: string, applicationId: string, type: WorkflowType): boolean {
    const now = new Date().toISOString();
    const result = this.prepare(`
      INSERT OR IGNORE INTO workflow_runs
      (id, application_id, type, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?)
    `).run(id, applicationId, type, now, now);
    return Number(result.changes) === 1;
  }

  updateWorkflow(id: string, status: WorkflowStatus, response?: unknown, error?: string): void {
    this.prepare(`
      UPDATE workflow_runs SET status = ?, attempts = attempts + ?, response_json = ?, error = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status === 'processing' ? 1 : 0, response === undefined ? null : JSON.stringify(response),
      error || null, new Date().toISOString(), id);
  }

  getWorkflow(id: string): WorkflowRecord {
    const row = this.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as Record<string, unknown>;
    return this.mapWorkflow(row);
  }

  getApplication(id: string): {id: string; method: string; workflows: WorkflowRecord[]} | null {
    const application = this.prepare('SELECT id, method FROM applications WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!application) return null;
    const rows = this.prepare('SELECT * FROM workflow_runs WHERE application_id = ? ORDER BY type').all(id) as Record<string, unknown>[];
    return {id: String(application.id), method: String(application.method), workflows: rows.map(row => this.mapWorkflow(row))};
  }

  private prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

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
