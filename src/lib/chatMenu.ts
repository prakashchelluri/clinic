// Tap-to-book on WhatsApp, in as few taps as possible. "Hi" gets the next free time with [Book this] [Other times]:
// a registered patient (or a new one, under their WhatsApp profile name) books in two taps. Other times is one list of
// the next open hours across days, with "Another day…" and "For someone else". The problem is asked after booking, and
// is optional. "My visit" shows the booking with Confirm / Change time / Cancel. No AI in any of these steps: anything
// typed outside them goes to the assistant as before (lib/assistant.ts).
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { appointment, chat } from '../db/schema.js';
import { HttpError } from './auth.js';
import { todayIn } from './core.js';
import { appointmentView, bookingSettings } from './booking.js';
import { cancelByPatient, confirmByPatient, moveByPatient } from '../modules/public.js';
import { BY, bookFromChat, inTenant, mine, myVisits, noteVisit, openWindows, patientsOn, say, visitOut, type Menu } from './assistant.js';

type Tenant = Parameters<typeof say>[1];
type Chat = typeof chat.$inferSelect;
type Visit = ReturnType<typeof visitOut>;
type Lang = 'en' | 'te';
/** Where the patient is in the menu; kept on the chat for 2 hours. */
type Flow = {
  lang: Lang; at: number; step?: 'who' | 'name' | 'note';
  patientId?: string; newName?: string; moving?: string; another?: boolean;
  pendingWindow?: string; // a time tapped before the name was known: booked once the name comes
  noteFor?: string;       // the visit just booked, waiting for "what is it about?" (optional)
};

const FLOW_MS = 2 * 3_600_000;
const TELUGU = /[ఀ-౿]/;
const GREETING = /^\s*(hi+|hello+|hey+|hai|helo|namaste|namaskar(am)?|good\s+(morning|afternoon|evening)|menu|start|నమస్తే|నమస్కారం|హాయ్|హలో|नमस्ते)\s*[!.,🙏🏻]*\s*$/iu;
const NAME_LEAD = /^(my name is|name is|i am|i'm|this is|name\s*[:-]?|naa peru|na peru|నా పేరు)\s*/i;
/** A WhatsApp profile name usable as the patient's name: letters, spaces, dots; emojis and the like dropped. */
const cleanName = (s?: string) => { const n = String(s ?? '').replace(/[^\p{L}\p{M} .'-]/gu, '').replace(/\s+/g, ' ').trim(); return (n.match(/\p{L}/gu) ?? []).length >= 2 ? n.slice(0, 60) : undefined; };

const TXT = {
  en: {
    hello: (name: string | null, clinic: string, back: boolean) => name ? `Hello ${name}, welcome ${back ? 'back ' : ''}to ${clinic}.` : `Hello, welcome to ${clinic}.`,
    help: 'How can we help you?',
    book: 'Book a visit', visit: 'My visit', ask: 'Ask a question',
    who: 'Who is the visit for?', choose: 'Choose', someoneElse: 'Someone else',
    name: "Please type the patient's name.",
    next: (d: string, w: string, doc: string | null) => `Next free time: ${d}, ${w}${doc ? ` with ${doc}` : ''}.`,
    bookThis: 'Book this', other: 'Other times', otherDay: 'Another day…', forElse: 'For someone else',
    times: 'Open times. Please choose one.', timesBtn: 'Choose a time',
    day: 'Please choose a day.', dayBtn: 'Choose a day', open: (n: number) => `${n} time${n > 1 ? 's' : ''} open`,
    time: (d: string) => `Open times for ${d}. Please choose one.`,
    none: 'Sorry, there are no open times in the next 7 days. Our front desk will reply here soon.',
    booked: (v: Visit, d: string, early: number) => `Booked: ${v.patient}, ${d}, ${win(v.window)} with ${v.doctor}. Please come ${early} minutes before your time.`,
    about: 'What is it about? Type a few words for the doctor (optional).', skip: 'Skip',
    noted: 'Thank you, noted for the doctor.', seeYou: 'OK, see you then.',
    moved: (v: Visit, d: string, early: number) => `Changed: ${v.patient}, now ${d}, ${win(v.window)} with ${v.doctor}. Please come ${early} minutes before your time.`,
    full: 'Sorry, that time has just filled up. Please choose another.',
    yourVisit: (v: Visit, d: string) => `Your visit: ${d}, ${win(v.window)} with ${v.doctor}.`,
    hasVisit: (v: Visit, d: string) => `${v.patient} already has a visit on ${d}, ${win(v.window)}. Book another visit, or change this one?`,
    another: 'Book another', thatDay: 'There is already a visit on that day. Please choose another.',
    card: (v: Visit, d: string) => `${v.patient}: ${d}, ${win(v.window)} with ${v.doctor}.`,
    confirm: 'Confirm', move: 'Change time', cancel: 'Cancel visit',
    noVisit: 'You have no upcoming visit.', which: 'Which visit?',
    cancelAsk: 'Cancel this visit?', yesCancel: 'Yes, cancel', keep: 'Keep it',
    cancelled: 'Your visit is cancelled.', kept: 'OK, your visit stays as it is.', confirmed: (d: string) => `Thank you, your visit on ${d} is confirmed.`,
    askQ: 'Please type your question.',
    inClinic: 'You are at the clinic now. Please ask at the front desk.',
    locked: 'This visit can no longer be changed here. Please call the clinic.',
    today: 'Today', tomorrow: 'Tomorrow',
  },
  te: {
    hello: (name: string | null, clinic: string, back: boolean) => name ? `నమస్తే ${name} గారు, ${clinic}కి ${back ? 'మళ్ళీ ' : ''}స్వాగతం.` : `నమస్తే, ${clinic}కి స్వాగతం.`,
    help: 'మీకు ఎలా సహాయం చేయగలం?',
    book: 'బుకింగ్', visit: 'నా అపాయింట్‌మెంట్', ask: 'ప్రశ్న అడగండి',
    who: 'అపాయింట్‌మెంట్ ఎవరి కోసం?', choose: 'ఎంచుకోండి', someoneElse: 'వేరే వ్యక్తి',
    name: 'దయచేసి పేషెంట్ పేరు టైప్ చేయండి.',
    next: (d: string, w: string, doc: string | null) => `తదుపరి ఖాళీ సమయం: ${d}, ${w}${doc ? `, ${doc}` : ''}.`,
    bookThis: 'ఇది బుక్ చేయండి', other: 'ఇతర సమయాలు', otherDay: 'వేరే రోజు…', forElse: 'వేరే వ్యక్తి కోసం',
    times: 'ఖాళీ సమయాలు. ఒకటి ఎంచుకోండి.', timesBtn: 'సమయం ఎంచుకోండి',
    day: 'దయచేసి ఒక రోజు ఎంచుకోండి.', dayBtn: 'రోజు ఎంచుకోండి', open: (n: number) => `${n} సమయాలు ఖాళీ`,
    time: (d: string) => `${d} ఖాళీ సమయాలు. ఒకటి ఎంచుకోండి.`,
    none: 'క్షమించండి, వచ్చే 7 రోజుల్లో ఖాళీ సమయాలు లేవు. మా ఫ్రంట్ డెస్క్ త్వరలో ఇక్కడ సమాధానం ఇస్తారు.',
    booked: (v: Visit, d: string, early: number) => `బుక్ అయింది: ${v.patient}, ${d}, ${win(v.window)}, ${v.doctor}. దయచేసి మీ సమయానికి ${early} నిమిషాల ముందు రండి.`,
    about: 'ఏ సమస్య కోసం? డాక్టర్ గారి కోసం కొన్ని మాటలు టైప్ చేయండి (తప్పనిసరి కాదు).', skip: 'వద్దు',
    noted: 'ధన్యవాదాలు, డాక్టర్ గారికి తెలియజేశాము.', seeYou: 'సరే, అప్పుడు కలుద్దాం.',
    moved: (v: Visit, d: string, early: number) => `మార్చాము: ${v.patient}, ఇప్పుడు ${d}, ${win(v.window)}, ${v.doctor}. దయచేసి మీ సమయానికి ${early} నిమిషాల ముందు రండి.`,
    full: 'క్షమించండి, ఆ సమయం ఇప్పుడే నిండిపోయింది. దయచేసి మరొకటి ఎంచుకోండి.',
    yourVisit: (v: Visit, d: string) => `మీ అపాయింట్‌మెంట్: ${d}, ${win(v.window)}, ${v.doctor}.`,
    hasVisit: (v: Visit, d: string) => `${v.patient} గారికి ఇప్పటికే ${d}, ${win(v.window)} అపాయింట్‌మెంట్ ఉంది. ఇంకొకటి బుక్ చేయాలా, లేదా దీన్ని మార్చాలా?`,
    another: 'ఇంకొకటి బుక్', thatDay: 'ఆ రోజు ఇప్పటికే అపాయింట్‌మెంట్ ఉంది. దయచేసి మరొకటి ఎంచుకోండి.',
    card: (v: Visit, d: string) => `${v.patient}: ${d}, ${win(v.window)}, ${v.doctor}.`,
    confirm: 'కన్ఫర్మ్', move: 'సమయం మార్చండి', cancel: 'రద్దు చేయండి',
    noVisit: 'మీకు రాబోయే అపాయింట్‌మెంట్ లేదు.', which: 'ఏ అపాయింట్‌మెంట్?',
    cancelAsk: 'ఈ అపాయింట్‌మెంట్ రద్దు చేయాలా?', yesCancel: 'అవును, రద్దు', keep: 'ఉంచండి',
    cancelled: 'మీ అపాయింట్‌మెంట్ రద్దు అయింది.', kept: 'సరే, మీ అపాయింట్‌మెంట్ అలాగే ఉంటుంది.', confirmed: (d: string) => `ధన్యవాదాలు, ${d} మీ అపాయింట్‌మెంట్ కన్ఫర్మ్ అయింది.`,
    askQ: 'దయచేసి మీ ప్రశ్న టైప్ చేయండి.',
    inClinic: 'మీరు ఇప్పుడు క్లినిక్‌లో ఉన్నారు. దయచేసి ఫ్రంట్ డెస్క్‌లో అడగండి.',
    locked: 'ఈ అపాయింట్‌మెంట్‌ను ఇక్కడ మార్చలేము. దయచేసి క్లినిక్‌కు కాల్ చేయండి.',
    today: 'ఈ రోజు', tomorrow: 'రేపు',
  },
};

const win = (w: string) => w.replace('-', ' to ');
/** One window per hour, in time order. */
const hours = <W extends { time: string }>(ws: W[]) => [...ws].sort((a, b) => a.time.localeCompare(b.time)).filter((w, i, all) => all.findIndex((x) => x.time === w.time) === i);

/** Is this line for the menu? A tap, a greeting, or the answer to a step the menu asked. Everything else goes to the assistant. */
export function forMenu(c: Chat, inp: { text: string; action?: string }) {
  if (inp.action) return true;
  if (GREETING.test(inp.text)) return true;
  const f = liveFlow(c);
  // a question typed at a step ("what is the fee?") is not an answer to it: the assistant takes it
  return !!(f?.step === 'name' || f?.step === 'note') && !/\?/.test(inp.text) && inp.text.length <= 200;
}
const liveFlow = (c: Chat) => { const f = c.flow as Flow | null; return f && Date.now() - f.at < FLOW_MS ? f : null; };

/** Answer a menu line. Returns the chat's status afterwards, or null when the line is not for the menu. */
export async function menuTurn(t: Tenant, c: Chat, inp: { text: string; action?: string; profileName?: string }, simulate: boolean, origin: string): Promise<string | null> {
  if (!forMenu(c, inp)) { if (c.flow) await inTenant(t, (tx) => tx.update(chat).set({ flow: null }).where(eq(chat.id, c.id))); return null; }
  return inTenant(t, async (tx) => {
    const old = liveFlow(c);
    const lang: Lang = TELUGU.test(inp.text) ? 'te' : old?.lang ?? 'en';
    const L = TXT[lang];
    let flow: Flow = { ...(old ?? {}), lang, at: Date.now() };
    const fresh = (more: Partial<Flow> = {}) => { flow = { lang, at: Date.now(), ...more }; };
    let status = c.status;
    const send = (body: string, menu?: Menu) => say(tx, t, c, body, BY, simulate, menu);
    const today = todayIn(t.timezone);
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);
    const fmt = (d: string) => new Intl.DateTimeFormat(lang === 'te' ? 'te-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z'));
    const dayLabel = (d: string) => d === today ? `${L.today}, ${fmt(d)}` : d === tomorrow ? `${L.tomorrow}, ${fmt(d)}` : fmt(d);
    const shortDay = (d: string) => d === today ? L.today : d === tomorrow ? L.tomorrow : fmt(d);
    const early = bookingSettings(t.settings).arriveEarlyMinutes;
    const view = async (id: string) => visitOut((await appointmentView(tx, t.id, id))!);
    const ask: Menu['options'][number] = { id: 'm:ask', title: L.ask };
    const family = await patientsOn(tx, t, c.phone);
    const profile = cleanName(inp.profileName);

    /** Open hours from now for the person being booked (or the visit being moved), one per hour, days they already have a visit left out. */
    const freeHours = async () => {
      const pid = flow.moving ? (await view(flow.moving)).patient_id : flow.patientId;
      const taken = new Set(pid ? (await myVisits(tx, t, c.phone)).filter((v) => v.patient_id === pid && v.appointment_id !== flow.moving).map((v) => v.date) : []);
      const days = (await openWindows(tx, t, c.phone, today, 7, flow.moving)).filter((d) => !taken.has(d.date));
      return { days, hours: days.flatMap((d) => hours(d.windows).map((w) => ({ ...w, date: d.date }))) };
    };
    const noTimes = async () => {
      await tx.update(chat).set({ status: 'staff', reason: 'No open times in the next 7 days' }).where(eq(chat.id, c.id)); status = 'staff';
      fresh();
      return send(L.none);
    };
    /** The next free time, one tap to book it. `intro` (the greeting) goes in the same message. */
    const sendNext = async (intro = '') => {
      const { hours: free } = await freeHours();
      if (!free.length) return noTimes();
      const n = free[0];
      return send(`${intro}${L.next(dayLabel(n.date), win(n.time), n.doctor ?? null)}`, { kind: 'buttons', options: [{ id: `s:${n.window_id}`, title: L.bookThis }, { id: 'o:', title: L.other }, ask] });
    };
    /** One list of the next open hours across days (a WhatsApp list holds 10 rows), then Another day… and For someone else. */
    const sendTimes = async () => {
      const { hours: free } = await freeHours();
      if (!free.length) return noTimes();
      const rows = free.slice(0, 8).map((w) => ({ id: `s:${w.window_id}`, title: `${shortDay(w.date)} ${w.time.replace('-', '–')}`, description: w.doctor ?? undefined }));
      rows.push({ id: 'd:more', title: L.otherDay, description: undefined });
      if (!flow.moving) rows.push({ id: 'p:new', title: L.forElse, description: undefined });
      return send(L.times, { kind: 'list', button: L.timesBtn, options: rows });
    };
    const sendDays = async () => {
      const { days } = await freeHours();
      if (!days.length) return noTimes();
      return send(L.day, { kind: 'list', button: L.dayBtn, options: days.map((d) => ({ id: `d:${d.date}`, title: dayLabel(d.date), description: L.open(hours(d.windows).length) })) });
    };
    const card = (v: Visit) => {
      const opts = [
        ...(v.can_confirm ? [{ id: `c:${v.appointment_id}`, title: L.confirm }] : []),
        ...(v.can_move ? [{ id: `mv:${v.appointment_id}`, title: L.move }] : []),
        ...(v.can_cancel ? [{ id: `x:${v.appointment_id}`, title: L.cancel }] : []),
      ];
      return opts.length ? send(L.card(v, dayLabel(v.date)), { kind: 'buttons', options: opts }) : send(`${L.card(v, dayLabel(v.date))} ${L.locked}`);
    };
    /** This person already has a visit: book another (a different day), or change or cancel that one. */
    const hasVisit = (v: Visit) => send(L.hasVisit(v, dayLabel(v.date)), { kind: 'buttons', options: [
      { id: `ba:${v.patient_id}`, title: L.another },
      ...(v.can_move ? [{ id: `mv:${v.appointment_id}`, title: L.move }] : []),
      ...(v.can_cancel ? [{ id: `x:${v.appointment_id}`, title: L.cancel }] : []),
    ] });
    /** For whom? Asked when the number has someone registered: a parent books for a child from the same phone. A new number books under its WhatsApp name. */
    const startBooking = async () => {
      fresh();
      if (!family.length) { flow.newName = profile; return sendNext(); }
      const opts = [...family.map((p) => ({ id: `p:${p.id}`, title: p.fullName })), { id: 'p:new', title: L.someoneElse }];
      flow.step = 'who';
      return send(L.who, opts.length <= 3 ? { kind: 'buttons', options: opts } : { kind: 'list', button: L.choose, options: opts.slice(0, 10) });
    };
    const bookIt = (windowId: string) => attempt(async (sp) => {
      const v = await noteVisit(sp, t, c.id, 'Booked', await bookFromChat(sp, t, c.phone, windowId, { patientId: flow.patientId, newName: flow.newName, another: flow.another }, origin));
      fresh({ step: 'note', noteFor: v.appointment_id });
      await send(`${L.booked(v, dayLabel(v.date), early)}\n\n${L.about}`, { kind: 'buttons', options: [{ id: 'ns:', title: L.skip }] });
    });
    /** A change from a tap; the clinic's rules refuse it with an HttpError, which becomes a plain answer. */
    const attempt = async (fn: (sp: Tx) => Promise<unknown>): Promise<boolean> => {
      try { await tx.transaction(fn); return true; }
      catch (e: any) {
        if (!(e instanceof HttpError)) throw e;
        if (e.message === 'ALREADY_BOOKED' && e.extra?.appointment_id) { fresh(); await hasVisit(await view(String(e.extra.appointment_id))); }
        else if (e.message === 'BOOKED_THAT_DAY') { await send(L.thatDay); await sendTimes(); }
        else if (/WINDOW/.test(e.message)) { await send(L.full); await sendTimes(); }
        else if (e.message === 'IN_CLINIC_NOW') { fresh(); await send(L.inClinic); }
        else if (e.message === 'NAME_NEEDED') { flow.step = 'name'; await send(L.name); }
        else { fresh(); await send(L.locked); } // NOT_YOURS, too close to change, already cancelled…
        return false;
      }
    };

    const [kind, arg] = inp.action ? [inp.action.split(':')[0], inp.action.slice(inp.action.indexOf(':') + 1)] : [null, ''];
    if (!inp.action && GREETING.test(inp.text)) {
      fresh();
      const me = family.length === 1 ? family[0] : null;
      const theirs = me ? (await myVisits(tx, t, c.phone)).filter((v) => v.patient_id === me.id) : [];
      if (family.length > 1) await send(`${L.hello(null, t.name, true)} ${L.help}`, { kind: 'buttons', options: [{ id: 'm:book', title: L.book }, { id: 'm:visit', title: L.visit }, ask] });
      else if (me && theirs.length) await send(`${L.hello(me.fullName, t.name, true)}\n${L.yourVisit(theirs[0], dayLabel(theirs[0].date))}`, { kind: 'buttons', options: [{ id: `v:${theirs[0].appointment_id}`, title: L.visit }, { id: `ba:${me.id}`, title: L.another }, ask] });
      else { flow.patientId = me?.id; flow.newName = me ? undefined : profile; await sendNext(`${L.hello(me?.fullName ?? profile ?? null, t.name, !!me)}\n`); }
    } else if (!inp.action && flow.step === 'name') {
      const name = inp.text.replace(NAME_LEAD, '').replace(/[.!]+$/, '').trim();
      if (name.length < 2) await send(L.name);
      else {
        flow.newName = name.slice(0, 100); flow.patientId = undefined; flow.step = undefined;
        const w = flow.pendingWindow; flow.pendingWindow = undefined;
        if (w) await bookIt(w); else await sendNext();
      }
    } else if (!inp.action && flow.step === 'note') {
      // the optional "what is it about?": kept on the visit for the front desk and doctor
      const id = flow.noteFor!;
      if (await attempt(async (sp) => { await mine(sp, t, c.phone, id); await sp.update(appointment).set({ note: inp.text.trim().slice(0, 200) }).where(and(eq(appointment.id, id), eq(appointment.tenantId, t.id))); })) { fresh(); await send(L.noted); }
    } else if (kind === 'ns') { fresh(); await send(L.seeYou); }
    else if (kind === 'm' && arg === 'book') await startBooking();
    else if (kind === 'm' && arg === 'ask') { fresh(); await send(L.askQ); }
    else if (kind === 'm' && arg === 'visit') {
      fresh();
      const visits = await myVisits(tx, t, c.phone);
      if (!visits.length) await send(L.noVisit, { kind: 'buttons', options: [{ id: 'm:book', title: L.book }, ask] });
      else if (visits.length === 1) await card(visits[0]);
      else await send(L.which, { kind: 'list', button: L.choose, options: visits.slice(0, 10).map((v) => ({ id: `v:${v.appointment_id}`, title: v.patient, description: `${dayLabel(v.date)}, ${win(v.window)}` })) });
    } else if (kind === 'p' && arg === 'new') { fresh({ step: 'name' }); await send(L.name); }
    else if (kind === 'p') {
      if (!family.some((p) => p.id === arg)) await startBooking();
      else {
        const theirs = (await myVisits(tx, t, c.phone)).filter((v) => v.patient_id === arg);
        fresh({ patientId: arg });
        if (theirs.length) await hasVisit(theirs[0]); else await sendNext();
      }
    } else if (kind === 'ba') {
      // "Book another": a second visit, on another day, for this person
      if (!family.some((p) => p.id === arg)) await startBooking();
      else { fresh({ patientId: arg, another: true }); await sendNext(); }
    } else if (kind === 'o') await sendTimes();
    else if (kind === 'd' && arg === 'more') await sendDays();
    else if (kind === 'd') {
      const day = (await openWindows(tx, t, c.phone, arg, 1, flow.moving))[0];
      if (!day) { await send(L.full); await sendTimes(); }
      // one row per hour: with several doctors free at the same hour, the first one with room takes it
      // ponytail: no choice of doctor here; ask the doctor first if a clinic needs patients to pick one
      else await send(L.time(dayLabel(day.date)), { kind: 'list', button: L.timesBtn, options: hours(day.windows).slice(0, 10).map((x) => ({ id: `s:${x.window_id}`, title: x.time.replace('-', '–'), description: x.doctor ?? undefined })) });
    } else if (kind === 's') {
      if (flow.moving) {
        const id = flow.moving;
        await attempt(async (sp) => { await moveByPatient(sp, await mine(sp, t, c.phone, id), arg, origin, 'whatsapp'); const v = await noteVisit(sp, t, c.id, 'Moved', visitOut((await appointmentView(sp, t.id, id))!)); fresh(); await send(L.moved(v, dayLabel(v.date), early)); });
      } else if (!flow.patientId && !flow.newName) {
        // no name yet (a new number without a WhatsApp name, or the steps before were lost): ask it, then book this time
        if (family.length && !flow.step) await startBooking();
        else { flow.step = 'name'; flow.pendingWindow = arg; await send(L.name); }
      } else await bookIt(arg);
    } else if (kind === 'v') await attempt(async (sp) => { await card(visitOut(await mine(sp, t, c.phone, arg))); });
    else if (kind === 'c') await attempt(async (sp) => { const a = await mine(sp, t, c.phone, arg); await confirmByPatient(sp, a, 'whatsapp'); const v = await noteVisit(sp, t, c.id, 'Confirmed', visitOut((await appointmentView(sp, t.id, arg))!)); await send(L.confirmed(dayLabel(v.date))); });
    else if (kind === 'x') await attempt(async (sp) => { const v = visitOut(await mine(sp, t, c.phone, arg)); await send(`${L.cancelAsk}\n${L.card(v, dayLabel(v.date))}`, { kind: 'buttons', options: [{ id: `xy:${arg}`, title: L.yesCancel }, { id: 'k:', title: L.keep }] }); });
    else if (kind === 'xy') await attempt(async (sp) => { await cancelByPatient(sp, await mine(sp, t, c.phone, arg), 'Cancelled on WhatsApp', 'whatsapp'); await noteVisit(sp, t, c.id, 'Cancelled', visitOut((await appointmentView(sp, t.id, arg))!)); fresh(); await send(L.cancelled, { kind: 'buttons', options: [{ id: 'm:book', title: L.book }] }); });
    else if (kind === 'k') await send(L.kept);
    else if (kind === 'mv') { fresh({ moving: arg }); if (await attempt(async (sp) => { await mine(sp, t, c.phone, arg); })) await sendTimes(); }
    else return null; // an old or unknown button: the assistant reads its title

    await tx.update(chat).set({ flow }).where(eq(chat.id, c.id));
    return status;
  });
}
