/** Counts writes: every POST/PATCH/PUT/DELETE answer bumps it (app.ts, once the write has committed). A short cache keeps the count it was
 *  made at and is thrown away as soon as anything has been saved since, so a cached answer is never older than the last change. */
export const writes = { n: 0 };

/** Remember an answer for a short while, per key, until the next write. One server process: a second process would keep its own. */
export function shortCache<T>(ttlMs: number) {
  const m = new Map<string, { at: number; gen: number; v: T }>();
  return async (key: string, make: () => Promise<T>): Promise<T> => {
    const hit = m.get(key);
    if (hit && hit.gen === writes.n && Date.now() - hit.at < ttlMs) return hit.v;
    const gen = writes.n; const v = await make();
    if (gen === writes.n) { if (m.size > 1000) m.clear(); m.set(key, { at: Date.now(), gen, v }); } // a write landed meanwhile: do not keep it
    return v;
  };
}
