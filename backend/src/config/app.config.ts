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
}

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function localHttpUrl(name: string, fallback: string): string {
  const value = process.env[name] || fallback;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'n8n'].includes(url.hostname)) {
    throw new Error(`${name} must be an HTTP URL for localhost, 127.0.0.1, or the Compose n8n service.`);
  }
  return url.href;
}

export default (): AppConfiguration => {
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) {
    throw new Error('HOST must remain loopback, or 0.0.0.0 only inside a locally published container.');
  }

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
    geminiTimeoutMs: integer('GEMINI_TIMEOUT_MS', 30000)
  };
};
