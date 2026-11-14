// A procedure's standard price for N sessions, its session plan, and how long a course of it is valid.
import { addDays, addMonths } from './core.js';

type Proc = { pricePaise: number | null; totalPaise?: number | null; pricing?: string; typicalSittings?: number; sessions?: { name: string; minutes: number; gapDays: number; note?: string }[]; validFor?: number | null; validUnit?: string | null } | null | undefined;

/** Upfront with its full set of sessions: the total set in Settings; otherwise the price per session × sessions. */
export const stdTotal = (p: Proc, sittings: number) =>
  p?.pricing === 'upfront' && p.totalPaise && sittings === (p.sessions?.length || p.typicalSittings) ? p.totalPaise : (p?.pricePaise ?? 0) * sittings;

/** Session k (1-based) as set up in Settings, if it is. */
export const sessionDef = (p: Proc, k: number) => p?.sessions?.[k - 1];

/** The day a course agreed today stays valid till, from the procedure's "valid for"; null = no expiry. */
export const validTill = (p: Proc, today: string) =>
  p?.validFor ? (p.validUnit === 'days' ? addDays(today, p.validFor) : addMonths(today, p.validFor)) : null;
