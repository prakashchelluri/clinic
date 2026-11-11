import { MutationCache, QueryClient, useQuery } from '@tanstack/react-query';
import { toast } from './ui';
import { OFFLINE_MSG, clearOfflineCache, markReachable, startOfflineCache } from './offline';

// Writes are never held back and replayed later (networkMode 'always'): offline they fail at once and say so.
// A write with no error handler of its own still tells the person it was not saved.
export const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 }, mutations: { networkMode: 'always' } },
  mutationCache: new MutationCache({ onError: (e, _v, _c, m) => { if (!m.options.onError) toast(errText(e), 'err'); } }) });
startOfflineCache(qc);
export { clearOfflineCache };

export class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.code ?? `HTTP ${status}`); } }

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let r: Response;
  try { r = await fetch('/api' + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { markReachable(false); throw new ApiError(0, { code: 'OFFLINE' }); } // no answer at all: the internet or the server is down
  markReachable(true);
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) toLogin();
    // Outside the clinic's internet: the sign-in page explains it.
    if (r.status === 403 && data?.code === 'IP_NOT_ALLOWED' && location.pathname !== '/login') location.href = `/login?blocked=${encodeURIComponent(data.ip ?? '')}`;
    throw new ApiError(r.status, data);
  }
  return data;
}
/** Signed out (401): let open forms save what they can, then go to sign-in. Public screens (TV, patient link) never redirect. */
let leaving = false;
function toLogin() {
  if (leaving || /^\/(login|display|a)(\/|$)/.test(location.pathname)) return;
  leaving = true; window.dispatchEvent(new Event('app:save-now')); clearOfflineCache();
  setTimeout(() => { location.href = '/login'; }, 400);
}
export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body);
export const patch = <T = any>(url: string, body?: unknown) => api<T>('PATCH', url, body);

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => get('/config'), staleTime: 5 * 60_000 });
/** Who is signed in. A dropped connection is retried (3 tries, then every 10 s) instead of being read as "signed out"; only a 401/403 stops. */
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => get('/me'),
  retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 403)) && n < 3,
  retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
  refetchInterval: (q) => (q.state.status === 'error' && !(q.state.error instanceof ApiError && (q.state.error.status === 401 || q.state.error.status === 403)) ? 10_000 : false) });

export const rupees = (paise: number) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
export { fmtTime } from './ui'; // one time format for the app: "10:30 am", clinic time
export const uuid = () => crypto.randomUUID();
export const del = <T = any>(url: string) => api<T>('DELETE', url);

const MESSAGES: Record<string, string> = {
  NEEDS_PRESCRIPTION: "This medicine needs a doctor's prescription. Open the patient's prescription, or remove it from the bill.",
  MORE_THAN_PRESCRIBED: 'That is more than the doctor prescribed. Say why more is given.',
  WINDOW_FULL: 'That time is full.', SESSION_NOT_FOUND: 'That window no longer exists. Refresh and pick again.', PAST_WINDOW: 'You cannot move a booking into the past.', NOT_MOVABLE: 'Only bookings that have not arrived can be moved.',  ALREADY_ARRIVED: 'This patient has already arrived.', SERVICE_NOT_FOUND: 'That visit type is not available.', SERVICE_NOT_OFFERED: 'That doctor does not offer this visit type.',  NOT_OPEN: 'This booking is already closed.', ONLINE_BOOKING_OFF: 'Online booking is not open right now. Please call the clinic.', SLOT_TAKEN: 'That time was just taken. Please pick another.',  TOO_MANY_OPEN_BOOKINGS: 'You already have two upcoming bookings. Please call the clinic to book more.', TOO_MANY_REQUESTS: 'Too many tries. Please wait a few minutes.', TOO_LATE_TO_CANCEL: 'It is too close to the visit to change it online. Please call the clinic.',  CANNOT_CONFIRM: 'This booking cannot be confirmed now.', CANNOT_RESCHEDULE: 'This booking cannot be changed online. Please call the clinic.', CLINIC_NOT_FOUND: 'Clinic not found. Check the link.',
  ALREADY_BOOKED: 'This patient is already booked in this window.',
  SAMPLE_ALREADY_LOADED: 'Test data is already loaded in this clinic.', LOAD_BASE_SAMPLE_FIRST: 'Load the sample patients first.',
  PHOTO_CONSENT_REQUIRED: "Record the patient's photo consent first.", SITTING_NOT_FOR_PATIENT: 'That procedure sitting belongs to another patient.', TOO_LARGE: 'That file is too large (10 MB at most).', UNSUPPORTED_TYPE: 'Only JPG, PNG, WebP and PDF files can be added.',
  DUPLICATE: 'That already exists.',
  IP_NOT_ALLOWED: 'This can be used only from the clinic’s internet. If you are at the clinic, the owner can allow this connection.', ADD_AN_ADDRESS: 'Add the clinic’s internet address first, or nobody but the owner could work.', RANGE_IPV4_ONLY: 'Ranges work only for addresses like 106.51.0.0.', LISTS_OWNER_ONLY: 'Only the owner can print or download lists of patients.', 'FORBIDDEN:owner': 'Only the clinic owner can change this.', 'FORBIDDEN:audit': 'Only the owner and admins can see the audit log.',
  NOT_WORKING: 'The doctor is not working that day.', PAST_DAY: 'That day is over. Pick today or later.', OVERLAPS_HOURS: 'Those hours overlap the doctor’s usual hours. Pick a time after they end.', TIME_REQUIRED: 'Pick a time.', OUTSIDE_HOURS: 'Pick a time inside the doctor’s hours for that day.',
  BAD_RULE: 'That rule is not valid, so it was not saved.',
  TOO_MANY_ATTEMPTS: 'Too many wrong attempts. Please wait a few minutes and try again.',
  BAD_CREDENTIALS: 'That email or password is not right.',
  FUTURE_DATE: 'The date cannot be in the future.',
  TOO_OLD: 'That date is too far in the past.',
  BAD_CATEGORY: 'Please pick a valid category.',
  CANNOT_GRANT: 'You can only give a role permissions you have yourself.',
  ROLE_IN_USE: 'Some staff still have this role. Change their role first.',
  UNKNOWN_ROLE: 'That role does not exist.',
  OWNER_ONLY_GRANT: 'Only an owner can make someone an owner.', OWNER_ONLY_EDIT: 'Only an owner can change an owner’s account.', LAST_OWNER: 'The clinic must keep at least one active owner.',
  NOT_A_TEST_CLINIC: 'Test data can only be used on a test clinic.', WRONG_CURRENT_PASSWORD: 'Your current password is not right.', SAME_PASSWORD: 'Pick a new password that is different from the old one.',
  NO_VALUES: 'Enter at least one value, or attach the report.', PRICE_NEEDED: 'Set a price first.', DISCOUNT_ABOVE_CAP_NEEDS_OWNER: 'That discount is above the clinic’s limit. The owner must approve it.',
  MORE_THAN_DUE: 'That is more than what is due.', MORE_THAN_FEE: 'That is more than the fee.', DAY_CLOSED: 'That day is closed. Ask the owner to reopen it.', ALREADY_REFUNDED: 'This was already refunded.',
  OWNER_IS_FIXED: 'The owner always has full access and cannot be changed.',
  CANNOT_DEACTIVATE_SELF: 'You cannot deactivate your own account.',
  WOULD_LOCK_THIS_COMPUTER: 'That would stop this computer: it is one of the clinic’s addresses. Keep it on the list, or turn off “Work only from the clinic” first.',
  THIS_COMPUTER_NOT_LISTED: 'This computer is not on the list. Add it first, or say you are away from the clinic.',
  MUST_CHANGE_PASSWORD: 'Pick your own password first.', USE_CHANGE_MY_PASSWORD: 'Use “Change my password” for your own account.',
  ONLY_OWNER_MERGES: 'Only the owner can merge two patient records.', SAME_PATIENT: 'Pick a different record to merge.', ALREADY_MERGED: 'That record was already merged into another one.',
  NOT_FOUND: 'That record was not found. It may have been removed.',
  BAD_ID: 'That record was not found.',
  IN_USE: 'That is in use elsewhere, so it cannot be removed.',
  PASSWORD_REQUIRED: 'Please set a password.',
  PATIENT_REQUIRED: 'Pick or register a patient first.',
  REFERENCE_REQUIRED: 'UPI and card payments need the reference number (4 characters or more).', RECEIVED_TOO_LOW: 'Cash received is less than the cash part of the bill.', DUPLICATE_METHOD: 'Use each payment mode once.',
  BATCH_NOT_SELLABLE: 'That batch is empty or expired. Pick another.', RX_NOT_FOR_PATIENT: 'That prescription belongs to another patient.', NOT_ON_THIS_RX: 'That line is not on this prescription.', DISCOUNT_TOO_BIG: 'The discount is more than the bill.', BAD_AMOUNT: 'The bill cannot be zero.',
  BILL_PHOTO_REQUIRED: "Add a photo of the vendor's bill.", BILL_NO_REQUIRED: "Enter the vendor's bill number.", BILL_TOTAL_REQUIRED: 'Enter the bill total from the paper bill.', BILL_ALREADY_RECEIVED: 'This bill number was already received from this vendor.',
  ORDER_CLOSED: 'This order is already closed.', NOTHING_RECEIVED: 'A line has no quantity.', ALREADY_DECIDED: 'Someone has already decided on this delivery.', REASON_REQUIRED: 'Please give a reason.',
  COUNT_OPEN: 'A stock count is already open. Finish it first.', NOTHING_TO_COUNT: 'Nothing of this medicine is on the shelf to count.', COUNT_NOT_OPEN: 'This count is not open for counting.', NOT_A_GAP: 'That batch has no gap to decide.', CANNOT_CANCEL: 'Only an open order can be cancelled.',
  DUPLICATE_LINE: 'The same medicine is on the order twice.', VENDOR_NOT_FOUND: 'Pick a vendor.', NOTHING_TO_RETURN: 'Everything on this bill is already returned.', VOID_TOO_LATE: 'A bill can be voided for ten minutes. After that, take the items back from Bills.', ALREADY_RETURNED: 'Something on this bill was already returned. Take the rest back from Bills.', VOID_SPLIT: 'A bill paid two ways is cancelled from Bills by the owner.', BAD_RANGE: '“From” is after “to”.', PAYMENT_REQUIRED: 'Choose how the patient is paying.',
  BAD_REQUEST: 'That request was not understood.',
  UNAUTHENTICATED: 'Please sign in again.',
  OFFLINE: OFFLINE_MSG,
  CONSENT_NEEDED: 'No consent is on file for this procedure. Get the paper consent form signed first.',
};
const FIELD_NAMES: Record<string, string> = { reason: 'Reason', note: 'Note', cancelReason: 'Reason', minutes: 'Length', color: 'Colour', pricePaise: 'Price', places: 'Places', fullName: 'Name', phone: 'Phone', ageYears: 'Age', amountPaise: 'Amount', description: 'Description', name: 'Name', email: 'Email', password: 'Password', weight_kg: 'Weight', height_cm: 'Height', temp_f: 'Temperature', spo2: 'SpO₂', pulse: 'Pulse', priority: 'Queue priority' };
/** Turn any API failure into one plain sentence a receptionist can act on. */
export function errText(e: any): string {
  const b = e?.body; if (!b) return e?.message && !/^HTTP \d+$/.test(e.message) ? e.message : 'Could not reach the server. Check the connection and try again.';
  const code: string = b.code ?? '';
  if (code.startsWith('FORBIDDEN')) return "You don't have permission to do that.";
  if (code === 'ROOM_FULL') return `${b.inside} patients are already inside with the doctor (the room takes ${b.max}). Send the next one in when someone comes out.`;
  if (code === 'WITH_JUNIOR') return 'With the junior doctor right now; send them in after the screening.';
  if (code === 'ALREADY_CHECKED_IN') return `Already checked in today${b.opNumber ? ` (token ${b.opNumber})` : ''}.`;
  if (code === 'NOT_ENOUGH_STOCK') return `${b.name ?? b.batchNo ?? 'That item'}: only ${b.onHand ?? 0} in stock.`;
  if (code === 'BILL_TOTAL_MISMATCH') return `The lines add up to ₹${((b.computedPaise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}, not the bill total. Check the rates, quantities and discounts.`;
  if (code === 'EXPIRED_BATCH') return `${b.name}: batch ${b.batchNo} has already expired.`;
  if (code === 'DISCOUNT_NEEDS_OWNER') return `Discounts above ${b.maxPct}% need the owner.`;
  if (code === 'PAYMENTS_DO_NOT_ADD_UP') return `The payments must add up to ₹${((b.totalPaise ?? 0) / 100).toLocaleString('en-IN')}.`;
  if (code === 'NO_PRICE') return `${b.name} has no price. Set it under Settings → Medicines.`;
  if (code === 'MORE_THAN_SOLD') return `More ${b.name} than was sold on this bill (or already returned).`;
  if (code === 'BATCH_EXPIRY_DIFFERS') return `Batch ${b.batchNo} is already in stock with a different expiry. Check the batch number.`;
  if (code === 'COUNT_INCOMPLETE') return `${b.left} batch${b.left === 1 ? '' : 'es'} still to count.`;
  if (code === 'VALIDATION' && Array.isArray(b.errors) && b.errors[0]) {
    const x = b.errors[0]; const key = [...(x.path ?? [])].reverse().find((p: any) => typeof p === 'string'); const f = (key && FIELD_NAMES[key]) ?? (key ? key.replace(/([A-Z])/g, ' $1').replace(/^./, (c: string) => c.toUpperCase()) : 'A field');
    if (x.message === 'BP_FORMAT') return 'BP should read like 120/80.';
    if (x.message === 'PHONE_10_DIGITS' || (key === 'phone' && x.code === 'invalid_string')) return 'Phone must be 10 digits.';
    if (x.code === 'too_big') return `${f} is too ${typeof x.maximum === 'number' && x.type === 'string' ? 'long' : 'large'} (most ${/Paise$/.test(key ?? '') && typeof x.maximum === 'number' ? '₹' + (x.maximum / 100).toLocaleString('en-IN') : x.maximum}).`;
    if (x.code === 'too_small') return x.type === 'string' ? (x.minimum <= 1 ? `${f} is required.` : `${f} is too short (at least ${x.minimum} letters).`) : `${f} is too small.`;
    return `${f} is not valid.`;
  }
  return MESSAGES[code] ?? (b.message && code === 'INTERNAL' ? b.message : code ? 'Something went wrong. Please try again.' : 'Failed');
}

/** A list of patients leaving the app (print or download): recorded in the audit log first; refused for roles the owner has not allowed. */
export const listOut = (what: string, count: number | undefined, act: () => void) =>
  post('/audit/event', { kind: 'print', what, count }).then(act, (e) => toast(errText(e), 'err'));
/** A number the app may dial: hidden numbers (98••• ••345) cannot be called from this account. */
export const dialable = (phone?: string | null) => !!phone && !phone.includes('•');
