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
export const del = <T = any>(url: string) => api<T>('DELETE', url);

const MESSAGES: Record<string, string> = {
  WINDOW_FULL: 'That window is full.', SESSION_NOT_FOUND: 'That window no longer exists. Refresh and pick again.', PAST_WINDOW: 'You cannot move a booking into the past.', NOT_MOVABLE: 'Only bookings that have not arrived can be moved.',  ALREADY_ARRIVED: 'This patient has already arrived.', SERVICE_NOT_FOUND: 'That visit type is not available.', SERVICE_NOT_OFFERED: 'That doctor does not offer this visit type.', NOT_A_REQUEST: 'This is not a pending request any more.',  NOT_OPEN: 'This booking is already closed.', ONLINE_BOOKING_OFF: 'Online booking is not open right now. Please call the clinic.', SLOT_TAKEN: 'That time was just taken. Please pick another.',  TOO_MANY_OPEN_BOOKINGS: 'You already have two upcoming bookings. Please call the clinic to book more.', TOO_MANY_REQUESTS: 'Too many tries. Please wait a few minutes.', TOO_LATE_TO_CANCEL: 'It is too close to the visit to change it online. Please call the clinic.',  CANNOT_CONFIRM: 'This booking cannot be confirmed now.', CANNOT_RESCHEDULE: 'This booking cannot be changed online. Please call the clinic.', CLINIC_NOT_FOUND: 'Clinic not found. Check the link.',
  ALREADY_BOOKED: 'This patient is already booked in this window.',
  DUPLICATE: 'That already exists.',
  BAD_RULE: 'That rule is not valid, so it was not saved.',
  TOO_MANY_ATTEMPTS: 'Too many wrong attempts. Please wait a few minutes and try again.',
  BAD_CREDENTIALS: 'That email or password is not right.',
  FUTURE_DATE: 'The date cannot be in the future.',
  TOO_OLD: 'That date is too far in the past.',
  BAD_CATEGORY: 'Please pick a valid category.',
  CANNOT_GRANT: 'You can only give a role permissions you have yourself.',
  ROLE_IN_USE: 'Some staff still have this role. Change their role first.',
  UNKNOWN_ROLE: 'That role does not exist.',
  OWNER_IS_FIXED: 'The owner always has full access and cannot be changed.',
  CANNOT_DEACTIVATE_SELF: 'You cannot deactivate your own account.',
  NOT_FOUND: 'That record was not found. It may have been removed.',
  BAD_ID: 'That record was not found.',
  IN_USE: 'That is in use elsewhere, so it cannot be removed.',
  PASSWORD_REQUIRED: 'Please set a password.',
  PATIENT_REQUIRED: 'Pick or register a patient first.',
  BAD_REQUEST: 'That request was not understood.',
  UNAUTHENTICATED: 'Please sign in again.',
};
const FIELD_NAMES: Record<string, string> = { reason: 'Reason', note: 'Note', cancelReason: 'Reason', minutes: 'Length', color: 'Colour', pricePaise: 'Price', places: 'Places', fullName: 'Name', phone: 'Phone', ageYears: 'Age', amountPaise: 'Amount', description: 'Description', name: 'Name', email: 'Email', password: 'Password' };
/** Turn any API failure into one plain sentence a receptionist can act on. */
export function errText(e: any): string {
  const b = e?.body; if (!b) return e?.message && !/^HTTP \d+$/.test(e.message) ? e.message : 'Could not reach the server. Check the connection and try again.';
  const code: string = b.code ?? '';
  if (code.startsWith('FORBIDDEN')) return "You don't have permission to do that.";
  if (code === 'ALREADY_CHECKED_IN') return `Already checked in today${b.opNumber ? ` (token ${b.opNumber})` : ''}.`;
  if (code === 'VALIDATION' && Array.isArray(b.errors) && b.errors[0]) {
    const x = b.errors[0]; const key = [...(x.path ?? [])].reverse().find((p: any) => typeof p === 'string'); const f = (key && FIELD_NAMES[key]) ?? (key ? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c: string) => c.toUpperCase()) : 'A field');
    if (x.message === 'PHONE_10_DIGITS' || (key === 'phone' && x.code === 'invalid_string')) return 'Phone must be 10 digits.';
    if (x.code === 'too_big') return `${f} is too ${typeof x.maximum === 'number' && x.type === 'string' ? 'long' : 'large'} (most ${x.maximum}).`;
    if (x.code === 'too_small') return x.type === 'string' ? (x.minimum <= 1 ? `${f} is required.` : `${f} is too short (at least ${x.minimum} letters).`) : `${f} is too small.`;
    return `${f} is not valid.`;
  }
  return MESSAGES[code] ?? (b.message && code === 'INTERNAL' ? b.message : code ? 'Something went wrong. Please try again.' : 'Failed');
}
