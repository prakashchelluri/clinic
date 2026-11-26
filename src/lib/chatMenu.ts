// Tap-to-book on WhatsApp: a greeting gets three buttons; booking is the problem, the name (new patients), a day list
// and a time list; "My visit" shows the booking with Confirm / Change time / Cancel. No AI in any of these steps:
// anything typed outside them goes to the assistant as before (lib/assistant.ts).
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { chat } from '../db/schema.js';
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
type Flow = { lang: Lang; at: number; step?: 'who' | 'problem' | 'name'; patientId?: string; newName?: string; problem?: string; moving?: string; another?: boolean };

const FLOW_MS = 2 * 3_600_000;
const TELUGU = /[ఀ-౿]/;
const GREETING = /^\s*(hi+|hello+|hey+|hai|helo|namaste|namaskar(am)?|good\s+(morning|afternoon|evening)|menu|start|నమస్తే|నమస్కారం|హాయ్|హలో|नमस्ते)\s*[!.,🙏🏻]*\s*$/iu;
const NAME_LEAD = /^(my name is|name is|i am|i'm|this is|name\s*[:-]?|naa peru|na peru|నా పేరు)\s*/i;

const TXT = {
  en: {
    hello: (name: string | null, clinic: string) => name ? `Hello ${name}, welcome back to ${clinic}. How can we help you?` : `Hello, welcome to ${clinic}. How can we help you?`,
    book: 'Book a visit', visit: 'My visit', ask: 'Ask a question',
    who: 'Who is the visit for?', choose: 'Choose', someoneElse: 'Someone else',
    problem: 'What would you like to see the doctor about?',
    name: "Please type the patient's name.",
    day: 'Please choose a day.', dayBtn: 'Choose a day', open: (n: number) => `${n} time${n > 1 ? 's' : ''} open`,
    time: (d: string) => `Open times for ${d}. Please choose one.`, timeBtn: 'Choose a time',
    none: 'Sorry, there are no open times in the next 7 days. Our front desk will reply here soon.',
    booked: (v: Visit, d: string, early: number) => `Booked: ${v.patient}, ${d}, ${win(v.window)} with ${v.doctor}. Please come ${early} minutes before your time.`,
    moved: (v: Visit, d: string, early: number) => `Changed: ${v.patient}, now ${d}, ${win(v.window)} with ${v.doctor}. Please come ${early} minutes before your time.`,
    full: 'Sorry, that time has just filled up. Please choose another.',
    already: (v: Visit, d: string) => `${v.patient} already has a visit on ${d}, ${win(v.window)}.`,
    hasVisit: (v: Visit, d: string) => `${v.patient} already has a visit on ${d}, ${win(v.window)}. Book another visit, or change this one?`,
    another: 'Book another', thatDay: 'There is already a visit on that day. Please choose another day.',
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
    hello: (name: string | null, clinic: string) => name ? `నమస్తే ${name} గారు, ${clinic}కి స్వాగతం. మీకు ఎలా సహాయం చేయగలం?` : `నమస్తే, ${clinic}కి స్వాగతం. మీకు ఎలా సహాయం చేయగలం?`,
    book: 'బుకింగ్', visit: 'నా అపాయింట్‌మెంట్', ask: 'ప్రశ్న అడగండి',
    who: 'అపాయింట్‌మెంట్ ఎవరి కోసం?', choose: 'ఎంచుకోండి', someoneElse: 'వేరే వ్యక్తి',
    problem: 'డాక్టర్ గారిని ఏ సమస్య కోసం కలవాలనుకుంటున్నారు?',
    name: 'దయచేసి పేషెంట్ పేరు టైప్ చేయండి.',
    day: 'దయచేసి ఒక రోజు ఎంచుకోండి.', dayBtn: 'రోజు ఎంచుకోండి', open: (n: number) => `${n} సమయాలు ఖాళీ`,
    time: (d: string) => `${d} ఖాళీ సమయాలు. ఒకటి ఎంచుకోండి.`, timeBtn: 'సమయం ఎంచుకోండి',
    none: 'క్షమించండి, వచ్చే 7 రోజుల్లో ఖాళీ సమయాలు లేవు. మా ఫ్రంట్ డెస్క్ త్వరలో ఇక్కడ సమాధానం ఇస్తారు.',
    booked: (v: Visit, d: string, early: number) => `బుక్ అయింది: ${v.patient}, ${d}, ${win(v.window)}, ${v.doctor}. దయచేసి మీ సమయానికి ${early} నిమిషాల ముందు రండి.`,
    moved: (v: Visit, d: string, early: number) => `మార్చాము: ${v.patient}, ఇప్పుడు ${d}, ${win(v.window)}, ${v.doctor}. దయచేసి మీ సమయానికి ${early} నిమిషాల ముందు రండి.`,
    full: 'క్షమించండి, ఆ సమయం ఇప్పుడే నిండిపోయింది. దయచేసి మరొకటి ఎంచుకోండి.',
    already: (v: Visit, d: string) => `${v.patient} గారికి ఇప్పటికే ${d}, ${win(v.window)} అపాయింట్‌మెంట్ ఉంది.`,
    hasVisit: (v: Visit, d: string) => `${v.patient} గారికి ఇప్పటికే ${d}, ${win(v.window)} అపాయింట్‌మెంట్ ఉంది. ఇంకొకటి బుక్ చేయాలా, లేదా దీన్ని మార్చాలా?`,
    another: 'ఇంకొకటి బుక్', thatDay: 'ఆ రోజు ఇప్పటికే అపాయింట్‌మెంట్ ఉంది. దయచేసి మరో రోజు ఎంచుకోండి.',
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
  return !!(f?.step === 'problem' || f?.step === 'name') && !/\?/.test(inp.text) && inp.text.length <= 200;
}
const liveFlow = (c: Chat) => { const f = c.flow as Flow | null; return f && Date.now() - f.at < FLOW_MS ? f : null; };

/** Answer a menu line. Returns the chat's status afterwards, or null when the line is not for the menu. */
export async function menuTurn(t: Tenant, c: Chat, inp: { text: string; action?: string }, simulate: boolean, origin: string): Promise<string | null> {
  if (!forMenu(c, inp)) { if (c.flow) await inTenant(t, (tx) => tx.update(chat).set({ flow: null }).where(eq(chat.id, c.id))); return null; }
  return inTenant(t, async (tx) => {
    const old = liveFlow(c);
    const lang: Lang = TELUGU.test(inp.text) ? 'te' : old?.lang ?? 'en';
    const L = TXT[lang];
    let flow: Flow = { ...(old ?? {}), lang, at: Date.now() };
    let status = c.status;
    const send = (body: string, menu?: Menu) => say(tx, t, c, body, BY, simulate, menu);
    const today = todayIn(t.timezone);
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400_000).toISOString().slice(0, 10);
    const dayLabel = (d: string) => { const s = new Intl.DateTimeFormat(lang === 'te' ? 'te-IN' : 'en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')); return d === today ? `${L.today}, ${s}` : d === tomorrow ? `${L.tomorrow}, ${s}` : s; };
    const early = bookingSettings(t.settings).arriveEarlyMinutes;
    const view = async (id: string) => visitOut((await appointmentView(tx, t.id, id))!);
    const mainMenu: Menu = { kind: 'buttons', options: [{ id: 'm:book', title: L.book }, { id: 'm:visit', title: L.visit }, { id: 'm:ask', title: L.ask }] };
    const family = await patientsOn(tx, t, c.phone);

    const sendDays = async () => {
      // days this person already has a visit are left out: never two on one day
      const pid = flow.moving ? (await view(flow.moving)).patient_id : flow.patientId;
      const taken = new Set(pid ? (await myVisits(tx, t, c.phone)).filter((v) => v.patient_id === pid && v.appointment_id !== flow.moving).map((v) => v.date) : []);
      const days = (await openWindows(tx, t, c.phone, today, 7, flow.moving)).filter((d) => !taken.has(d.date));
      if (!days.length) {
        await tx.update(chat).set({ status: 'staff', reason: 'No open times in the next 7 days' }).where(eq(chat.id, c.id)); status = 'staff';
        flow = { lang, at: Date.now() };
        return send(L.none);
      }
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
    /** For whom? Asked whenever the number has someone registered: a parent books for a child from the same phone. */
    const startBooking = async () => {
      flow = { lang, at: Date.now() };
      if (!family.length) { flow.step = 'problem'; return send(L.problem); }
      const opts = [...family.map((p) => ({ id: `p:${p.id}`, title: p.fullName })), { id: 'p:new', title: L.someoneElse }];
      flow.step = 'who';
      return send(L.who, opts.length <= 3 ? { kind: 'buttons', options: opts } : { kind: 'list', button: L.choose, options: opts.slice(0, 10) });
    };
    /** A change from a tap; the clinic's rules refuse it with an HttpError, which becomes a plain answer. */
    const attempt = async (fn: (sp: Tx) => Promise<unknown>): Promise<boolean> => {
      try { await tx.transaction(fn); return true; }
      catch (e: any) {
        if (!(e instanceof HttpError)) throw e;
        if (e.message === 'ALREADY_BOOKED' && e.extra?.appointment_id) { const v = await view(String(e.extra.appointment_id)); flow = { lang, at: Date.now(), problem: flow.problem }; await hasVisit(v); }
        else if (e.message === 'BOOKED_THAT_DAY') { await send(L.thatDay); await sendDays(); }
        else if (/WINDOW/.test(e.message)) { await send(L.full); await sendDays(); }
        else if (e.message === 'IN_CLINIC_NOW') { flow = { lang, at: Date.now() }; await send(L.inClinic); }
        else if (e.message === 'NAME_NEEDED') { flow.step = 'name'; await send(L.name); }
        else { flow = { lang, at: Date.now() }; await send(L.locked); } // NOT_YOURS, too close to change, already cancelled…
        return false;
      }
    };

    const [kind, arg] = inp.action ? [inp.action.split(':')[0], inp.action.slice(inp.action.indexOf(':') + 1)] : [null, ''];
    if (!inp.action && GREETING.test(inp.text)) {
      flow = { lang, at: Date.now() };
      await send(L.hello(family.length === 1 ? family[0].fullName : null, t.name), mainMenu);
    } else if (!inp.action && flow.step === 'problem') {
      flow.problem = inp.text.slice(0, 200);
      if (flow.patientId) { flow.step = undefined; await sendDays(); } else { flow.step = 'name'; await send(L.name); }
    } else if (!inp.action && flow.step === 'name') {
      const name = inp.text.replace(NAME_LEAD, '').replace(/[.!]+$/, '').trim();
      if (name.length < 2) await send(L.name);
      else { flow.newName = name.slice(0, 100); flow.step = undefined; await sendDays(); }
    } else if (kind === 'm' && arg === 'book') await startBooking();
    else if (kind === 'm' && arg === 'ask') { flow = { lang, at: Date.now() }; await send(L.askQ); }
    else if (kind === 'm' && arg === 'visit') {
      flow = { lang, at: Date.now() };
      const visits = await myVisits(tx, t, c.phone);
      if (!visits.length) await send(L.noVisit, { kind: 'buttons', options: [mainMenu.options[0], mainMenu.options[2]] });
      else if (visits.length === 1) await card(visits[0]);
      else await send(L.which, { kind: 'list', button: L.choose, options: visits.slice(0, 10).map((v) => ({ id: `v:${v.appointment_id}`, title: v.patient, description: `${dayLabel(v.date)}, ${win(v.window)}` })) });
    } else if (kind === 'p') {
      flow.patientId = arg !== 'new' && family.some((p) => p.id === arg) ? arg : undefined;
      const theirs = flow.patientId ? (await myVisits(tx, t, c.phone)).filter((v) => v.patient_id === flow.patientId) : [];
      if (theirs.length) { flow.step = undefined; await hasVisit(theirs[0]); }
      else { flow.step = 'problem'; await send(L.problem); }
    } else if (kind === 'ba') {
      // "Book another": a second visit on another day for this person (the problem, if already given, is kept)
      if (!family.some((p) => p.id === arg)) await startBooking();
      else {
        flow = { lang, at: Date.now(), patientId: arg, another: true, problem: flow.problem };
        if (flow.problem) await sendDays(); else { flow.step = 'problem'; await send(L.problem); }
      }
    } else if (kind === 'd') {
      const day = (await openWindows(tx, t, c.phone, arg, 1, flow.moving))[0];
      if (!day) { await send(L.full); await sendDays(); }
      // one row per hour (a WhatsApp list holds 10 rows): with several doctors free at the same hour, the first one with room takes it
      // ponytail: no choice of doctor here; ask the doctor first if a clinic needs patients to pick one
      else await send(L.time(dayLabel(day.date)), { kind: 'list', button: L.timeBtn, options: hours(day.windows).slice(0, 10).map((x) => ({ id: `s:${x.window_id}`, title: x.time.replace('-', '–'), description: x.doctor ?? undefined })) });
    } else if (kind === 's') {
      if (flow.moving) {
        const id = flow.moving;
        await attempt(async (sp) => { await moveByPatient(sp, await mine(sp, t, c.phone, id), arg, origin, 'whatsapp'); const v = await noteVisit(sp, t, c.id, 'Moved', visitOut((await appointmentView(sp, t.id, id))!)); flow = { lang, at: Date.now() }; await send(L.moved(v, dayLabel(v.date), early)); });
      } else if (!flow.patientId && !flow.newName) await startBooking(); // the steps before were lost (over 2 hours ago)
      else {
        await attempt(async (sp) => {
          const v = await noteVisit(sp, t, c.id, 'Booked', await bookFromChat(sp, t, c.phone, arg, { patientId: flow.patientId, newName: flow.newName, reason: flow.problem, another: flow.another }, origin));
          flow = { lang, at: Date.now() }; await send(L.booked(v, dayLabel(v.date), early));
        });
      }
    } else if (kind === 'v') await attempt(async (sp) => { await card(visitOut(await mine(sp, t, c.phone, arg))); });
    else if (kind === 'c') await attempt(async (sp) => { const a = await mine(sp, t, c.phone, arg); await confirmByPatient(sp, a, 'whatsapp'); const v = await noteVisit(sp, t, c.id, 'Confirmed', visitOut((await appointmentView(sp, t.id, arg))!)); await send(L.confirmed(dayLabel(v.date))); });
    else if (kind === 'x') await attempt(async (sp) => { const v = visitOut(await mine(sp, t, c.phone, arg)); await send(`${L.cancelAsk}\n${L.card(v, dayLabel(v.date))}`, { kind: 'buttons', options: [{ id: `xy:${arg}`, title: L.yesCancel }, { id: 'k:', title: L.keep }] }); });
    else if (kind === 'xy') await attempt(async (sp) => { await cancelByPatient(sp, await mine(sp, t, c.phone, arg), 'Cancelled on WhatsApp', 'whatsapp'); await noteVisit(sp, t, c.id, 'Cancelled', visitOut((await appointmentView(sp, t.id, arg))!)); flow = { lang, at: Date.now() }; await send(L.cancelled, { kind: 'buttons', options: [mainMenu.options[0]] }); });
    else if (kind === 'k') await send(L.kept);
    else if (kind === 'mv') { flow = { lang, at: Date.now(), moving: arg }; if (await attempt(async (sp) => { await mine(sp, t, c.phone, arg); })) await sendDays(); }
    else return null; // an old or unknown button: the assistant reads its title

    await tx.update(chat).set({ flow }).where(eq(chat.id, c.id));
    return status;
  });
}
