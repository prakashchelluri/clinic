import { sql } from 'drizzle-orm';
import { charge } from '../db/schema.js';

/** What is still owed on a charge: its amount less every payment on it (refunds and credits included). The one rule for "due" on every page. */
export const chargeBalance = sql<number>`greatest(${charge.amountPaise} - coalesce((select sum(p.amount_paise) from payment p where p.charge_id = ${charge.id}), 0), 0)::int`;
