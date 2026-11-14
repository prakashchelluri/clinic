// A package is a bundle of procedures (each with its sittings and gap) sold at one price, valid for some months.
// The doctor adds it on the Rx pad; each procedure becomes its own plan with a share of the package price.
import { z } from 'zod';

export type PkgItem = { procedureId: string; sittings: number; intervalDays: number };
export type Pkg = { id: string; name: string; items: PkgItem[]; pricePaise: number; validMonths: number; active: boolean };

export const PackagesIn = z.array(z.object({
  id: z.string().min(1).max(40), name: z.string().trim().min(1).max(60),
  items: z.array(z.object({ procedureId: z.string().uuid(), sittings: z.number().int().min(1).max(60), intervalDays: z.number().int().min(0).max(365) })).min(1).max(10)
    .refine((xs) => new Set(xs.map((x) => x.procedureId)).size === xs.length, 'A procedure is in the package twice'),
  pricePaise: z.number().int().min(1), validMonths: z.number().int().min(1).max(60), active: z.boolean().default(true),
})).max(100);

/** The clinic's packages; one saved before bundles (one procedure × sittings) reads as a bundle of one. */
export function packagesOf(settings: any): Pkg[] {
  return ((settings?.packages ?? []) as any[]).map((k) => k.items ? { active: true, validMonths: 12, ...k }
    : { id: k.id, name: k.name, items: [{ procedureId: k.procedureId, sittings: k.sittings, intervalDays: k.intervalDays ?? 0 }], pricePaise: k.pricePaise, validMonths: 12, active: true });
}

/** The package price split across its procedures in proportion to their full prices, in whole rupees; the last one takes the rounding, so the shares add up exactly. */
export function shares(pricePaise: number, lists: number[]): number[] {
  const full = lists.reduce((s, x) => s + x, 0);
  if (!full) { const each = Math.floor(pricePaise / lists.length); return lists.map((_, i) => i === lists.length - 1 ? pricePaise - each * (lists.length - 1) : each); }
  let left = pricePaise;
  return lists.map((x, i) => { if (i === lists.length - 1) return left; const s = Math.round(pricePaise * x / full / 100) * 100; left -= s; return s; });
}
