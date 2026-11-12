import {Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createSign} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {AppConfiguration} from '../config/app.config';

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface SheetValuesResponse {
  values?: unknown[][];
}

export interface LegacySheetApplication {
  company: string;
  role: string;
  sourceUrl: string;
  applicationUrl: string;
  channel: string;
  status: string;
  location: string;
  notes: string;
  dateFound: string;
}

/**
 * Read-only, one-time migration adapter for the former Google Sheets tracker.
 * Runtime application tracking is SQLite-only and never writes to Sheets.
 */
@Injectable()
export class GoogleSheetsService {
  private tokenCache: {value: string; expiresAt: number} | null = null;

  constructor(private readonly config: ConfigService<AppConfiguration, true>) {}

  async readLegacyApplications(): Promise<LegacySheetApplication[]> {
    const rows = await this.readRows();
    const headers = (rows[0] || []).map(value => String(value || '').trim());
    const value = (row: unknown[], name: string) => {
      const index = headers.indexOf(name);
      return index < 0 ? '' : String(row[index] || '').trim();
    };
    return rows.slice(1).map(row => ({
      company: value(row, 'Company'),
      role: value(row, 'Role'),
      sourceUrl: value(row, 'Job Link'),
      applicationUrl: value(row, 'Application URL'),
      channel: value(row, 'Application Channel'),
      status: value(row, 'Status'),
      location: value(row, 'Location'),
      notes: value(row, 'Notes'),
      dateFound: value(row, 'Date Found')
    })).filter(row => row.sourceUrl || row.applicationUrl || row.role || row.company);
  }

  private async readRows(): Promise<unknown[][]> {
    const data = await this.request<SheetValuesResponse>(
      `/values/${encodeURIComponent(`${this.quotedTab()}!A:ZZ`)}`
    );
    return data.values || [];
  }

  private async request<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const spreadsheetId = this.config.get('googleSheetsSpreadsheetId', {infer: true});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.get('googleSheetsTimeoutMs', {infer: true}));
    try {
      const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`, {
        headers: {Authorization: `Bearer ${token}`},
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Google Sheets returned HTTP ${response.status}: ${text.slice(0, 500)}`);
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
    if (!path) throw new Error('Configure GOOGLE_SHEETS_CREDENTIALS_PATH or GOOGLE_SHEETS_ACCESS_TOKEN for the one-time import.');
    const credentials = JSON.parse(await readFile(path, 'utf8')) as Partial<ServiceAccountCredentials>;
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('Google Sheets service-account credentials are incomplete.');
    }
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
    const header = this.base64Url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
    const claims = this.base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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
        method: 'POST',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
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

  private base64Url(value: string): string {
    return Buffer.from(value).toString('base64url');
  }
}
