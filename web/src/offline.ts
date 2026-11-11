import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/* Offline basics: the last loaded front desk queue, doctor's Today and open prescription pad stay readable when the internet drops,
 * with a strip saying when they were loaded. Writes are never queued: they fail with a plain "not saved" message. */

// Query keys (first part) kept on this computer: who is signed in, the queue and day, the pad and the patient's record.
const KEEP = new Set(['me', 'config', 'frontdesk', 'calendar', 'psessions', 'orders', 'encounter', 'timeline', 'print']);
const PREFIX = 'cc.q:';
const MAX_AGE = 12 * 3600_000; // yesterday's queue is no use

// ponytail: localStorage (~5 MB) with one entry per query; IndexedDB if pads with many photos ever overflow it.
let lastOk = 0; let reachable = true; const subs = new Set<() => void>();
const ping = () => subs.forEach((f) => f());
/** Called by api(): any answer from the server means it is reachable; a failed fetch means it is not. */
export function markReachable(ok: boolean) { if (ok) lastOk = Date.now(); if (ok !== reachable) { reachable = ok; ping(); } }

export function startOfflineCache(qc: QueryClient) {
  try {
    // Started with no internet: show what was loaded last time (the first good fetch replaces it).
    if (!navigator.onLine) for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(PREFIX)) continue;
      const v = JSON.parse(localStorage.getItem(k)!);
      if (Date.now() - v.at < MAX_AGE) { qc.setQueryData(v.key, v.data, { updatedAt: v.at }); lastOk = Math.max(lastOk, v.at); }
    }
  } catch { /* storage blocked or bad entry: start empty */ }
  qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || !KEEP.has(String(e.query.queryKey[0]))) return;
    try { localStorage.setItem(PREFIX + JSON.stringify(e.query.queryKey), JSON.stringify({ key: e.query.queryKey, data: e.query.state.data, at: e.query.state.dataUpdatedAt })); }
    catch { /* full or blocked: reading offline is a nicety */ }
  });
  window.addEventListener('online', ping); window.addEventListener('offline', ping);
  // the app shell, so a reload with no internet still opens (built app only; the dev server reloads itself)
  if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* not allowed here: online only */ });
}

/** Signing out (or another person signing in) leaves no patient data on this computer. */
export function clearOfflineCache() {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k); } catch { /* blocked */ }
}

/** null when online; otherwise the time the shown data was loaded ("10:42"), or '' when nothing was. */
export function useOffline(): string | null {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => (navigator.onLine && reachable ? null : lastOk ? new Date(lastOk).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''), () => null);
}

export const OFFLINE_MSG = 'No internet connection. Anything you just changed was not saved; try again when it is back.';
