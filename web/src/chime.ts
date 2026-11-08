/** A short two-note chime for "someone is being called in". No audio file: the browser makes the tone. Silent until the person has clicked somewhere once, as browsers require. */
let ctx: AudioContext | null = null;
export function chime(kind: 'call' | 'ready' = 'call') {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const notes = kind === 'call' ? [[880, 0], [1175, 0.16]] : [[660, 0], [880, 0.14], [1175, 0.28]];
    for (const [f, at] of notes) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + at; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      o.start(t0); o.stop(t0 + 0.4);
    }
  } catch { /* no audio on this device */ }
}

/** Calls `fn` once per new key: the caller passes the ids it sees now; ids seen before are ignored. The first observation seeds the set without firing. */
export function makeOnceWatcher<T extends string>() {
  const seen = new Set<T>(); let primed = false;
  return (keys: T[], fn: (fresh: T[]) => void) => {
    const fresh = keys.filter((k) => !seen.has(k)); keys.forEach((k) => seen.add(k));
    if (!primed) { primed = true; return; }
    if (fresh.length) fn(fresh);
  };
}
