import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import { can } from '../App';
import { Chip, Icon, PageHeader, Segmented } from '../ui';

type Guide = 'reception' | 'doctor' | 'junior' | 'pharmacy' | 'owner';
const GUIDES: [Guide, string][] = [['reception', 'Reception'], ['doctor', 'Doctor'], ['junior', 'Junior doctor'], ['pharmacy', 'Pharmacy'], ['owner', 'Owner']];

/** Opening Help from a page lands on the part of the guide about that page. */
const CONTEXT: Record<string, { guide: Guide; anchor: string }> = {
  queue: { guide: 'reception', anchor: 'frontdesk' }, tests: { guide: 'reception', anchor: 'tests' }, patients: { guide: 'reception', anchor: 'patients' }, worklist: { guide: 'reception', anchor: 'procedures' },
  followups: { guide: 'reception', anchor: 'followups' }, reports: { guide: 'reception', anchor: 'endofday' }, calendar: { guide: 'reception', anchor: 'booking' }, bookings: { guide: 'reception', anchor: 'booking' },
  today: { guide: 'doctor', anchor: 'doctor-day' }, encounter: { guide: 'doctor', anchor: 'doctor-day' }, pharmacy: { guide: 'pharmacy', anchor: 'pharmacy-day' }, settings: { guide: 'owner', anchor: 'owner-settings' }, dashboard: { guide: 'owner', anchor: 'owner-reports' },
};

/* ---------- small building blocks ---------- */
const WHO = { reception: 'bg-clay-soft text-clay', junior: 'bg-sky-soft text-sky', doctor: 'bg-sage-soft text-sage', pharmacy: 'bg-amber-soft text-amber', patient: 'bg-ink/8 text-ink-2', owner: 'bg-ink text-white' } as const;
const WHO_NAME = { reception: 'Reception', junior: 'Junior doctor', doctor: 'Doctor', pharmacy: 'Pharmacy', patient: 'Patient', owner: 'Owner' } as const;
type Who = keyof typeof WHO;

function Step({ n, who, title, children }: { n?: number; who: Who; title: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 basis-[150px] flex-col gap-1.5 rounded-2xl border border-line bg-white/80 p-3">
      <div className="flex items-center gap-2">{n !== undefined && <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-white">{n}</span>}<span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${WHO[who]}`}>{WHO_NAME[who]}</span></div>
      <div className="text-sm font-semibold leading-snug">{title}</div>
      {children && <div className="text-xs leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}
const Arrow = () => <span aria-hidden className="grid shrink-0 place-items-center text-lg text-muted md:px-0.5"><span className="md:hidden">↓</span><span className="hidden md:inline">→</span></span>;
/** A diagram: steps in a row on a wide screen, a column on a phone. */
function Flow({ label, children }: { label: string; children: ReactNode[] }) {
  return <figure className="my-4 rounded-3xl bg-white/50 p-3 md:p-4" aria-label={label}><div className="flex flex-col items-stretch gap-1 md:flex-row md:flex-wrap md:items-stretch">{children.flatMap((c, i) => (i ? [<Arrow key={`a${i}`} />, c] : [c]))}</div><figcaption className="mt-2 text-xs text-muted">{label}</figcaption></figure>;
}
const H2 = ({ id, children }: { id: string; children: ReactNode }) => <h2 id={id} className="serif mt-10 scroll-mt-6 text-2xl first:mt-0">{children}</h2>;
const H3 = ({ children }: { children: ReactNode }) => <h3 className="mb-1.5 mt-6 text-[15px] font-semibold">{children}</h3>;
const P = ({ children }: { children: ReactNode }) => <p className="my-2 text-[14.5px] leading-relaxed text-ink-2">{children}</p>;
const Steps = ({ children }: { children: ReactNode[] }) => <ol className="my-3 space-y-2">{children.map((c, i) => <li key={i} className="flex gap-3 text-[14.5px] leading-relaxed text-ink-2"><span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-white">{i + 1}</span><span className="min-w-0 flex-1">{c}</span></li>)}</ol>;
const Tip = ({ children }: { children: ReactNode }) => <div className="my-3 rounded-2xl bg-sage-soft px-4 py-3 text-sm leading-relaxed text-sage" role="note"><b>Good to know. </b>{children}</div>;
const Warn = ({ children }: { children: ReactNode }) => <div className="my-3 rounded-2xl bg-amber-soft px-4 py-3 text-sm leading-relaxed text-amber" role="note"><b>Careful. </b>{children}</div>;
const Btn = ({ children }: { children: ReactNode }) => <span className="whitespace-nowrap rounded-full border border-line bg-white px-2 py-0.5 text-[13px] font-semibold text-ink">{children}</span>;
function Table({ head, rows }: { head: [string, string]; rows: [ReactNode, ReactNode][] }) {
  return <div className="my-3 overflow-hidden rounded-2xl border border-line bg-white/70"><table className="w-full text-sm"><thead><tr className="bg-ink/5 text-left text-xs uppercase tracking-wider text-muted"><th className="w-[34%] px-3 py-2">{head[0]}</th><th className="px-3 py-2">{head[1]}</th></tr></thead><tbody>{rows.map(([a, b], i) => <tr key={i} className="border-t border-line/60 align-top"><td className="px-3 py-2 font-semibold">{a}</td><td className="px-3 py-2 leading-relaxed text-ink-2">{b}</td></tr>)}</tbody></table></div>;
}

/* ---------- the guides ---------- */
function Overview() {
  return (<>
    <H2 id="journey">A patient's day in one picture</H2>
    <P>Every patient follows the same road. Each box says who does that step. If you only read one thing, read this.</P>
    <Flow label="From the first call to the follow-up. Reception does steps 1, 2, 3 and 6.">
      <Step n={1} who="reception" title="Booking or walk-in">The patient is booked on the Calendar, or just walks in. A walk-in needs no booking.</Step>
      <Step n={2} who="reception" title="Check-in">Pick the visit type, note the complaints, take the consultation fee. The patient gets a token.</Step>
      <Step n={3} who="reception" title="Waiting">The patient waits. You see them under Waiting on the Front desk.</Step>
      <Step n={4} who="junior" title="Screening">Yes / No questions for the complaint, and the medical history.</Step>
      <Step n={5} who="doctor" title="Consultation">The doctor sees what was found, confirms, prescribes and plans.</Step>
      <Step n={6} who="reception" title="Checkout">Hand over the lab slip, agree the procedure price, book the next visit, close the visit.</Step>
    </Flow>
    <P>After Checkout the patient goes on to one or more of these:</P>
    <Flow label="What happens after Checkout.">
      <Step who="pharmacy" title="Pharmacy counter">The prescription is waiting. Medicines are paid for here.</Step>
      <Step who="reception" title="Tests">Reports come back later as photos. The doctor reviews, you tell the patient.</Step>
      <Step who="reception" title="Procedure">Sittings are booked. Each is paid on the day, or from an advance.</Step>
      <Step who="reception" title="Follow-up">If the patient does not come back, you call from the Follow-ups page.</Step>
    </Flow>

    <H2 id="money">Where money is taken</H2>
    <P>Money is always taken where the thing is given. <b>Checkout does not take money.</b></P>
    <div className="my-4 grid gap-3 md:grid-cols-3">
      <div className="rounded-2xl border border-line bg-white/80 p-4"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Consultation fee</div><div className="font-semibold">At check-in</div><div className="mt-1 text-sm text-ink-2">Reception, on the Check-in screen. Cash, UPI or card. A free or waived visit takes nothing.</div></div>
      <div className="rounded-2xl border border-line bg-white/80 p-4"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Medicines</div><div className="font-semibold">At the pharmacy counter</div><div className="mt-1 text-sm text-ink-2">The pharmacist bills the prescription and takes the money. Reception does not.</div></div>
      <div className="rounded-2xl border border-line bg-white/80 p-4"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Procedures</div><div className="font-semibold">On the day of each sitting</div><div className="mt-1 text-sm text-ink-2">Or ahead of time: the patient can pay for some sittings in advance (for example 2 of 6).</div></div>
    </div>

    <H2 id="words">Words you will see</H2>
    <Table head={['Word', 'What it means']} rows={[
      ['Checkout', 'The list of patients the doctor has finished with, who still need something from reception.'],
      ['Hand-off', 'A line on Checkout that only tells you where the patient pays next. It never stops you closing the visit.'],
      ['Advised / Agreed / Paid', 'A procedure plan moves through these. Advised: the doctor suggested it. Agreed: the patient accepted a price. Paid: every sitting is paid for.'],
      ['Course', 'A procedure the patient agreed to, for example 6 chemical peels at one price.'],
      ['Advance', 'Money paid ahead for some sittings of a course. The price is locked from the first payment.'],
      ['Test order', 'The tests the doctor asked for in one visit. The doctor reviews the order once, when every report is in.'],
      ['Informed', 'The patient has been told the result. Only reception or the doctor marks this, and only after the doctor reviewed.'],
      ['Handle carefully', 'A flag with a written reason, shown beside the patient’s name. Read the reason before you speak to them.'],
      ['Waive', 'Take no fee for a visit, with a reason. Only some people may do this.'],
      ['EMI awaiting settlement', 'The lender approved the payment, but its money has not reached the bank yet.'],
      ['Drawer', 'The cash box. At the end of the day the cash counted should match what the app expects.'],
    ]} />
  </>);
}

function Reception() {
  return (<>
    <H2 id="frontdesk">The Front desk</H2>
    <P>This is your home page. The cards across the top are your lists for the day. Tap a card to see that list.</P>
    <Table head={['Card', 'What is in it']} rows={[
      ['Waiting', 'Checked in, waiting to be called. The longest wait is shown.'],
      ['Not yet arrived', 'Booked for today and not here yet. Tap Check in when they arrive.'],
      ['With doctor', 'In the consultation room now.'],
      ['Checkout', 'Seen by the doctor, and something is still to arrange. This is where you work after the doctor.'],
      ['Awaiting reports', 'The lab slip is given. They stay here until the reports are reviewed and the patient is told.'],
      ['Completed', 'Finished for today.'],
      ['All', 'Everyone for today in one list.'],
      ['Needs you', 'Late arrivals and anything with money still due.'],
    ]} />

    <H2 id="checkin">Check in a patient</H2>
    <Steps>{[
      <>Tap the <Btn>+</Btn> button at the top right and choose <Btn>Check in a patient</Btn>. Or, for someone who was booked, tap <Btn>Check in</Btn> on their row under Not yet arrived.</>,
      <>Find the patient by phone, name or ID. For someone new, type the name, a 10-digit phone, age and sex. Families often share a phone, so check the name and age.</>,
      <>Pick the <b>visit type</b>. The app suggests the right one. For example General / New, Renewal (free within 15 days of a paid visit), Free (procedure follow-up), Emergency, RMP/PMP card, Online.</>,
      <>Tap the patient&rsquo;s <b>complaints</b> (Rashes, Itching, Hair fall and so on). This sets up the questions the junior doctor will ask. Enter weight and the other readings if the screen asks.</>,
      <>Choose how they pay: Cash, UPI or Card. The amount is filled in. Tap <Btn>Check in · collect ₹&hellip;</Btn>. Give the patient their token number.</>,
    ]}</Steps>
    <Tip>If the fee is ₹0 (a free review), the screen says &ldquo;Nothing to collect&rdquo;. Only people with permission can waive a fee, and they must type a reason.</Tip>
    <Warn>A free review is allowed <b>once</b> after a paid consultation. If a second one is refused, the screen says so. Choose the paid consultation, or ask the owner to allow one more (the owner types a reason).</Warn>
    <Warn>If you see an amber <b>Handle carefully</b> chip next to a name, read the reason under it before you talk to the patient or their family.</Warn>

    <H2 id="checkout">Checkout: after the doctor</H2>
    <P>When the doctor finishes, the patient appears under <b>Checkout</b> with a count such as &ldquo;3 open&rdquo;. Work through the lines, then close the visit.</P>
    <Flow label="Checkout in order. Close visit is last.">
      <Step n={1} who="reception" title="Tests">Give the lab slip, then tap <b>Slip given</b>. The patient moves to Awaiting reports.</Step>
      <Step n={2} who="reception" title="Procedure">Tap <b>Price &amp; advance</b> to agree the price and take an advance. Tap <b>Schedule</b> to book a sitting.</Step>
      <Step n={3} who="reception" title="Review">Tap <b>Book visit</b>. The doctor&rsquo;s date is filled in.</Step>
      <Step n={4} who="reception" title="Close visit">Tap <b>Close visit</b> when nothing above is open.</Step>
    </Flow>
    <Table head={['Line', 'What to do']} rows={[
      ['Procedure', <>Price &amp; advance opens the price screen (see Procedures below). Schedule books the first sitting.</>],
      ['Tests', 'Slip given. The reports themselves come later, from the Test reports page.'],
      ['Follow-up', 'Book visit opens the booking screen for the date the doctor asked for. A Sunday or closed day is warned about.'],
      ['Hand-off (grey)', 'Information only. It says the consultation was paid at check-in, medicines are at the pharmacy, and procedures are paid on the day.'],
    ]} />
    <P>A line that the patient does not want, or cannot do today, has a <Btn>&hellip;</Btn> menu: <b>Patient declined</b> (with a reason) or <b>Do later</b>. Either one clears the line, and the patient still appears in Follow-ups so nobody is forgotten.</P>
    <Tip><b>Close visit</b> is grey until everything above is arranged or marked. <b>Close with a reason</b> (for a patient who left) is only for the owner or admin, and it is written to the log.</Tip>

    <H2 id="tests">Test reports</H2>
    <P>Tests are ordered together as one <b>order</b>. The doctor reviews the order once, when <b>every</b> report is in. A slow test, like a biopsy, is kept as its own order so it does not hold the others back.</P>
    <Flow label="Life of a test order. The patient never needs a login: you add the photo.">
      <Step n={1} who="doctor" title="Doctor orders tests">Appear on Checkout as Tests.</Step>
      <Step n={2} who="reception" title="Slip given">Patient goes to the lab.</Step>
      <Step n={3} who="reception" title="Add each report">On Test reports, tap the order and take a photo with the phone.</Step>
      <Step n={4} who="doctor" title="Doctor reviews">When all are in. Or &ldquo;Review what is in&rdquo; to split off a missing one.</Step>
      <Step n={5} who="reception" title="Tell the patient">In person, by phone or WhatsApp. Mark Informed.</Step>
    </Flow>
    <Steps>{[
      <>Open <b>Test reports</b>. Your tabs are <Btn>To collect</Btn> (add reports), <Btn>To explain</Btn> (tell the patient) and <Btn>Done today</Btn>.</>,
      <>Under To collect, tap the order, then <Btn>Add report</Btn>. Take a clear photo of each page with the phone camera, or choose a file. Large photos are made smaller automatically.</>,
      <>If the lab has not sent a report and you phoned them, tap <Btn>Called the lab</Btn> so the next person knows.</>,
      <>After the doctor has reviewed, the order shows under To explain. Tell the patient, then tap <Btn>Informed</Btn> and choose how (in person, phone or WhatsApp).</>,
    ]}</Steps>
    <Warn>You cannot mark a result as told before the doctor has reviewed it. If the doctor chose &ldquo;I will call&rdquo;, only the doctor can close it.</Warn>

    <H2 id="procedures">Procedures: price, advance, sittings</H2>
    <Flow label="A procedure course from advice to the last sitting.">
      <Step n={1} who="doctor" title="Advised">The doctor suggests the procedure.</Step>
      <Step n={2} who="reception" title="Quote (optional)">Send or print a quote that is valid for 7, 15 or 30 days.</Step>
      <Step n={3} who="reception" title="Agreed">The patient says yes. Tap <b>Patient agrees</b>.</Step>
      <Step n={4} who="reception" title="Advance (optional)">The patient pays for some sittings now. The price is locked.</Step>
      <Step n={5} who="reception" title="Sittings">Each sitting is paid from the advance, or on the day.</Step>
    </Flow>
    <Steps>{[
      <>On Checkout, tap <Btn>Price &amp; advance</Btn> next to the procedure.</>,
      <>The list price is shown. If the clinic has a <b>package</b>, tap it to fill in the price. Only people allowed to give discounts can type a lower price, and only up to the clinic&rsquo;s limit; above it the owner must agree.</>,
      <>To send a quote, choose the validity and tap <Btn>Send on WhatsApp</Btn> or <Btn>Print</Btn>. The quote never shows consultation or medicine prices. When the patient agrees, the quoted price is used.</>,
      <>Tap <Btn>Patient agrees</Btn>. The screen now shows the course: sittings, price per sitting, and what is paid ahead.</>,
      <>If the patient wants to pay now, use the <b>+</b> and <b>&minus;</b> to choose how many sittings (for example 2 of 6), pick Cash, UPI, Card or EMI, and tap <Btn>Take ₹&hellip;</Btn>. A receipt is made.</>,
    ]}</Steps>
    <Tip>Paying ahead for sittings you may not use is normal. Unused sittings stay on the course. A refund of unused sittings is rare and only the owner can approve it, with a reason.</Tip>
    <P>The <b>Procedures</b> page has three views. <b>Schedule</b> shows sittings by date. <b>Board</b> shows every plan as Advised, Agreed or Paid; tap a plan to see each sitting: when, who did it, and whether it was paid. <b>Plans to schedule</b> lists plans with no booked sitting.</P>
    <P>To put a second doctor on a sitting as supervisor, open Schedule, choose the sitting, and use <Btn>Assign doctor</Btn> then <b>Supervised by</b>.</P>

    <H2 id="payments">Taking a payment later</H2>
    <P>Anything that is still due (for example a procedure sitting) is taken from the patient&rsquo;s record.</P>
    <Steps>{[
      <>Open <b>Patients</b>, find the patient, and tap <Btn>Take payment</Btn> (it only shows when something is due).</>,
      <>Tick the invoices this payment settles. They are all ticked at first.</>,
      <>Pick a mode and an amount. To <b>split</b>, tap <Btn>Split across another mode</Btn>. The screen tells you whether the modes add up. You can pay part and leave the rest due.</>,
      <>For <b>EMI</b> type the lender and the approval code. EMI counts as paid at once, but it is listed under &ldquo;EMI awaiting settlement&rdquo; (Reports page) until the bank credit arrives. Then tap <Btn>Bank credit arrived</Btn> and enter the fee the lender kept.</>,
      <>Under <b>Invoices</b>, the &hellip; menu on a paid row has <Btn>Print receipt</Btn>.</>,
    ]}</Steps>
    <Warn>A payment cannot be edited. A mistake is put right by a <b>refund</b>, which only the owner or admin can do (or someone the owner has allowed). The same menu has Cancel invoice (unpaid only), Give a discount, and Leave out of tax reports. Each asks for a reason and is logged.</Warn>

    <H2 id="followups">Follow-ups: who to call</H2>
    <P>Open <b>Follow-ups</b> each morning. It has four lists. Every row shows how many calls have been made and what happened last.</P>
    <Table head={['List', 'Who is in it']} rows={[
      ['Reviews due', 'The doctor asked to see them again.'],
      ['Missed visits', 'Booked and did not come, and missed procedure sittings.'],
      ['Procedures to schedule', 'The price is agreed, but no sitting is booked.'],
      ['Advised, not agreed', 'The doctor advised a procedure and the patient has not said yes.'],
    ]} />
    <Steps>{[
      <>Tap <Btn>Call</Btn> to dial from a phone, or phone from your desk.</>,
      <>Tap <Btn>Log the call</Btn> and choose the result: <b>Booked</b>, <b>Call later</b> (choose a date), <b>No answer</b>, or <b>Not interested</b> (type why).</>,
      <>On <b>No answer</b> you can tick &ldquo;Send a short message with the clinic number&rdquo;. A Sunday date asks you to confirm.</>,
    ]}</Steps>
    <Tip>Booked and Not interested take the patient off the list. Call later puts them at the bottom until that day.</Tip>

    <H2 id="patients">Patients and the record</H2>
    <P>Search by name, phone digits or ID. Each result shows age, last visit and the main problem, so two people with the same name can be told apart. Families may share one phone number: pick the right person.</P>
    <Table head={['On the record', 'What it is for']} rows={[
      ['Chips beside the name', 'VIP, Family and friends, and amber Handle carefully. Hover (or read the banner) for the reason.'],
      ['Guardian', 'A child has a link to the parent’s own record. “Contact is mother” says who answers the phone.'],
      ['Filter tabs', 'All, Visits, Procedures, Payments, Reports and Missed. Missed lists missed visits and sittings with every call made, in case the patient later says nobody told them.'],
      ['Courses and Invoices', 'What was agreed, what is paid ahead, and every bill.'],
    ]} />
    <P>Only the doctor or owner can set a flag. You can see all flags. To change who answers a phone or add a guardian, tap the pencil on the record.</P>

    <H2 id="booking">Calendar and bookings</H2>
    <P>The <b>Calendar</b> shows each doctor&rsquo;s booking windows. Tap <Btn>Book</Btn>, find or register the patient, and pick a window. A colour key at the top shows what each colour means. <b>Bookings</b> lists online requests waiting for you: approve or decline them. The bell shows when something is waiting.</P>

    <H2 id="endofday">End of day</H2>
    <P>On <b>Reports</b>, switch to <Btn>End of day</Btn>. It is one page to read against the doctor&rsquo;s paper diary.</P>
    <Steps>{[
      <>Look at the money table: cash, UPI, card and EMI, split by consultation, procedure, pharmacy and other.</>,
      <>Count the cash drawer and type the amount. If it does not match, a box asks <b>why</b>.</>,
      <>Type the diary&rsquo;s count for each kind of visit. If one differs from the app, explain why.</>,
      <>Owner or admin taps <Btn>Close the day</Btn>. The day is then locked: no new payments can be added to it.</>,
    ]}</Steps>
  </>);
}

function Doctor() {
  return (<>
    <H2 id="doctor-day">The doctor&rsquo;s day: about six minutes a patient</H2>
    <P>Typing is done at the desk and by the junior doctor. You confirm.</P>
    <Steps>{[
      <>Open <b>Today</b>. Patients waiting are listed. Open the next one.</>,
      <>The <b>screening card</b> (top left) lists only what was found: the Yes answers and the history. Everything answered No is one grey line.</>,
      <>Under <b>Suggested</b>, tap the sets for the complaint, one tap each: medicines, advice, findings, tests. Nothing is added twice. A set marked &ldquo;auto&rdquo; is added for you.</>,
      <>Choose the <b>diagnosis</b>. Its protocol adds only what is missing and leaves your choices alone.</>,
      <>Add tests as chips. A slow test (like a biopsy) goes into its own order, or tap the order icon to split one.</>,
      <>Plan the procedure or the review date, then <b>Complete</b>. The patient goes to reception for Checkout.</>,
    ]}</Steps>
    <Tip>Saved your own set? Use &ldquo;Save only the medicines / advice / tests&rdquo; at the bottom. It waits as a draft until the owner approves it.</Tip>
    <H3>Reviewing test results</H3>
    <P>Open <b>Test reports</b> &rarr; <b>To review</b>. When every report in an order is in, review it once: Normal, Change medicines, Needs a visit, or I will call. If one report is slow, tap <b>Review what is in</b> to split the missing one off.</P>
  </>);
}

function Junior() {
  return (<>
    <H2 id="junior-day">The junior doctor: screening</H2>
    <Steps>{[
      <>Open <b>Front desk</b>. Open the patient who is waiting.</>,
      <>For each complaint the patient gave at check-in, tap <b>Yes</b> or <b>No</b> on each question. A Yes may ask for one detail, such as how long.</>,
      <>Ask the <b>medical history</b> (diabetes, thyroid, blood pressure, allergy). This is asked once and kept on the patient; at later visits you only confirm it.</>,
      <>Your answers appear for the doctor as the screening card. You do not see prices anywhere.</>,
    ]}</Steps>
  </>);
}

function Pharmacy() {
  return (<>
    <H2 id="pharmacy-day">The pharmacy counter</H2>
    <P>The pharmacist takes the money for medicines. Reception does not.</P>
    <Steps>{[
      <>Open <b>Pharmacy</b>. Prescriptions that the doctor wrote today are waiting at the counter.</>,
      <>Open the prescription, check the items against what the patient wants, and bill it. Batches are chosen oldest-expiry first.</>,
      <>Take the payment. It can be split across cash, UPI and card.</>,
      <>For someone with no prescription, tap <Btn>Walk-in sale</Btn>.</>,
      <>If the patient brings something back, use returns on the bill. A refund is recorded with a credit note.</>,
    ]}</Steps>
  </>);
}

function Owner() {
  return (<>
    <H2 id="owner-settings">Owner: Settings</H2>
    <Table head={['Settings tab', 'What it does']} rows={[
      ['Roles and access', 'Tick what each role can do. This is where you decide who may refund, give discounts, close the day, or see fees. Also set the one discount limit for the whole clinic: anything above it needs you.'],
      ['Templates', 'The ready-made sets doctors tap in the consultation: checklists, medicines, advice, findings, tests, procedures. Approve the drafts that doctors save.'],
      ['Procedures', 'Prices and sittings, and Packages: a procedure with sittings and one price, so reception can pick it instead of typing.'],
      ['Booking rules', 'Booking windows. Also the calendar text size for the whole clinic.'],
      ['Privacy & access', 'Where staff can work from, hidden phone numbers, how soon a quiet screen signs out.'],
    ]} />
    <Warn>Settings has a <b>Clear everything and load test data</b> button at the bottom of Settings, Clinic details. It deletes every patient, visit, bill and message in the clinic and loads sample data. Use it only on a test clinic. You must type RESET.</Warn>
    <H2 id="owner-reports">Owner: reports</H2>
    <P><b>Dashboard</b> shows a tile for each doctor (patients, new against review, money paid and pending), a line of patients per day, and the times that matter, each compared with the period before. <b>Reports</b> has the daily report and End of day. <b>Audit log</b> lists every change with who made it.</P>
  </>);
}

const TOC: Record<Guide, [string, string][]> = {
  reception: [['frontdesk', 'Front desk'], ['checkin', 'Check in'], ['checkout', 'Checkout'], ['tests', 'Test reports'], ['procedures', 'Procedures'], ['payments', 'Payments'], ['followups', 'Follow-ups'], ['patients', 'Patients'], ['booking', 'Calendar'], ['endofday', 'End of day']],
  doctor: [['doctor-day', 'The consultation']], junior: [['junior-day', 'Screening']], pharmacy: [['pharmacy-day', 'Pharmacy counter']], owner: [['owner-settings', 'Settings'], ['owner-reports', 'Reports']],
};

const FAQ: [string, string][] = [
  ['Close visit is grey', 'Something above it is still open. Look for a line with a button. If the patient will not do it today, use the … menu on that line: Patient declined, or Do later.'],
  ['I cannot take a payment: the day is closed', 'The owner already closed today. Ask the owner. A mistake after closing is fixed by a refund.'],
  ['The screen refuses a second free review', 'One free review is allowed after a paid consultation. Choose the paid consultation, or ask the owner to allow one more.'],
  ['I cannot see prices', 'Your role does not have “See fees and payments”. This is on purpose for junior doctors. Ask the owner if you need it.'],
  ['I cannot find a patient', 'Try the phone digits. Families share phones, so you may see several people. Check the age. If they are truly new, register them.'],
  ['The patient says nobody called', 'Open the patient, then the Missed tab. Every call you or a colleague logged is listed with the date and result.'],
  ['I do not see a button the guide mentions', 'Buttons only show to roles that may use them. Ask the owner to check your role under Settings, Roles and access.'],
];

/** Plain-words guide to how the clinic runs, one place, reachable from any page with the ? button. */
export function Help() {
  const { perms } = useOutletContext<any>(); const nav = useNavigate(); const [sp] = useSearchParams();
  const from = (sp.get('from') ?? '').split('/')[0]; const ctx = CONTEXT[from];
  const mine: Guide = can(perms, 'config.write') && !can(perms, 'visit.write') ? 'owner' : can(perms, 'visit.write') ? 'reception' : can(perms, 'encounter.complete') ? 'doctor' : can(perms, 'encounter.intake') ? 'junior' : can(perms, 'pharmacy.read') ? 'pharmacy' : 'reception';
  const [guide, setGuide] = useState<Guide>(ctx?.guide ?? mine);
  useEffect(() => { if (ctx?.anchor) setTimeout(() => document.getElementById(ctx.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); }, [ctx?.anchor, guide]);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="max-w-4xl">
      <PageHeader title="How the clinic runs" subtitle="A simple guide. Read the picture first, then your own part.">
        <button className="btn no-print" onClick={() => history.length > 1 ? nav(-1) : nav('/')}><Icon name="chevL" className="h-4 w-4" />Back</button>
        <button className="btn no-print" onClick={() => window.print()}><Icon name="print" className="h-4 w-4" />Print</button>
      </PageHeader>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2"><span className="text-sm text-muted">Show the guide for</span><Segmented<Guide> value={guide} onChange={setGuide} options={GUIDES.map(([v, l]) => ({ value: v, label: l }))} /></div>
      <div className="no-print mb-6 flex flex-wrap items-center gap-1.5"><span className="mr-1 text-xs font-semibold uppercase tracking-wider text-muted">Jump to</span>
        {[['journey', 'The day in one picture'], ['money', 'Where money is taken'], ...TOC[guide], ['words', 'Words'], ['faq', 'If something looks wrong']].map(([id, l]) => <button key={id} className="toggle-opt !py-1 text-[13px]" onClick={() => go(id)}>{l}</button>)}</div>
      <article>
        <Overview />
        {guide === 'reception' && <Reception />}{guide === 'doctor' && <Doctor />}{guide === 'junior' && <Junior />}{guide === 'pharmacy' && <Pharmacy />}{guide === 'owner' && <Owner />}
        <H2 id="faq">If something looks wrong</H2>
        <div className="my-3 space-y-2">{FAQ.map(([q, a]) => <details key={q} className="rounded-2xl border border-line bg-white/70 px-4 py-3"><summary className="cursor-pointer text-sm font-semibold">{q}</summary><p className="mt-2 text-sm leading-relaxed text-ink-2">{a}</p></details>)}</div>
        <div className="mt-8 text-xs text-muted">Still stuck? Tell the owner exactly what you tapped and what the screen said. <Chip>Tip</Chip> Press the ? button at the top of any page to come back here.</div>
      </article>
    </div>
  );
}
