import {resolve} from 'node:path';

export interface AppConfiguration {
  host: string;
  port: number;
  databasePath: string;
  n8nWebhookUrl: string;
  n8nTimeoutMs: number;
  urlResolutionTimeoutMs: number;
  apiToken: string;
  profilePath: string;
  profileTemplatePath: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiTimeoutMs: number;
  formAutomationEnabled: boolean;
  formAutoSubmit: boolean;
  formAllowLocalhost: boolean;
  formTimeoutMs: number;
  formNavigationTimeoutMs: number;
  formMaxRetries: number;
  formMaxPages: number;
  formArtifactsDirectory: string;
  resumeDirectory: string;
  applicationDocumentsDirectory: string;
  formAuthStatePath: string;
  formAuthLoginUrl: string;
  formAuthLoginTimeoutMs: number;
  formAuthCdpUrl: string;
  playwrightHeadless: boolean;
  playwrightBrowserExecutablePath: string;
  googleSheetsSyncEnabled: boolean;
  googleSheetsSpreadsheetId: string;
  googleSheetsTab: string;
  googleSheetsCredentialPath: string;
  googleSheetsAccessToken: string;
  googleSheetsTimeoutMs: number;
}

/**
 * **Summary:** Reads a required positive integer setting and rejects invalid configuration before the application starts.
 * **Inputs:** `name` identifies the environment variable; `fallback` is used when no value is configured.
 * **Returns:** The validated positive integer setting.
 */
function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

/**
 * **Summary:** Reads and validates an internal HTTP service URL so integrations remain limited to approved local destinations.
 * **Inputs:** `name` identifies the environment variable; `fallback` supplies its default URL.
 * **Returns:** The normalized local HTTP URL.
 */
function localHttpUrl(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'n8n'].includes(url.hostname)) {
    throw new Error(`${name} must be an HTTP URL for localhost, 127.0.0.1, or the Compose n8n service.`);
  }
  return url.href;
}

/**
 * **Summary:** Converts a human-friendly environment setting into a strict boolean configuration value.
 * **Inputs:** `name` identifies the environment variable; `fallback` is used when the setting is absent.
 * **Returns:** The configured boolean value.
 */
function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
  if (/^(?:0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

/**
 * **Summary:** Reads a count-like setting that may be zero and rejects invalid configuration values.
 * **Inputs:** `name` identifies the environment variable; `fallback` is used when no value is configured.
 * **Returns:** The validated non-negative integer setting.
 */
function nonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

/**
 * **Summary:** Builds the trusted sign-in destination used for manual form authentication.
 * **Inputs:** No parameters; the destination comes from the authentication environment setting.
 * **Returns:** A normalized credential-free HTTPS authentication URL.
 */
function authenticationUrl(): string {
  const value = process.env.FORM_AUTH_LOGIN_URL || 'https://accounts.google.com/';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('FORM_AUTH_LOGIN_URL must be a credential-free HTTPS URL.');
  }
  return url.href;
}

/**
 * **Summary:** Validates the optional connection address for a locally managed external authentication browser.
 * **Inputs:** No parameters; the connection address comes from the browser-authentication environment setting.
 * **Returns:** The approved loopback browser origin, or an empty string when external-browser authentication is disabled.
 */
function authenticationCdpUrl(): string {
  const value = process.env.FORM_AUTH_CDP_URL || '';
  if (!value) return '';
  const url = new URL(value);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('FORM_AUTH_CDP_URL must be an unauthenticated loopback HTTP origin, for example http://127.0.0.1:9222.');
  }
  return url.origin;
}

/**
 * **Summary:** Assembles and validates all runtime settings required by the backend and its automation workflows.
 * **Inputs:** No parameters; values are read from environment variables with safe local defaults.
 * **Returns:** The complete typed application configuration.
 */
export default (): AppConfiguration => {
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) {
    throw new Error('HOST must remain loopback, or 0.0.0.0 only inside a locally published container.');
  }

  const googleSheetsSpreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
    '1CgddJkpyd5zaL1plm5yc9Zkwg_OwASgniBjPWbMduwA';
  if (!/^[A-Za-z0-9_-]+$/.test(googleSheetsSpreadsheetId)) {
    throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is invalid.');
  }
  const googleSheetsTab = (process.env.GOOGLE_SHEETS_TAB || 'Applications').trim();
  if (!googleSheetsTab || googleSheetsTab.length > 100) throw new Error('GOOGLE_SHEETS_TAB is invalid.');

  return {
    host,
    port: integer('PORT', 3000),
    databasePath: process.env.DATABASE_PATH === ':memory:'
      ? ':memory:'
      : resolve(process.env.DATABASE_PATH || './data/jobs.sqlite'),
    n8nWebhookUrl: localHttpUrl('N8N_WEBHOOK_URL', 'http://127.0.0.1:5678/webhook/linkedin-job'),
    n8nTimeoutMs: integer('N8N_TIMEOUT_MS', 20000),
    urlResolutionTimeoutMs: integer('URL_RESOLUTION_TIMEOUT_MS', 8000),
    apiToken: process.env.API_TOKEN || '',
    profilePath: resolve(process.env.PROFILE_PATH || './data/profile.json'),
    profileTemplatePath: resolve(process.env.PROFILE_TEMPLATE_PATH || './data/profile.json'),
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    geminiTimeoutMs: integer('GEMINI_TIMEOUT_MS', 30000),
    formAutomationEnabled: boolean('FORM_AUTOMATION_ENABLED', true),
    formAutoSubmit: boolean('FORM_AUTO_SUBMIT', true),
    formAllowLocalhost: boolean('FORM_ALLOW_LOCALHOST', false),
    formTimeoutMs: integer('FORM_TIMEOUT_MS', 90000),
    formNavigationTimeoutMs: integer('FORM_NAVIGATION_TIMEOUT_MS', 30000),
    formMaxRetries: nonNegativeInteger('FORM_MAX_RETRIES', 1),
    formMaxPages: integer('FORM_MAX_PAGES', 10),
    formArtifactsDirectory: resolve(process.env.FORM_ARTIFACTS_DIRECTORY || './data/form-artifacts'),
    resumeDirectory: resolve(process.env.RESUME_DIRECTORY || '/files/resumes'),
    applicationDocumentsDirectory: resolve(process.env.APPLICATION_DOCUMENTS_DIRECTORY || process.env.RESUME_DIRECTORY || '/files/resumes'),
    formAuthStatePath: resolve(process.env.FORM_AUTH_STATE_PATH || './data/playwright/google-storage-state.json'),
    formAuthLoginUrl: authenticationUrl(),
    formAuthLoginTimeoutMs: integer('FORM_AUTH_LOGIN_TIMEOUT_MS', 300000),
    formAuthCdpUrl: authenticationCdpUrl(),
    playwrightHeadless: boolean('PLAYWRIGHT_HEADLESS', true),
    playwrightBrowserExecutablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE_PATH || '',
    googleSheetsSyncEnabled: boolean('GOOGLE_SHEETS_SYNC_ENABLED', false),
    googleSheetsSpreadsheetId,
    googleSheetsTab,
    googleSheetsCredentialPath: process.env.GOOGLE_SHEETS_CREDENTIALS_PATH
      ? resolve(process.env.GOOGLE_SHEETS_CREDENTIALS_PATH) : '',
    googleSheetsAccessToken: process.env.GOOGLE_SHEETS_ACCESS_TOKEN || '',
    googleSheetsTimeoutMs: integer('GOOGLE_SHEETS_TIMEOUT_MS', 15000)
  };
};
