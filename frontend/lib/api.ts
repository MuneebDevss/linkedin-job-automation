import type {Application, Batch, DashboardData, JobInput, Paginated, ProcessingEvent, Workflow} from './types';

const DEFAULT_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3000/api/jobs';

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) { super(message); }
}

export function connectionSettings() {
  if (typeof window === 'undefined') return {url: process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3000/api/jobs', token: ''};
  return {
    url: sessionStorage.getItem('job-api-url') || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3000/api/jobs',
    token: sessionStorage.getItem('job-api-token') || ''
  };
}

export function saveConnectionSettings(url: string, token: string) {
  sessionStorage.setItem('job-api-url', url.replace(/\/$/, ''));
  sessionStorage.setItem('job-api-token', token);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const {url, token} = connectionSettings();
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {'content-type': 'application/json', ...(token ? {'x-api-key': token} : {}), ...init?.headers},
    cache: 'no-store'
  });
  const body = await response.json().catch(() => null) as {error?: {message?: string}} | null;
  if (!response.ok) throw new ApiError(body?.error?.message || `Request failed with HTTP ${response.status}.`, response.status, body);
  return body as T;
}

export const queries = {
  dashboard: () => api<DashboardData>('/dashboard'),
  health: () => api<{status: string; database: string; queue: string; timestamp: string}>('/health'),
  applications: (params: URLSearchParams) => api<Paginated<Application>>(`/applications?${params}`),
  application: (id: string) => api<Application>(`/${encodeURIComponent(id)}`),
  batches: (page = 1) => api<Paginated<Batch>>(`/batches?page=${page}&pageSize=20`),
  batch: (id: string) => api<Batch>(`/batches/${encodeURIComponent(id)}`),
  failures: () => api<Array<{application: Application; workflow: Workflow; retryEligible: boolean; reason: string}>>('/failures'),
  events: (after = 0) => api<ProcessingEvent[]>(`/events?after=${after}&limit=100`)
};

export const mutations = {
  createBatch: (entries: JobInput[], concurrency: number) => api<Batch>('/batches', {
    method: 'POST', body: JSON.stringify({entries, concurrency, idempotencyKey: crypto.randomUUID()})
  }),
  retryWorkflow: (id: string) => api<Batch>(`/workflows/${encodeURIComponent(id)}/retry`, {
    method: 'POST', body: JSON.stringify({idempotencyKey: crypto.randomUUID()})
  }),
  retryBatch: (id: string) => api<Batch>(`/batches/${encodeURIComponent(id)}/retry`, {method: 'POST', body: '{}'}),
  importSheets: () => api<{totalRows: number; imported: number; duplicates: number}>('/import/google-sheets', {method: 'POST', body: '{}'})
};
