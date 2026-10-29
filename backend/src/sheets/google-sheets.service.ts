import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createSign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AppConfiguration} from '../config/app.config';
import {ApplicationRecord, WorkflowRecord} from '../database/database.service';

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface SheetValuesResponse {
  values?: unknown[][];
  updates?: {updatedRange?: string};
}

export interface SheetSyncResult {
  rowNumber: number;
  operation: 'appended' | 'updated';
  updatedColumns: string[];
}

const TRACKING_COLUMNS = [
  'Application ID', 'Application URL', 'Form Status', 'Form Updated At',
  'Submission Evidence', 'Form Resume', 'Form Notes'
];

@Injectable()
export class GoogleSheetsService {
  private tokenCache: {value: string; expiresAt: number} | null = null;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  isEnabled(): boolean {
    return this.config.get('googleSheetsSyncEnabled', {infer: true});
  }

  /** Synchronizes only form-owned cells and fills shared metadata only when it is currently blank. */
  async sync(application: ApplicationRecord): Promise<SheetSyncResult> {
    if (!this.isEnabled()) throw new Error('Google Sheets synchronization is disabled.');
    const rows = await this.readRows();
    const headers = (rows[0] || []).map(value => String(value || '').trim());
    if (!headers.length) {
      headers.push('Company', 'Role', 'Job Link', 'Application Channel', 'Date Found', 'Date Applied', 'Status', 'Location', 'Notes');
    }
    for (const column of TRACKING_COLUMNS) if (!headers.includes(column)) headers.push(column);
    if (!rows[0] || headers.length !== rows[0].length) await this.writeHeader(headers);

    const idIndex = headers.indexOf('Application ID');
    const linkIndex = headers.indexOf('Job Link');
    let rowIndex = rows.slice(1).findIndex(row => String(row[idIndex] || '') === application.id);
    if (rowIndex < 0 && application.linkedinPostUrl && linkIndex >= 0) {
      const matches = rows.slice(1)
        .map((row, index) => ({row, index}))
        .filter(item => String(item.row[linkIndex] || '') === application.linkedinPostUrl);
      if (matches.length > 1) throw new Error('More than one legacy tracker row has this Job Link; assign an Application ID manually.');
      rowIndex = matches[0]?.index ?? -1;
    }

    const desired = this.values(application);
    if (rowIndex < 0) {
      const values = headers.map(header => desired.get(header) || '');
      const result = await this.appendRow(values);
      const rowNumber = this.rowFromUpdatedRange(result.updates?.updatedRange) || Math.max(2, rows.length + 1);
      return {rowNumber, operation: 'appended', updatedColumns: [...desired.keys()]};
    }

    const rowNumber = rowIndex + 2;
    const current = rows[rowIndex + 1] || [];
    const formOwned = new Set(TRACKING_COLUMNS);
    const updates: Array<{range: string; values: string[][]}> = [];
    const updatedColumns: string[] = [];
    for (const [header, value] of desired) {
      const columnIndex = headers.indexOf(header);
      if (columnIndex < 0) continue;
      const existing = String(current[columnIndex] || '');
      const preserveWhenPresent = header === 'Form Notes';
      const shouldWrite = (formOwned.has(header) && !preserveWhenPresent && (Boolean(value) || !existing)) || !existing ||
        (header === 'Application Channel' && application.method === 'email_and_form' && existing === 'Email');
      if (!shouldWrite || existing === value) continue;
      updates.push({range: `${this.quotedTab()}!${this.columnName(columnIndex + 1)}${rowNumber}`, values: [[value]]});
      updatedColumns.push(header);
    }
    if (updates.length) await this.batchUpdate(updates);
    return {rowNumber, operation: 'updated', updatedColumns};
  }

  private values(application: ApplicationRecord): Map<string, string> {
    const form = application.workflows.find(workflow => workflow.type === 'form');
    const evidence = this.submissionEvidence(form);
    const values = new Map<string, string>([
      ['Application ID', application.id],
      ['Application URL', application.applicationUrl || application.formUrls[0] || ''],
      ['Form Status', form?.status || 'pending'],
      ['Form Updated At', form?.updatedAt || application.updatedAt],
      ['Submission Evidence', evidence],
      ['Form Resume', application.selectedResume || ''],
      ['Form Notes', this.formNotes(form)],
      ['Company', application.company || ''],
      ['Role', application.role || ''],
      ['Job Link', application.linkedinPostUrl || ''],
      ['Application Channel', application.applicationChannel],
      ['Date Found', application.createdAt.slice(0, 10)],
      ['Date Applied', form?.status === 'completed' ? (form.completedAt || form.updatedAt).slice(0, 10) : ''],
      ['Location', application.location || '']
    ]);
    return new Map([...values].filter(([, value]) => value !== ''));
  }

  private submissionEvidence(workflow: WorkflowRecord | undefined): string {
    const response = workflow?.response as {submission?: {evidence?: {kind?: unknown; message?: unknown; url?: unknown}}} | null;
    const evidence = response?.submission?.evidence;
    if (!evidence) return '';
    return [evidence.kind, evidence.message, evidence.url]
      .filter(value => typeof value === 'string' && value).join(' — ').slice(0, 2000);
  }

  private formNotes(workflow: WorkflowRecord | undefined): string {
    if (!workflow) return '';
    const response = workflow.response as {issues?: Array<{code?: unknown; message?: unknown}>} | null;
    const issues = (response?.issues || []).slice(-5).map(issue =>
      [issue.code, issue.message].filter(value => typeof value === 'string' && value).join(': '));
    const prefix = workflow.error ? `Error: ${workflow.error}` : '';
    return [prefix, ...issues].filter(Boolean).join(' | ').slice(0, 2000);
  }

  private async readRows(): Promise<unknown[][]> {
    const data = await this.request<SheetValuesResponse>('GET', `/values/${encodeURIComponent(`${this.quotedTab()}!A:ZZ`)}`);
    return data.values || [];
  }

  private async writeHeader(headers: string[]): Promise<void> {
    const end = this.columnName(headers.length);
    await this.request('PUT', `/values/${encodeURIComponent(`${this.quotedTab()}!A1:${end}1`)}?valueInputOption=RAW`, {
      range: `${this.quotedTab()}!A1:${end}1`, majorDimension: 'ROWS', values: [headers]
    });
  }

  private appendRow(values: string[]): Promise<SheetValuesResponse> {
    return this.request(
      'POST', `/values/${encodeURIComponent(`${this.quotedTab()}!A:ZZ`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {majorDimension: 'ROWS', values: [values]}
    );
  }

  private batchUpdate(data: Array<{range: string; values: string[][]}>): Promise<unknown> {
    return this.request('POST', '/values:batchUpdate', {valueInputOption: 'RAW', data});
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const spreadsheetId = this.config.get('googleSheetsSpreadsheetId', {infer: true});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.get('googleSheetsTimeoutMs', {infer: true}));
    try {
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
        method,
        headers: {Authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Google Sheets returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error('Google Sheets returned a non-JSON response.');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async accessToken(): Promise<string> {
    const configured = this.config.get('googleSheetsAccessToken', {infer: true});
    if (configured) return configured;
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) return this.tokenCache.value;
    const path = this.config.get('googleSheetsCredentialPath', {infer: true});
    if (!path) throw new Error('Configure GOOGLE_SHEETS_CREDENTIALS_PATH or GOOGLE_SHEETS_ACCESS_TOKEN.');
    const credentials = JSON.parse(await readFile(path, 'utf8')) as Partial<ServiceAccountCredentials>;
    if (!credentials.client_email || !credentials.private_key) throw new Error('Google Sheets service-account credentials are incomplete.');
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
    const header = this.base64Url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
    const claims = this.base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: tokenUri,
      iat: now,
      exp: now + 3600
    }));
    const unsigned = `${header}.${claims}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString('base64url')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.get('googleSheetsTimeoutMs', {infer: true}));
    try {
      const response = await fetch(tokenUri, {
        method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}),
        signal: controller.signal
      });
      const data = await response.json() as {access_token?: string; expires_in?: number; error_description?: string};
      if (!response.ok || !data.access_token) {
        throw new Error(`Google OAuth token exchange failed: ${data.error_description || response.status}`);
      }
      this.tokenCache = {value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000};
      return data.access_token;
    } finally {
      clearTimeout(timer);
    }
  }

  private quotedTab(): string {
    return `'${this.config.get('googleSheetsTab', {infer: true}).replace(/'/g, "''")}'`;
  }

  private columnName(index: number): string {
    let value = index;
    let result = '';
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + value % 26) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  private rowFromUpdatedRange(range: string | undefined): number | null {
    const match = range ? /![A-Z]+(\d+)(?::[A-Z]+\d+)?$/.exec(range) : null;
    return match ? Number(match[1]) : null;
  }

  private base64Url(value: string): string {
    return Buffer.from(value).toString('base64url');
  }
}
