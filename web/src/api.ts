import { QueryClient, useQuery } from '@tanstack/react-query';

export const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } });

export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.code ?? `HTTP ${status}`); } }

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch('/api' + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && location.pathname !== '/login') location.href = '/login';
    throw new ApiError(r.status, data);
  }
  return data;
}
export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body);
export const patch = <T = any>(url: string, body?: unknown) => api<T>('PATCH', url, body);

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => get('/config'), staleTime: 5 * 60_000 });
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => get('/me'), retry: false });

export const rupees = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export const uuid = () => crypto.randomUUID();
