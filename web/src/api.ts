export interface Memory {
  id: string;
  namespace: string;
  key: string;
  content: string;
  type: 'fact' | 'preference' | 'decision' | 'status';

  tags: string[];
  device_tags: string[];
  pinned: boolean;
  expires_at: string | null;
  version: number;
  updated_at?: string;
  sources?: { client_id: string; reference: string; excerpt: string; created_at: string }[];
}
export interface History {
  version: number;
  client_id: string;
  created_at: string;
  snapshot: Memory;
}
export interface Status {
  status: string;
  checked_at: string;
  version: string;
  uptime_seconds: number;
  database: string;
  qdrant: string;
  search_mode: string;
  memories: { active: number; pinned: number; expired: number } | null;
  embedding: {
    model: string | null;
    state: string;
    dimensions: number | null;
    dtype: string | null;
    error_code: string | null;
  };
  index: { total: number; indexed: number; queued: number; failed: number } | null;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public data: { error?: string; memory?: Memory; status?: string },
  ) {
    super(data.error ?? data.status ?? 'request_failed');
  }
}
export async function request<T>(
  path: string,
  body?: unknown,
  csrf?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    signal,
    headers: {
      'X-Uni-Memory-UI': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}
export function operationId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (n) => n.toString(16).padStart(2, '0')).join(
    '',
  );
}
export const types = { fact: '事实', preference: '偏好', decision: '决策', status: '状态' };
export function timestamp(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
export function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
