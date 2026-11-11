# Cubott OPD — Full UX & Safety Audit and Free-Hand Redesign

**Date:** 10 Nov 2026 · **Scope:** the web app in `web/src` (+ the server rules in `src/modules` that decide what each screen can do) · **Method:** code read of every route, component and role definition · **Code changed:** none.

> How to read this: Part 1 is for everyone (10 minutes). Part 2 onward is for designers and developers. The per-screen detail (every issue with file:line, severity, cognitive-load reason and fix, plus wireframes) is in Appendices A–G at the end of this file.

---

## Contents

1. Executive summary
2. Coverage: what was audited, and what could not be
3. Screen inventory
4. Per-role analysis
5. Cross-cutting findings
   - 5.1 Top 10 problems, ranked by user impact
   - 5.2 Core flows: clicks and time, today vs proposed
   - 5.3 Inconsistent patterns and a unified design system
   - 5.4 Menu and navigation restructure per role
   - 5.5 Jargon and microcopy table
6. Free-hand redesign (from scratch)
7. Prioritised action plan (quick wins / 1–2 weeks / big redesigns)
- Appendix A — App shell, login, shared components, TV display, patient link, platform
- Appendix B — Front desk / reception
- Appendix C — Doctor and junior doctor (Today, Rx pad, print)
- Appendix D — Calendar, bookings, patients, follow-ups, broadcast
- Appendix E — Procedures, courses, packages, test reports
- Appendix F — Pharmacy and inventory
- Appendix G — Owner / admin (dashboard, reports, expenses, settings, roles, audit)

---

## 1. Executive summary

**The verdict in one line:** the app is thoughtfully written and already plainer than most clinic software, but it currently has **more than 50 Critical findings** — places where it can harm a patient, take or count money wrongly, or show private data to the wrong person — and those must be fixed before any visual redesign. The screens themselves are too dense for a new user to read in 5 seconds; most pages carry 10–15 competing controls.

**What is good (keep it):** plain-English copy in many places; one "+" menu and Ctrl‑K for everything you start; role-based landing pages; an Rx pad that is genuinely fast for an expert; good modal focus handling; reduced-motion respected; idempotency keys on some payments; an audit log; per-role permission catalogue in plain words.

**What is dangerous (fix first) — verified in code:**

| Area | The risk in plain words | Where |
|---|---|---|
| Prescribing | The allergy check is a short word list. "Augmentin" for a penicillin-allergic patient is **not** flagged, and the pad then says "allergy checked: no clash found". No drug–drug, duplicate or pregnancy check (isotretinoin is in the medicine list). | `Encounter.tsx:37-46, :562` |
| Prescribing | Quantity is worked out from the first number in the dose: "500 mg, 1‑0‑1, 7 days" = **7000 tablets**; the pharmacy pre-fills the bill with the whole shelf. | `rxLine.ts:34`, `pharmacy.ts:24` |
| Prescribing | "Preview" prints a draft that looks identical to a signed prescription; printing right after Finish can print the old version. | `PrintRx.tsx`, `clinical.ts:209` |
| Labs | The doctor's review dialog shows no typed values and no red flags, and the outcome starts at "Normal": one click closes an abnormal report as normal. | `TestReports.tsx:92-117` |
| Procedures | No consent is recorded before a laser/peel sitting. | `ProcSchedule.tsx:99`, `procDrawer.tsx:53` |
| Billing | A sitting booked from Procedures without a course is **never charged** when marked done. | `courses.ts:33` |
| Billing | "Collect" records **cash** in one tap, no confirm, no UPI/card choice; a double-tap records two payments. Check-in accepts any amount. | `FrontDesk.tsx:87`, `visits.ts:117` |
| Billing | A refund only changes the bill's status: End of day still counts the money. The Daily report and End of day show **two different "Collected" totals** for the same day. | `billing.ts:40`, `dayclose.ts`, `Reports.tsx:30` |
| Pharmacy | Schedule H/H1/X drugs can be sold without a prescription, and extra items on an Rx bill go into the register under the doctor's name. A timed-out sale retried = billed twice. Returned opened tubes go back on the sellable shelf. | `pharmacy.ts:144, :301, :330` |
| Privacy | Every list's **Export** button downloads names and phones (and diagnoses on Follow-ups) for any role, skipping the owner-only rule and the audit log. Front desk and pharmacy see diagnoses on the Patients list. Junior doctors receive all prices. | `table.tsx:83`, `Patients.tsx:53`, `identity.ts:55` |
| Access | An admin can make themselves Owner, and can lock the owner out (change their password/email, remove Owner). There is no "forgot password". "Test data → RESET" wipes a live clinic. | `admin.ts:74`, `sample.ts:32` |
| Login | The login page lists demo accounts including the platform superadmin and pre-fills `demo1234`. | `Login.tsx:7-14` |

**What makes it hard to use (cognitive load):**
1. **Too many things on one screen.** Front desk header: 9 stage tiles + toggles ≈ 13 controls before the first patient. Settings: 18 topics, prices spread across 5 of them. Rx pad: 3 layouts, T‑logo template buttons on every section.
2. **The same thing has many names.** "Still to arrive / Not yet arrived / Booked, not arrived / Booked, not here yet". "Reports awaited / Reports pending / Awaiting reports". Three different booking forms.
3. **Failures look like success or emptiness.** A network error shows "No patients found", "Nobody to call here", "Every room is free" — on patchy internet this creates duplicate patients and missed calls. There is no offline indicator anywhere.
4. **No undo, inconsistent confirms.** Some destructive actions confirm, many don't; Enter confirms delete dialogs; a click outside a dialog wipes a half-filled check-in form.
5. **English only, small type, heavy visuals.** 14px base, 11–12px secondary text, 30–32px controls on tablets, blur/glass effects on every card (slow on low-end PCs). No Hindi/Telugu except the Rx print phrase table.

**The direction:** fix the safety and money bugs (2–3 weeks), then simplify every role down to **one home screen with one primary action**, one patient drawer used everywhere, one way to pay, one way to book, and plain words from one vocabulary list. Section 6 shows what that looks like.

**Size of the work:** 22 quick wins under a day each; ~20 medium items of 1–2 weeks; 6 big redesigns (Section 7).

---

## 2. Coverage

**Total audited: 224 surface entries** (screens, tabs, popups, drawers, dropdowns, toasts, empty/error/loading states, confirm dialogs and print views), across **24 routes**, **7 built-in roles + platform superadmin**, ~33 page files and ~25 shared components (≈1.15 MB of UI code). After removing overlaps between areas (vitals, procedure drawer, packages card, change-my-day appear in two areas each), that is **about 215 distinct surfaces**.

| Area | Surfaces | Appendix |
|---|---|---|
| App shell, shared components, login, help, TV, patient link, platform | 35 | A |
| Front desk / reception | 30 | B |
| Doctor + junior doctor (Today, Rx pad, print) | 38 | C |
| Calendar, bookings, patients, follow-ups, broadcast | 39 | D |
| Procedures, courses, packages, test reports | 22 | E |
| Pharmacy + inventory | 26 | F |
| Owner / admin (dashboard, reports, expenses, settings ×18, roles, audit) | 34 | G |
| **Total** | **224** | |

**Findings by severity (approximate; some issues appear in two areas):** Critical: more than 50 · High: well over 100 · Medium/Low: several hundred.

**What could not be inspected (be aware):**
- **Nothing was run in a browser.** No screenshots, no real device, no timing. Visual hierarchy, contrast and speed claims come from CSS and code; mark them *to verify on device*. Times in 5.2 are estimates.
- **Not read in detail:** the End-of-day *view* internals and `errText` mapping (partly), the WhatsApp message worker, the `/orders` endpoint, rxpad vital ranges, `printPreview.tsx` internals, the Modal focus code for every dialog.
- **Behaviour assumed, not tested:** how TanStack Query retries affect the TV display and clock; how Android handles `capture="environment"` on the report upload; whether demo/seed accounts exist in production; whether clinic fees include GST; the current GST slab for medicines after the 2025 GST changes (confirm with the clinic's CA).
- **Parked code:** `pages/Overview.tsx` (route redirects to Dashboard) — noted only. `ResultDialog` / "Recent results" in `Worklist.tsx` are unreachable.
- **Uncommitted work** (procDrawer, oat theme, first-visit changes) was audited as it is on disk today.

Every finding in the appendices cites `file:line`. Anything inferred is marked **ASSUMPTION**.

---

## 3. Screen inventory

### 3.1 Routes × roles

Who sees each page in the menu (from `web/src/App.tsx` NAV + `src/lib/auth.ts` DEFAULT_ROLES). ● = in menu and landing page, ○ = in menu, — = hidden (typing the URL shows "No access").

| Route | Page | Owner | Admin | Doctor | Junior dr | Reception | Coordinator | Pharmacy |
|---|---|---|---|---|---|---|---|---|
| `/login` | Login (role cubes) | all | | | | | | |
| `/dashboard` | Dashboard | ○ | ○ | ○ | — | — | — | — |
| `/today` | Today (doctor's list) | ● | — | ● | — | — | — | — |
| `/queue` | Front desk board | ○ | ● | — | ● | ● | — | — |
| `/calendar` | Calendar (+ Book panel) | ○ | ○ | ○ | — | ○ | ○ | — |
| `/bookings` | Bookings list | ○ | ○ | ○ | — | ○ | ○ | — |
| `/patients`, `/patients/:id` | Patients + profile | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| `/encounter/:id` | Rx pad / consultation | ○ | — | ○ | ○ (intake) | — | — | — |
| `/worklist` | Procedures | ○ | — | ○ | — | ○ | ● | — |
| `/followups` | Follow-ups | ○ | — | ○ | — | ○ | ○ | — |
| `/tests` | Test reports | ○ | — | ○ | — | ○ | ○ | — |
| `/pharmacy` | Pharmacy counter / bills / register | ○ | — | — | — | — | — | ● |
| `/inventory` | Inventory | ○ | — | — | — | — | — | ○ |
| `/reports` | Reports | ○ | ○ | — | — | ○ | — | — |
| `/expenses` | Expenses | ○ | ○ | — | — | ○ | — | — |
| `/settings` (18 tabs) | Settings | ○ | ○ | — | — | — | — | — |
| `/audit` | Audit log | ○ | ○ | — | — | — | — | — |
| `/help` | Help | all | | | | | | |
| `/platform` | Clinics (superadmin) | superadmin only | | | | | | |
| `/print/:id` | Prescription print | outside shell | | | | | | |
| `/a/:slug/:token` | Patient link (public) | patient | | | | | | |
| `/display/:slug/:token` | Waiting-room TV (public) | TV | | | | | | |

Plus redirects: `/overview` → `/dashboard`, `/booking` → `/calendar?book=1`, `*` → Not found.

**Observation:** a coordinator lands on Procedures but sees 7 menu items; a receptionist sees **10**; an owner who is also the doctor sees **16**. Nobody needs more than 5 for their day.

### 3.2 Surfaces by area (summary — full list with file:line in each appendix)

| Area | Main surfaces |
|---|---|
| **Shell (A)** | Sidebar, icon rail, mobile drawer, top bar, "+" New menu, mobile account menu, theme toggle, header search, Ctrl‑K palette, app loading, page-crash fallback, No access, Not found, idle sign-out, toasts, confirm dialog, standard modal, filter dropdown, More menu, tabs/segmented, empty/skeleton/stat, money & number inputs, DataTable (sort/filter/columns/export/paging), document viewer, print preview, flag chips, careful banner, flag editor, guardian picker, Login, Help, TV display, Patient link, Platform list, Onboard-a-clinic, Overview (parked) |
| **Front desk (B)** | Board shell + 9 stage tiles, "Doctor is calling" banner, For you now, table tabs ×6, bulk bar + confirm, "Who has arrived?" search, check-in form, duplicate-patient banner, review-limit dialog, journey drawer, filmstrip, pending tests & procedures (+ decline/close dialogs), reports awaited, history panel (+ filter, print, export), Schedule view, Book modal, toasts, Take payment, EMI awaiting + bank match, invoices (+ discount/cancel/refund/leave-out-of-tax), receipt print, End of day, Change my day, Weekly routine, packages card, screening block, vitals |
| **Doctor (C)** | Today (list, cards, counts), pad header & patient identity, layouts (Stacked/Focused/Review), type-anything bar + scoped search, symptoms, diagnosis, examination + body map dialog, templates + Load previous, Review card, follow-up, labs + Add lab values + history pop-over, medicines sheet, history chips, vitals tiles + past values, past visits + previous consultation modal, photos + consent, bottom bar/Finish/autosave, pad loading/error/read-only/held states, print preview, `/print/:id`, results sheet, junior intake |
| **Scheduling & patients (D)** | Calendar shell, colour key, search, attention strip, Patients-to-call modal, waiting list, doctor day, all-doctors cards, week grid, rooms day/week, block room, Book modal, BookPanel, overbook dialog, change my day, weekly hours, procedure drawer, Bookings list, New booking modal, BookForm, appointment drawer, cancel panel, move picker, Patients list, Register patient, profile header, inline edit, profile sections, Follow-ups list, Log call, bulk bar, closed-day confirm, Broadcast steps 1–3, sent messages, sent detail, toasts |
| **Procedures & tests (E)** | Procedures header/view switch, Schedule tab, cancel-sitting confirm, assign doctor, schedule/reschedule modal, Board tab, Plans to schedule, Log a call, cancel booked sitting, (unreachable) ResultDialog, sitting drawer, CourseDialog (price/quote/advance/refund), CoursesCard, PackagesCard, Test reports tabs + order cards, ReportDialog, ReviewDialog, lab results card on pad, toasts |
| **Pharmacy (F)** | Page shell (Counter/Bills/Register), counter stats, today's prescriptions, medicines grid, This bill panel, walk-in picker, allergy alert, counter confirms, Take payment, Payment taken (+Void), printed bill, Bills tab, bill detail (reprint/issue rest/return/cancel), Schedule H register, Inventory shell, Stock tab, delivery decision, batches & expiry, medicine detail + adjust, return to vendor, stock count, Orders tab, order/return detail, new PO, receive stock, vendors (+ account, write-off), toasts |
| **Owner/admin (G)** | Dashboard, Daily report, Expenses, Settings home, topic shell, Clinic details, Day at the desk, Staff & doctors, Roles, Privacy & security, Audit log, Weekly hours, Visit types, Booking rules, WhatsApp reminders, Rx pad settings, Consultation form fields, Templates, Medicines, Procedures & packages, Rooms, Photo areas, Consultation fees, Test data, shared states |

---

## 4. Per-role analysis

Each role: who they are, where they land, what they need, what gets in the way. Severity counts are the worst items affecting that role. Details: the appendix named.

### 4.1 Receptionist ("Reception") — Appendix B, D

- **Who:** often the least digital-confident person in the clinic, under the most pressure, phone ringing, queue in front of them. Main jobs: register/find patient, check in, take consult fee, book, answer "how long?".
- **Lands on:** Front desk board (`/queue`). **Menu:** 10 items (Front desk, Calendar, Bookings, Patients, Procedures, Follow-ups, Test reports, Reports, Expenses, Help).
- **What blocks them:**
  - **Can't search the board** (`const find = ''`, `FrontDesk.tsx:54`) — "where is Meena?" needs scrolling across tabs.
  - **13 header controls** before any patient row; 6 table tabs whose names overlap with tile names.
  - **Money traps** (Critical): one-tap cash Collect, no amount bounds at check-in, refund that moves no money, one-character waive reason, no receipt number for check-in fees, receipt "Received by" shows whoever printed.
  - **Duplicate patients** (Critical): exact name+phone match only; failed search looks like "not found".
  - **Lost work:** Esc or clicking outside the check-in dialog throws the whole form away.
  - **Can't close the day** — the role lacks `day.close`, yet the desk is who counts the drawer.
  - Sees diagnoses on the Patients list and can export patient lists (privacy, Critical).
- **Doesn't need:** Expenses and Reports in the main menu (once a day → move under "End of day"); Bookings *and* Calendar (merge); Test reports *and* Follow-ups as separate pages (they are both "people to call").
- **Needs but can't find:** a search box on the board; a receipt at check-in; a clear "who is next for which doctor and how long" view for phone queries; Close the day.

### 4.2 Doctor (and Owner-doctor) — Appendix C, E

- **Who:** ~6 minutes per patient; wants to see the patient, write the Rx, print, next.
- **Lands on:** Today (`/today`). **Menu:** Doctor 6 items; Owner-doctor 16.
- **What blocks them:**
  - **False safety** (Critical): allergy word-list misses brands/classes and says "no clash found"; no interactions/duplicates/pregnancy; infant age hidden (`ageYears ? …` treats 0 as missing).
  - **Medicine lines can print incomplete**; grey placeholders look like real values; Finish doesn't require frequency/duration.
  - **Draft vs final print look identical**; stale print after Finish.
  - **Invisible autosave failure** — the bar keeps "Saved hh:mm"; no local copy; junior and doctor can overwrite each other.
  - **No amend after Finish** — a wrong dose spotted 2 minutes later cannot be corrected with a reason.
  - **Lab review** shows thumbnails, not values; defaults to "Normal".
  - Load: 3 pad layouts, T‑logo template buttons per section ("T Sx", "T Dx", "T O/E"…), "Load previous / Save / Clear" on every section header.
- **Doesn't need:** Bookings, Follow-ups, Procedures as full pages (a doctor *reads* these; a strip on Today is enough); revenue of other doctors on the Dashboard.
- **Needs but can't find:** abnormal results needing sign-off on Today; one-tap "same as last visit"; a sign-off sheet at Finish that shows exactly what will print.

### 4.3 Junior doctor (assistant) — Appendix C, B

- **Who:** screens patients before the doctor (history, vitals, complaints).
- **Lands on:** Front desk board (`/queue`) — a reception screen, not a screening screen. **Menu:** Front desk, Patients.
- **What blocks them:** "All the rest: No" records questions that were never asked as "No" (clinical record integrity, High). Their autosave flips the visit to "screened" every 15 s, unlocking the doctor while they are still writing. Receives all prices via `/config` despite "no fees" role.
- **Ideal:** own home "Patients to screen" with one big "Start screening" per row; nothing else.

### 4.4 Coordinator (procedures) — Appendix E, D

- **Who:** books and runs procedure sittings (peels, laser), collects procedure payments, calls patients.
- **Lands on:** Procedures (`/worklist`), which **opens on Tomorrow**, not today (`ProcSchedule.tsx:24`).
- **What blocks them:** Start and Mark done hidden in "⋯", no confirm, no undo — and Mark done creates the charge. Rows don't say "prepaid / ₹X due". Taking payment means leaving to the patient record (~9 clicks). No consent step. Two separate call logs (Procedures vs Follow-ups) that don't see each other → patient called twice. Packages above the discount cap fail with a permission error at the desk.
- **Ideal:** "Today's sittings" home: each row = time · patient · procedure · sitting 3 of 6 · **Prepaid / ₹2,500 due** · [Consent ✓] [Start] → [Done & collect].

### 4.5 Pharmacist — Appendix F

- **Who:** counter staff; speed and correctness; maybe a barcode scanner.
- **Lands on:** Pharmacy counter. **Menu:** Pharmacy, Inventory, Patients.
- **What blocks them:** prescription quantity disagrees with the doctor's; tapping a prescription silently moves earlier walk-in items onto that patient's bill; UPI requires typing a 12-digit UTR (no QR); allergies shown only on Rx bills; near-expiry stock sells silently; batch/expiry not on Rx lines; Void is one tap; returns default to cash refund even when paid by UPI. Receiving a delivery is blocked if the bill is off by >₹5 (no round-off/freight field). Every OTC sale creates a junk patient record.
- **Ideal:** see Section 6 wireframe "Pharmacy counter".

### 4.6 Owner / Admin — Appendix G, A

- **Who:** the owner is usually also the senior doctor: little time, wants "how did we do yesterday, is cash right, is anything wrong?".
- **Lands on:** Today (owner) / Front desk (admin). **Menu:** 16 items.
- **What blocks them:** two different "Collected" totals; cash/UPI split is a tiny grey line; Settings has 18 topics and fees live in 5 places (and the visit-type "Fee (₹)" isn't even what gets charged); fee changes apply instantly mid-day with no confirm, audited as `amountPaise 50000`; deactivated doctors/fees vanish forever; medicine GST defaults to 12%; WhatsApp settings use Meta Cloud API wording.
- **Access risks (Critical):** admin → Owner self-promotion; owner lockout; RESET wipe on a live clinic; IP allow-list saves instantly (can lock the desk out mid-OPD).
- **Ideal:** an owner home with **three cards: Yesterday (by mode, matching End of day), Today live, Needs you (approvals, abnormal results, stock to approve)**. Settings regrouped into 6 topics with one **Prices** screen.

### 4.7 Platform superadmin — Appendix A

- Platform list + Onboard-a-clinic. Issues: the clinic sign-in name field sticks at the first letter typed (`Platform.tsx:47`); superadmin email shown on every clinic's login page.

### 4.8 Patients (public surfaces) — Appendix A

- **Patient link:** one tap on a time slot moves the booking with no confirm; English only.
- **Waiting-room TV:** one failed poll replaces the board with "This screen link is not valid"; chime never plays (needs a click nobody makes); clock may freeze (ASSUMPTION).

---

## 5. Cross-cutting findings

### 5.1 Top 10 problems, ranked by user impact

| # | Problem | Who it hurts | Severity | Fix in one line |
|---|---|---|---|---|
| 1 | **Prescribing safety net is fake** — allergy word list misses brands/classes and claims "no clash found"; no interaction/duplicate/pregnancy check; infant age hidden; incomplete lines print. | Patients, doctor | Critical | Allergy classes mapped to the medicine master (generic + class per medicine), hard stop to acknowledge, interactions for the derm top 30, pregnancy flag in header, block Finish on incomplete lines, print age in months under 2 y. |
| 2 | **Money is counted in two ways and leaks** — one-tap cash collect, unbounded check-in amount, refunds that move no money, two "Collected" totals, unbilled sittings, double pharmacy sale on retry. | Owner, reception, pharmacy | Critical | One payment sheet everywhere (mode required, amount = due by default, per-intent idempotency key), refunds as money-out rows, one "Collected" definition used by Reports and End of day, charge created when a sitting is booked or done regardless of course. |
| 3 | **Private data reaches the wrong roles** — Export on every list, diagnoses on reception/pharmacy screens, prices to junior doctors, TV token to every role, demo passwords on login. | Patients, clinic | Critical | Remove client-side export (server `listOut()` only), strip diagnosis from non-clinical roles server-side, filter `/config` by `fees.see`, remove the demo block in production. |
| 4 | **Access control holes** — admin → owner, owner lockout, no password reset, RESET on live clinics. | Owner | Critical | Only owners grant Owner; never remove the last owner; self-service password change + reset via owner; Test data only on test tenants. |
| 5 | **Network failure looks like "empty"** — "No patients found", "Nobody to call", "Every room is free", TV "link not valid", login bounce on `/me` failure; no offline banner. | Everyone, especially reception | High (Critical where it creates duplicate patients) | Every list distinguishes *loading / error / empty*; one global "No internet — changes are not saved" strip; retry `/me`, only redirect on 401. |
| 6 | **No undo, inconsistent confirms** — some destructive actions confirm, many don't; Enter confirms delete; Esc/backdrop wipes forms. | Everyone | High | One rule: money and deletes confirm with *verb + object + amount*; everything else acts at once with an Undo toast (8 s); dialogs with input ask before closing; focus lands on Cancel for danger. |
| 7 | **Screens are too dense** — 13 header controls on the board, 18 settings topics, 3 pad layouts, T‑logo buttons on every section, 9 stage tiles. | New staff | High | One home per role with one primary button; progressive disclosure; remove layouts and per-section toolbars (Section 6). |
| 8 | **Same thing, many names; three booking forms** — stage names, "Plan/Schedule", "Record/Profile/Open record", BookPanel vs NewBooking vs window form. | Everyone | High | One vocabulary list (5.5) and one booking sheet. |
| 9 | **Lab and procedure loops don't close** — abnormal values hidden from the reviewing doctor, consent never recorded, two call logs, follow-up "Booked" without a booking. | Patients, coordinator | Critical/High | Abnormal-first review with values; consent step before Start; one shared "calls" list; "Booked" only through a booking. |
| 10 | **Not built for Indian low-end, multilingual reality** — English only; 14px base; 30–32px tap targets on tablets; heavy blur/glass; UPI by typing 12 digits; receipt not a GST tax invoice; medicine GST default likely wrong. | Patients, pharmacy, reception | High | UPI QR on the payment sheet; GST tax invoice format; 16px base / 44px targets on touch; drop blur on low-end; Telugu/Hindi for patient-facing surfaces first. |

### 5.2 Core flows: today vs proposed

Clicks counted from code paths; times are estimates (no device test).

| Flow | Today | Proposed | What removes the steps |
|---|---|---|---|
| **Registration + check-in** (new walk-in, consult fee by UPI) | 7 clicks + 3 typed fields + search; ~90 s; duplicate risk | **3 clicks** (phone → "New patient: name, age, sex" → Check in & pay UPI QR) ~40 s | Phone-first search shows family members on that number; check-in and payment on one sheet; UPI QR instead of typing UTR |
| **Booked patient arrives** | 3 clicks (cash) / 4 (UPI) + scroll | **2** (tap row → "Arrived · ₹500 UPI") | Booked list on the board is the default view; payment inline |
| **Appointment** (existing patient by phone) | 4–8 clicks, three possible forms | **3–4** (+ → phone → pick time) | One booking sheet; time chips for next free slots |
| **Reschedule** | ~6 clicks, no confirm, WhatsApp sent immediately | **3–4** with Undo | Move picker with confirm line "Move Meena to Thu 10:30 and send WhatsApp?" |
| **Consultation + prescription** (follow-up, 3 medicines, 1 test, follow-up date → print) | 10–12 clicks, 3–5 scrolls, ~20 keystrokes; ~60–90 s | **8–9 clicks, no scroll, 0–2 keystrokes; ~25–35 s** | "Same as last visit" pre-fill, inline chips for usual doses, follow-up chips (2 wk / 1 mo), Finish = sign-off sheet with print |
| **Billing** (procedure day) | ~9 clicks, leaves the page to the patient record | **3** (Start → Done & collect → mode) | Prepaid/due shown on the row; payment sheet opens from the row |
| **Pharmacy** (dispense Rx, UPI) | 9 actions + typing 12 digits | **3** (pick Rx → check lines → UPI QR paid) | Quantities from the doctor's own Qty; FEFO batch auto; QR |
| **Pharmacy** (OTC sale) | 9 actions; creates a junk patient record | **3** | "Walk-in (no record)" default; phone optional |
| **Pharmacy** (receive 5-line delivery) | ~33 actions; can be blocked by ₹5 check | ~21, never blocked | Round-off/freight fields; fast row entry |
| **Lab** (enter report → doctor sees it) | Upload forced through camera; doctor sees thumbnails only; one click marks "Normal" | Desk: 3 (pick test → values/PDF → save). Doctor: abnormal first on Today, values in red, outcome required | Values-first review; no default outcome |
| **Follow-up call list** | no answer 3; patient books ~8 + retyping | **1 / 2 / 3** via row buttons (No answer · Call later · Book) | Book opens the booking sheet pre-filled; booked rows leave automatically |
| **Owner: yesterday's takings by mode** | 3 clicks; two views disagree | **0** — on the owner's home | One "Collected" definition |
| **Add a receptionist** | 5 clicks + 3 fields; password told aloud | 4 clicks; generated password sent on WhatsApp, must change on first sign-in | |
| **Change consult fee** | 4 clicks (8 if the visit-type fee too); instant mid-day | 4 clicks on one Prices screen, default "from tomorrow" | |
| **End of day** | 4 clicks min (8–13 with no-shows); owner/admin only | 6–7 deliberately (counting is the point); reception can do it, owner approves differences | |

### 5.3 Inconsistent patterns → one design system

| Pattern | Today (examples) | Rule |
|---|---|---|
| **Confirm** | App `ask()`, browser `alert()` (`api.ts:96`) and `confirm()` (`Followups.tsx:111`); danger button outline-red vs filled rose; focus on the danger button | One dialog. Title = question; body = consequence; buttons = *verb + object (+ amount)* and Cancel; focus on Cancel. |
| **When to confirm vs undo** | Bulk no-show confirms; single no-show, Collect, Refund, Close day, package remove don't | Money, deletes, sending messages → confirm. Status changes → act now + 8 s Undo toast. |
| **Payment** | Cash default at check-in/Collect, UPI default in Take payment; per-call `uuid()` vs per-sheet key | One **Payment sheet**: amount (pre-filled with due), mode buttons *are* the submit (Cash / UPI QR / Card), key per intent, receipt number always. |
| **Patient detail** | Journey drawer, `/patients/:id` page, schedule chip → profile, sitting → `/worklist` | One **Patient drawer** everywhere (header: name, age/sex, P‑no, phone, allergy & careful flags); "Open full record" link. |
| **Booking** | BookPanel, NewBooking modal, window-click form | One **Booking sheet**. |
| **Errors** | inline amber, toast, raw codes (`FORBIDDEN:routine`) | Form errors inline under the field; action errors as sticky toast with Retry; never show codes. |
| **Empty vs error vs loading** | Bookings puts errors in the empty title; Patients/palette show nothing; TV says link invalid | Three distinct components: Skeleton · "Couldn't load — Retry" · Empty with one action. |
| **Dates** | "10 Nov" without year (`ui.tsx:410`), "10 Nov 2026", "Tue, 12 Nov", raw time on patient link | `10 Nov` this year, `10 Nov 2025` otherwise; weekday only in schedules. |
| **Times** | 12 h en-IN in some places, 24 h en-GB in Today/Booking/Calendar | 12 h "10:30 am" everywhere. |
| **Money** | `money()` keeps paise, `rupees()` unused, `errText` builds its own ₹ | One `₹1,250` formatter (paise only on GST invoices). |
| **Section switchers** | Segmented pills, underline tabs, DataTable tabs, Help dropdown | Underline tabs for pages; segmented only for 2–3 view modes. |
| **Tables** | DataTable (uppercase 11.5px) vs `.table` (sentence case 12px) | DataTable only; sentence-case headers 13px. |
| **Brand** | "CUBOTT Clinical", "Cubott OPD", "CUBOTT admin"; manifest orange, live teal | "Cubott OPD"; one accent token. |
| **Icons** | `inbox` for 3 sections, `chart` for 2, `spark` as photo and light theme | One icon per meaning. |
| **Colours** | `bg-white` hard-coded (breaks dark mode in Help, flags, viewer, patient link) | Tokens only. |

**Proposed unified design system (minimum set):**

- **Type:** 16px base on touch, 15px on desktop; minimum 13px; numbers tabular. Noto Sans + Noto Sans Telugu/Devanagari fallback.
- **Touch targets:** 44px on coarse pointers (tablets too, not only <768px); 36px minimum on desktop.
- **Colour:** neutral surface, one accent (teal), and **four status colours that mean the same thing everywhere** — red = stop/danger/abnormal/allergy; amber = needs attention; green = done/paid; blue = info/in progress. Never colour alone: always an icon or word.
- **Surfaces:** flat cards, no blur by default (glass only on high-end, opt-in).
- **Components (12):** Button (primary/secondary/danger/ghost) · Field (label above, hint, inline error) · Phone field (+91 paste-safe) · Money field · Search-or-create field · Patient header strip · Patient drawer · Payment sheet · Booking sheet · Confirm dialog · Toast with Undo · List with Skeleton/Error/Empty states.
- **Layouts (3):** Home (one hero action + one list) · List + drawer · Full-screen task (Rx pad, counter, check-in).
- **Copy rules:** verbs on buttons; numbers with units; no codes; one name per thing (5.5); sentences under 12 words.

### 5.4 Menu and navigation per role

Principle: **5 items or fewer**, home first, everything else reachable by the patient drawer or Ctrl‑K. Owners with several roles get a role switch at the top ("Working as: Doctor ▾") instead of the union of all menus.

| Role | Today (count) | Proposed menu |
|---|---|---|
| **Reception** | Front desk, Calendar, Bookings, Patients, Procedures, Follow-ups, Test reports, Reports, Expenses, Help (10) | **Desk** (home) · **Appointments** (Calendar+Bookings merged) · **Patients** · **Calls** (Follow-ups + report pickups + procedure calls in one list) · **Close day** (End of day, expenses, daily report) |
| **Doctor** | Dashboard, Today, Calendar, Bookings, Patients, Procedures, Follow-ups, Test reports (≈8) | **Today** (home, with "Results to sign" and "Procedures today" strips) · **Patients** · **My week** (calendar read-only) |
| **Junior doctor** | Front desk, Patients | **To screen** (home) · **Patients** |
| **Coordinator** | Calendar, Bookings, Patients, Procedures, Follow-ups, Test reports, Help | **Sittings today** (home) · **To book** (plans) · **Calls** · **Patients** · **Rooms** (week) |
| **Pharmacist** | Pharmacy, Inventory, Patients | **Counter** (home) · **Bills** · **Stock** · **Register** (H/H1) |
| **Owner** | 16 items | **Home** (Yesterday · Today · Needs you) · role switch to Doctor/Desk · **Money** (reports, expenses, end of day) · **Settings** (6 groups) · **Audit** |
| **Admin** | ~12 | Owner's menu minus Audit/privacy/test data |

Settings regrouped from 18 topics to **6**: **Clinic** (details, hours, rooms) · **People** (staff, doctors, roles) · **Prices** (consult fees, visit types, procedures, packages, medicines MRP & GST, discount cap — one screen) · **Bookings** (rules, reminders/WhatsApp) · **Prescription** (pad, forms, templates, photo areas) · **Privacy & security** (owner only).

### 5.5 Jargon and microcopy

The most common or most confusing strings. Full tables (≈180 entries) are in each appendix's "Jargon and microcopy" section.

| Where | Current text | Proposed plain text |
|---|---|---|
| Board tiles | "Still to arrive" / "Not yet arrived" / "Booked, not arrived" / "Booked, not here yet" | **Not here yet** |
| Board tiles | "Reports awaited" / "Reports pending" / "Awaiting reports" | **Waiting for reports** |
| Board tiles | "Initial screening" / "with junior" | **With junior doctor** |
| Board tiles | "Pending tests" / "Pending tests & procedures" | **Tests & procedures to book** |
| Board | "For you now" | **Next for me** |
| Board row | "Explained" / "Mark as explained" | **Told the patient the plan** |
| Toast | "Collected" | **₹500 cash from Meena · Receipt · Undo** |
| Toast | "Updated" | **Arjun marked no-show · Undo** |
| Check-in | "Location today" | **Area / town** |
| Check-in | "Why they came" | **Main problem (optional)** |
| Rx pad tab | "Rxpad" | **Prescription** |
| Rx pad | "Stacked / Focused / Review" | *(remove the switch)* |
| Rx pad | "T Sx", "T Dx", "T O/E", "T Rx", "T Adv", "T Lab" | **Sets** (one button) |
| Rx pad | "Load previous" | **From last visit** |
| Rx pad | "Clear loaded (Acne)" | **Undo "Acne" set** |
| Rx pad | "… allergy checked: no clash found." | *(remove — false reassurance)* |
| Rx pad | "Quick add" | **Common** |
| Rx pad | "Type anything · medicines, symptoms, diagnosis, tests · "itra 100 1-0-1 7d"…" | **Add medicine, test, symptom…** |
| Booking | "Doctor, day and window, then the patient" | **Pick a time, then the patient** |
| Booking | "No windows left this day" | **No time free this day** |
| Booking | "New caller: name" | **New patient: name** |
| Booking | "Overbook anyway" | **Add anyway (over the limit)** |
| Calendar | "Change this day" | **Doctor late / away / leaving early** |
| Calendar | "3 / 7" | **3 of 7 booked** |
| Procedures | `open` / `contacted` / `scheduled` | **Not called / Called / Booked** |
| Procedures | "not confirmed" (amber, every row) | **Patient not called yet** |
| Procedures | "Mark patient confirmed" | **Patient said yes** |
| Procedures | "Blocks this doctor's OP capacity for the slot." | **Dr {name} gets no OPD bookings {from}–{to}.** |
| Procedures | "• room_blocked: …" | **Room closed …** |
| Pharmacy | "GRN-0001", "PO-0001", "CN-0001" | **Delivery 1, Order 1, Refund slip 1** |
| Pharmacy | "Lines at or under reorder" | **Medicines running low** |
| Pharmacy | "Scheme promised" | **Free offer (e.g. 10+1)** |
| Pharmacy | "Billed qty / Free got / Rate on bill" | **Paid qty / Free qty / Price per pack (before GST)** |
| Pharmacy | "Expiry runway" | **When each batch expires** |
| Pharmacy | "Pay the promised rate, vendor owes the free units" / "debit note" | **Pay agreed rate; ask vendor to return ₹X** |
| Settings | "Doctors (practitioners)" | **Doctors** |
| Settings | "Queue priority (0 = normal, up to 99)" | **Jumps the queue?** (No / Yes) |
| Settings | "Counts against window capacity" | **Uses a booking slot** |
| Settings | "Favourites" | **Medicines** |
| Settings | "Version N. Saving publishes a new version…" / "Publish new version" | **Save form** · "Past notes keep the form they were written on." |
| Settings | "A capability is a tag … Rooms cannot be treated as interchangeable." | **Tick what each room has. A procedure is only booked into a room that has it.** |
| Audit | `amountPaise 50000` | **₹500** |
| Errors | `FORBIDDEN:routine`, `CONFIRM_BY_TYPING_RESET`, raw codes | Plain sentence + who can do it ("Only the owner can change weekly hours.") |
| Network | "No patients found" (when the request failed) | **Couldn't reach the server. Retry** |

---

## 6. Free-hand redesign (from scratch)

### 6.1 Principles

1. **One screen, one job, one big button.** Every home screen answers the role's first question of the day and offers exactly one primary action.
2. **The patient is the unit.** Everything about a person — visit, bills, Rx, tests, sittings, calls — opens in one drawer with the same header (name, age/sex, P‑number, phone, **allergy and careful flags in red**). You cannot act on a patient whose header isn't on screen.
3. **Routine once, exceptions only.** Defaults do the routine (fee, doctor, follow-up interval, quantities, batch); people only touch exceptions. The screen highlights what needs a human (abnormal result, due amount, allergy clash).
4. **Safety stops, convenience undoes.** Anything that can harm a patient or move money **stops** and asks clearly. Everything else happens instantly with an Undo.
5. **Honest states.** Never show "empty" when the truth is "couldn't load". An always-visible connection dot; work saved locally and synced.
6. **Plain words, one vocabulary, patient languages.** Staff UI in English with simple words; anything a patient reads (Rx instructions, WhatsApp, patient link, TV) in English + Telugu/Hindi.
7. **Built for a ₹15,000 PC and a 4G hotspot.** No blur, no orbs, 16px text, 44px targets, works offline for the queue and the pad.

### 6.2 Home screen per role

**Reception — "Desk"**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [🔍 Phone, name or P-no ............................]  [+ Check in]  ● Online │
├──────────────────────────────────────────────────────────────────────────┤
│ Dr Sahitya  ▸ with: Ravi K (P-1042)   Next: Meena (≈10 min)   Waiting: 6   │
│ Dr Arjun    ▸ with: —                 Next: Faiz  (now)       Waiting: 2   │
├──────────────────────────────────────────────────────────────────────────┤
│ NOT HERE YET (booked today)                         WAITING                │
│ 10:30 Meena R  · Dr S · ₹500   [Arrived ▸]          1 Faiz A   Dr A  12m   │
│ 10:45 Lakshmi  · Dr S · Review [Arrived ▸]          2 Ravi K   Dr S   8m   │
│ 11:00 Kiran T  · Dr A · ₹500   [Arrived ▸]          3 …                    │
├──────────────────────────────────────────────────────────────────────────┤
│ NEEDS YOU (3):  ₹1,200 due – Suresh  ·  2 reports to hand over  ·  1 call   │
└──────────────────────────────────────────────────────────────────────────┘
```
- "Arrived ▸" opens the **Payment sheet** pre-filled (₹500 · Cash | UPI QR | Card); paying = checking in.
- Search box finds a patient on the board *or* in records; no match → "New patient" inline.
- Removed: 9 stage tiles, 6 tabs, filmstrip, bulk bar (bulk lives in a "Select" mode).

**Check-in / registration sheet (Critical screen redesign)**

```
┌ Check in ───────────────────────────────────────────────┐
│ Phone  [98765 43210]                                     │
│  Found 2 on this number:                                  │
│   ○ Meena R, F 34, P-1042 · last visit 12 Oct (Acne)     │
│   ○ Arjun R, M 8,  P-1043 · last visit 2 Sep             │
│   ○ Someone new on this number                           │
│ ─────────────────────────────────────────────────────── │
│ New: Name [          ]  Age [  ] ( M | F | Other )      │
│ Doctor (Dr Sahitya ▾)   Visit: New consult  ₹500         │
│ Allergies? ( None known | Yes: [        ] )   ← required │
│                                                          │
│ [ Cash ₹500 ]   [ UPI ₹500 (show QR) ]   [ Card ]        │
│ Waive or reduce…                                          │
└──────────────────────────────────────────────────────────┘
```
- Family-on-one-phone is the Indian norm: choose among them, never create silently.
- Allergy question is mandatory once ("None known" is an answer) — it feeds the Rx pad.
- Closing with unsaved input asks "Discard Meena's check-in?".

**Doctor — "Today"**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Today · Dr Sahitya         Waiting 6 · Seen 14 · Results to sign 2 (red)   │
├──────────────────────────────────────────────────────────────────────────┤
│ ▶ NEXT  Meena R · F 34 · P-1042 · ⚠ Penicillin allergy · Review (acne)    │
│         Screened by Dr Priya: wt 58 kg, BP 118/76, "itching worse"        │
│                                               [ Start consultation ]       │
├──────────────────────────────────────────────────────────────────────────┤
│ Then: Faiz A (new) · Ravi K (review) · Lakshmi (procedure check) …        │
│ Results to sign: Kiran T – Hb 9.1 (low) ⚠   ·  Anil – LFT normal           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Rx pad (Critical screen redesign)** — one layout, no per-section toolbars.

```
┌ Meena R · F 34 · 58 kg · P-1042 · ⚠ PENICILLIN · Pregnant? No ───── [Finish] ┐
│ Complaint  [itching worse ×] [+]          Diagnosis [Acne vulgaris ×] [+]     │
│ Findings   [comedones ×] [papules ×]  Body map ▸                              │
├───────────────────────────────────────────────────────────────────────────────┤
│ Medicines                        [Same as last visit]  [Sets ▾]               │
│  1 Doxycycline 100 mg   1-0-1  after food  14 d   Qty 28                       │
│  2 Adapalene 0.1% gel   at night, face     30 d   Qty 1                        │
│  3 [+ add medicine…]                                                           │
│  ⛔ Amoxyclav: Meena is allergic to penicillin. [Remove] [Override – reason]   │
├───────────────────────────────────────────────────────────────────────────────┤
│ Tests [CBC ×] [+]    Advice [Sunscreen ×] [+]    Follow-up ( 2 wk | 1 mo | … ) │
└───────────────────────────────────────────────────────────────────────────────┘
 Saved 10:42 ✓  (or: ⚠ Not saved — no internet. Kept on this computer.)
```
**Finish = sign-off sheet:** shows the exact print (with DRAFT watermark removed only on sign), lists any overrides, then [Sign & print] [Sign & WhatsApp]. After signing: **"Amend"** with a reason, reprints as "Amended".

**Junior doctor — "To screen"**: a list of waiting patients, one button "Screen", a short form (vitals, complaint, history chips with *unasked* as the default — no "All the rest: No"), "Ready for doctor".

**Coordinator — "Sittings today"**

```
┌ Sittings today · Room 1, Room 2 ─────────────────────────────────────────┐
│ 10:00 Anita S  Chemical peel  3 of 6  Prepaid ✓  Consent ✓   [Start]      │
│ 10:30 Rahul M  Laser hair     1 of 8  ₹2,500 due Consent —   [Get consent]│
│ 11:00 …                                                                  │
├──────────────────────────────────────────────────────────────────────────┤
│ To book: 4 plans waiting · Calls: 3                                       │
└──────────────────────────────────────────────────────────────────────────┘
```
Start requires consent on file (for first sitting of a procedure type). Done → Payment sheet if due.

**Pharmacist — "Counter"**

```
┌ Counter ──────────────────────────────────────────────── ● Online ──────┐
│ Prescriptions waiting:  Meena R (Dr S, 10:48) · Faiz A (Dr A, 10:52)     │
├──────────────────────────────────────────────────────────────────────────┤
│ Meena R · F 34 · P-1042 · ⚠ PENICILLIN          Rx by Dr Sahitya 10:48    │
│  Doxycycline 100 mg   Rx 28  Give [28]  Batch D23 · exp 05/27  ₹ 168     │
│  Adapalene gel 15 g   Rx 1   Give [1]   Batch A11 · exp 02/26 ⚠ near   ₹ 245 │
│  + add item (OTC)          Schedule H items need this Rx ✓                │
│                                         Total ₹413 (GST incl.)            │
│        [ Cash ]   [ UPI – show QR ]   [ Card ]                            │
└──────────────────────────────────────────────────────────────────────────┘
```

**Owner — "Home"**

```
┌ Yesterday · Mon 9 Nov ───────┐┌ Today so far ──────────────┐┌ Needs you (4) ───────────┐
│ Collected  ₹48,250           ││ Patients 31 · Waiting 6     ││ 1 day not closed (Sat)   │
│ Cash 18,400 · UPI 26,850     ││ Collected ₹21,300           ││ 2 delivery differences   │
│ Card 3,000 · Due ₹2,100      ││ Procedures 5 of 7           ││ 1 refund to approve      │
│ Day closed ✓ (Ramya, 8:05pm) ││                              ││ Kiran T – Hb 9.1 (low)   │
└──────────────────────────────┘└──────────────────────────────┘└──────────────────────────┘
```

### 6.3 Primary flows (proposed)

1. **Arrive & pay:** search phone → pick person (or new) → doctor + fee pre-filled → tap payment mode → token printed/sent. *3 taps.*
2. **Consult:** Today → Start → "Same as last visit" or Sets → edit exceptions → Follow-up chip → Finish → Sign & print. *8–9 taps.* Hard stop only on allergy/interaction/incomplete line.
3. **Dispense:** Rx appears on counter → check lines (qty = doctor's) → payment mode. *3 taps.*
4. **Procedure day:** row → Start (consent check) → Done → pay if due. *3 taps.*
5. **Lab:** desk picks test → enters values or attaches PDF/WhatsApp image → doctor sees abnormal first on Today → must choose outcome → patient notified. *3 + 2 taps.*
6. **Follow-up calls:** one Calls list (follow-ups due, reports ready, procedure plans) → row buttons: No answer · Call later · Book (opens booking sheet pre-filled). *1–3 taps.*
7. **Close day:** reception counts drawer by mode → system shows expected (same number as Reports) → differences need a reason → owner sees it on Home.

### 6.4 What I would remove entirely

- The **three Rx pad layouts** (Stacked/Focused/Review) — one layout.
- **Per-section template logos and Save/Clear on every card header** — one "Sets" button.
- **9 stage tiles + 6 tabs + filmstrip** on the front desk — two columns (Not here yet / Waiting) plus "Needs you".
- **Bookings page** as a separate page (merge with Calendar as a list view).
- **Follow-ups / Test reports / Procedures "Log a call"** as three call lists — one **Calls** list.
- **Visit-type "Fee (₹)"** that isn't charged — prices live in one Prices screen.
- **Client-side Export on every table** — export only from Reports, owner only, audited.
- **Demo accounts block on the login page** in production.
- **Test data → RESET** on live clinics.
- **Glass/blur/orbs** by default.
- **Browser `alert()` / `confirm()`** calls.
- **Dead code:** `ResultDialog` + "Recent results" (Worklist), `rupees()`, parked Overview.
- **Junk patient records** for OTC sales.

---

## 7. Prioritised action plan

### 7.1 Quick wins (under 1 day each)

| # | Fix | Why | Sev | Where |
|---|---|---|---|---|
| 1 | Remove "allergy checked: no clash found" text | False reassurance | Critical | `Encounter.tsx:562` |
| 2 | Show age in months/days when `ageYears` is 0 | Infant dose safety | High | pad header, `PrintRx.tsx:45`, Today |
| 3 | DRAFT watermark on preview print; invalidate `['print', id]` on save/Finish | Draft passed off as final; stale print | Critical | `PrintRx.tsx`, `Encounter.tsx` |
| 4 | Remove client CSV export from DataTable (or gate behind `listOut()`) | Data leak | Critical | `table.tsx:83, 134` |
| 5 | Hide demo accounts and pre-filled password unless `NODE_ENV !== 'production'` | Account takeover | Critical | `Login.tsx:7-14, 78` |
| 6 | Server: only an owner may grant Owner; block removing the last owner | Privilege escalation, lockout | Critical | `admin.ts:56-78` |
| 7 | Server: Test data/RESET only on test tenants | Wipes a live clinic | Critical | `sample.ts:32` |
| 8 | Collect: require a mode, confirm with amount, disable while sending, per-intent idempotency key | Wrong mode, double payment | Critical | `FrontDesk.tsx:87, 194, 236` |
| 9 | Check-in: warn if amount ≠ fee; `assertDayOpen` on `POST /visits` | Wrong billing, closed-day leak | Critical | `visits.ts:117` |
| 10 | Pharmacy: idempotency key on `POST /pharmacy/sale` | Double bill on retry | Critical | `pharmacy.ts:301` |
| 11 | Lab review: no default outcome; show typed values with out-of-range in red | Abnormal closed as normal | Critical | `TestReports.tsx:92-117` |
| 12 | Void/Refund/Left/No-show/Close day: confirm or Undo | Accidental money/status change | High | Front desk, Pharmacy |
| 13 | Confirm dialog focus on Cancel; dialogs with input ask before closing | Enter deletes; lost forms | High | `ui.tsx:314, 323, 372` |
| 14 | Lists: distinguish error vs empty ("Couldn't load — Retry") | Duplicate patients, missed calls | High | `table.tsx:138`, `palette.tsx:70`, Followups, ProcSchedule, TestReports |
| 15 | `/me`: retry, redirect to login only on 401 | Thrown out on bad network | High | `App.tsx:188`, `api.ts:24` |
| 16 | Wire up the front desk search (`const find = ''`) | Can't find a patient | High | `FrontDesk.tsx:54` |
| 17 | Procedures opens on Today, not Tomorrow | Wrong day for the coordinator | High | `ProcSchedule.tsx:24` |
| 18 | Phone field: strip `+91`/spaces before cutting to 10 digits | Wrong numbers saved | High | Booking/Patients phone inputs |
| 19 | Strip prices from `/config` for roles without `fees.see`; drop `display.token` | Price + TV token leak | Critical | `identity.ts:55-73` |
| 20 | Audit log shows ₹ not paise; fee change asks "from when?" | Misread audit; mid-day change | High | `Privacy.tsx:282`, `Settings.tsx:341` |
| 21 | Show the "Handle carefully" reason as text, not hover-only | Unreadable on tablets | High | `flags.tsx:14` |
| 22 | Fix sign-in name sticking at first letter on onboarding | Broken onboarding | High | `Platform.tsx:47` |

### 7.2 Medium (1–2 weeks each)

1. **Prescribing safety v1:** allergy class + generic per medicine in the master; hard stop with override reason; same-molecule duplicate check; interactions for the derm top 30 (isotretinoin + tetracyclines, methotrexate + NSAIDs/trimethoprim, etc.); pregnancy/breastfeeding in the header and check for teratogens; Finish blocked on incomplete lines; quantity from dose *count*, not milligrams; pharmacy uses the doctor's saved quantity.
2. **Sign-off and amend:** Finish sheet = exact print; signed vs draft; "Amend with reason" after signing, audited, reprint marked "Amended".
3. **Autosave you can trust:** visible failure state, local copy in IndexedDB, warn before closing the tab, junior and doctor locks (no silent last-write-wins), only explicit "Ready for doctor" flips the visit to screened.
4. **Money model:** refunds as money-out rows (mode-matched to the original payment); one "Collected" definition shared by Reports and End of day; receipt numbers for check-in fees; "Received by" = who received; GST tax-invoice format with rate-wise summary, and no CGST/SGST when the clinic has no GSTIN.
5. **Procedure billing and consent:** charge created for any done sitting (course or not); cancelling a completed sitting reverses its charge; partly used advance counted; consent capture (sign on tablet or tick "paper consent filed") before first sitting of each procedure type.
6. **Pharmacy guards:** Schedule H/H1/X need an Rx line (per line, not per bill); cannot issue more than prescribed without reason; returns to a "quarantine" bin, not sellable stock; near-expiry warning; batch/expiry on every line; UPI QR (static VPA + amount) instead of typing UTR; round-off/freight on receiving.
7. **Privacy by role:** server strips diagnoses from Patients list/Follow-ups for non-clinical roles; Dashboard shows a doctor only their own revenue; export only via Reports, owner, audited.
8. **Access & accounts:** self-service password change, owner-reset for staff, generated first password sent on WhatsApp with must-change; IP allow-list changes need a confirmation and can't lock out the current device.
9. **Duplicate patients:** fuzzy name + same phone + DOB/age; family-on-one-phone picker at check-in and booking; merge tool for the owner.
10. **Offline basics:** global connection strip; queue and pad readable offline; writes queued with clear "not yet saved" state.
11. **One Payment sheet, one Booking sheet, one Patient drawer, one Confirm/Undo** — replace the variants.
12. **One Calls list** merging Follow-ups, Procedures "Log a call" and report pickups; "Booked" only through a real booking.
13. **Settings regroup** to 6 topics + one Prices screen; reactivate deactivated items ("Show inactive"); confirm GST defaults with the CA.
14. **Typography & touch pass:** 16px base on touch, 13px minimum, 44px targets on coarse pointers, remove blur/orbs by default, fix hard-coded `bg-white` for dark mode.
15. **Waiting-room TV:** keep last good board on error, show "reconnecting"; "Tap to enable sound" on first open; clock from device time.
16. **Patient link:** confirm before moving a booking; Telugu/Hindi.

### 7.3 Big redesigns (multi-week)

1. **Role homes + navigation** (Section 5.4/6.2): one home per role, ≤5 menu items, role switch for multi-role owners.
2. **Front desk rebuild:** Desk home with two columns + Needs you; check-in sheet with family picker and payment.
3. **Rx pad v2:** one layout, sets instead of per-section templates, safety block, sign-off sheet, offline-safe autosave.
4. **Pharmacy counter v2:** Rx-first counter with batch/expiry, schedule gate, QR payment, returns with approval.
5. **Multilingual patient surfaces:** Rx instructions (with English fallback, never dropping lines), WhatsApp templates, patient link, TV — Telugu and Hindi first; i18n scaffold for staff UI later.
6. **Owner home + one money model:** Yesterday/Today/Needs-you cards backed by one ledger that Reports, End of day and Dashboard all read.

### 7.4 Suggested order

| Week | Do |
|---|---|
| 1 | Quick wins 1–11, 19 (all Critical, mostly one-liners or small server guards) |
| 2 | Quick wins 12–22; start Medium 1 (prescribing safety) and 4 (money model) |
| 3–4 | Medium 1–8 (safety, money, privacy, access) |
| 5–6 | Medium 9–16 (consistency, offline, settings, typography) |
| 7+ | Big redesigns, in order 1 → 2 → 3 → 4 → 6 → 5; test each with a new receptionist (the "day-one test": no training, finish the task) |

---

## Notes on method

- Seven areas were read in parallel by reviewers working from the same checklist (the 11 points of the brief). I spot-checked the main Critical claims in code (`courses.ts:33` no charge without a course; `pharmacy.ts:144` register `noRx` per bill; `table.tsx:83` client-side export; `admin.ts:74` role existence only; `Login.tsx:7` demo list; `FrontDesk.tsx:54` empty search; `FrontDesk.tsx:87` cash-only Collect; `billing.ts:40` refund as status change; `Encounter.tsx:37-46` allergy word list; `rxLine.ts:34` quantity from dose number; `sample.ts:32` reset owner-only, no tenant guard). All held.
- Severities follow the brief: anything that can harm a patient, cause wrong billing or expose private data is Critical, even if it is a one-line fix.
- The appendices keep each reviewer's full write-up, including per-screen wireframes, so developers can work from them directly.

---
---

# Appendices — per-screen detail



---

<a id="appendix-A"></a>
# Appendix A — App shell, login, shared components, TV, patient link, platform

## UX audit: app shell and shared pieces (Cubott OPD)

Scope: `web/src/App.tsx`, `main.tsx`, `ui.tsx`, `palette.tsx`, `table.tsx`, `viewer.tsx`, `printPreview.tsx`, `flags.tsx`, `api.ts`, `index.css`, `glass.css`, `oat.css`, `settings.css`, `table.css`, `pages/Login.tsx`, `pages/Help.tsx`, `pages/Display.tsx`, `pages/PatientLink.tsx`, `pages/Platform.tsx`, `pages/Overview.tsx` (parked).
Method: code reading only. Nothing was run in a browser. Anything inferred is marked **ASSUMPTION**.

Roles used below: Owner (`*`), Admin, Doctor, Junior doctor (`assistant`), Reception, Coordinator, Pharmacist, Superadmin.

---

### 0. Top issues (ranked)

| # | Sev | Issue | Where |
|---|---|---|---|
| 1 | **Critical** | Every DataTable has an **Export** button on by default. It downloads a CSV without the audit record and without the "lists are owner-only" check. Any role that can open Patients can download names, phones and areas. The server rule `LISTS_OWNER_ONLY` (src/modules/security.ts:70) is only checked by `listOut()`, and DataTable never calls `listOut()`. | table.tsx:84-90, 134; Patients.tsx:42-43 |
| 2 | **Critical** | Every clinic's login page lists the demo accounts, the platform superadmin email and the password `demo1234`, and the password box is **pre-filled** with `demo1234`. If the seed's `SUPERADMIN_PASSWORD` fallback is live in production (src/db/seed.ts:225), the platform is open to anyone. (ASSUMPTION: whether the demo/seed accounts exist in production.) | Login.tsx:7-14, 78, 136-141 |
| 3 | High | A network error looks the same as "nothing found". The Patients list shows "No patients found" and the Ctrl-K search shows "No match". On patchy internet, reception concludes the patient is new and registers a duplicate, which splits the history (allergies, past Rx). | table.tsx:138-143; palette.tsx:70; Patients.tsx:42-46 |
| 4 | High | When `/me` fails (for example a dropped connection on reload), the app sends the user to the login page (`me.isError` leads to `location.href='/login'`, and `useMe` has `retry:false`). Any 401 also does a hard redirect that drops unsaved form data. | App.tsx:188; api.ts:12, 24 |
| 5 | High | The delete confirmation puts keyboard focus on the destructive button, so Enter deletes. A patient's report or photo can be gone permanently with one keypress. Dialogs also close on a backdrop click or Esc with no check for unsaved input, so a long form (check-in, onboarding) is lost to a stray click. | ui.tsx:372, 323, 314 |

Also High: the waiting-room TV shows "This screen link is not valid" after any network blip, its sound never plays, and its clock likely freezes (Display.tsx). The patient link moves a booking on one tap and is English-only (PatientLink.tsx:67). The "Handle carefully" reason is only a hover tooltip, so it cannot be read on touch screens (flags.tsx:14). The onboarding sign-in name sticks at the first letter typed (Platform.tsx:47). There is no offline handling and no i18n anywhere.

---

### 1. Screen inventory (35 surfaces)

| # | Surface | File:line | Roles | How reached |
|---|---|---|---|---|
| 1 | Sidebar (expanded) | App.tsx:97-124 | all tenant roles | default on md+ |
| 2 | Icon rail (collapsed) | App.tsx:76-95 | all | chevron toggle; default on consultation pad |
| 3 | Mobile nav drawer | App.tsx:205-209 | all | hamburger <768px |
| 4 | Top bar: title, breadcrumb, Back | App.tsx:212-232 | all | every page |
| 5 | "+" New menu | App.tsx:222-227; palette.tsx:10-31 | roles with any create perm | "+" in top bar |
| 6 | Mobile account menu | App.tsx:228-231 | all | avatar <768px |
| 7 | Theme toggle | App.tsx:220; ui.tsx:213 | all | moon/spark icon |
| 8 | Header search pill / page search box | App.tsx:217-219; ui.tsx:195-205 | all except superadmin | top bar |
| 9 | Command palette (Ctrl-K) | palette.tsx:34-76 | anyone (results only with patient.read) | Ctrl/Cmd-K, search pill |
| 10 | App loading | App.tsx:187 | all | first load |
| 11 | Page crash fallback | App.tsx:127-135 | all | render error |
| 12 | No access | ui.tsx:429-431; App.tsx:153-154, 235 | all | typed URL outside role |
| 13 | Not found | ui.tsx:432-434; main.tsx:67 | all | bad URL |
| 14 | Idle sign-out | App.tsx:166-185; Login.tsx:126 | all (doctor in consult exempt) | owner setting |
| 15 | Toasts | ui.tsx:381-406 | all | after actions |
| 16 | Confirm / ask dialog | ui.tsx:334-379 | all | `ask()` from pages |
| 17 | Standard modal (bottom sheet on phone) | ui.tsx:308-332; index.css:281-299 | all | every popup |
| 18 | Floating panel / Filter dropdown | ui.tsx:157-180, 238-253 | all | filter buttons |
| 19 | "⋯" More menu | ui.tsx:255-270 | all | row actions |
| 20 | Segmented control / Tabs | ui.tsx:115-136, 223-235 | all | many pages |
| 21 | Empty, Skeleton, Stat, Section, Num | ui.tsx:82-154 | all | many pages |
| 22 | MoneyInput / NumInput | ui.tsx:412-443 | money roles / all | forms |
| 23 | DataTable (tabs, filter chips, Columns, Export, bulk bar, empty state, pager) | table.tsx:42-183; table.css | Patients, Bookings, Follow-ups, Expenses, Pharmacy bills, Stock, Orders | list pages |
| 24 | Document viewer (+ delete confirm, error state) | viewer.tsx:16-86 | doc readers; delete with document.write | report/photo chips |
| 25 | Print preview popup | printPreview.tsx:13-34 | doctor, reception, others | Print buttons |
| 26 | Flag chips + Careful banner | flags.tsx:9-22 | all who see patients | beside names, record |
| 27 | Flag editor modal | flags.tsx:24-46 | doctor/owner (per Help.tsx:206) | patient record |
| 28 | Guardian picker | flags.tsx:49-55 | patient.write | patient edit |
| 29 | Login (blocked, idle, clinic chooser, error, demo tiles) | Login.tsx:75-148 | everyone | /login |
| 30 | Help guide | Help.tsx:298-323 | all tenant roles | "?" button, /help |
| 31 | Waiting-room TV (loading, error, empty, lanes) | Display.tsx:10-43 | public | /display/:slug/:token |
| 32 | Patient link (loading, invalid, booked banner, actions, cancel, move, too-late) | PatientLink.tsx:14-85 | patient (public) | WhatsApp link /a/:slug/:token |
| 33 | Platform clinic list | Platform.tsx:7-26 | superadmin | /platform |
| 34 | Onboard-a-clinic modal + "Clinic is live" | Platform.tsx:28-64 | superadmin | "Onboard a clinic" |
| 35 | Overview (parked) | Overview.tsx | none (route redirects, main.tsx:46) | not reachable |

---

### 2. Per-surface findings

#### 1-3. Sidebar, rail, mobile drawer (App.tsx:76-124, 202-209)
Purpose: move between sections; shows who is signed in.

- **Medium: icons repeat.** `inbox` is used for Bookings, Test reports and Inventory (App.tsx:23, 27, 29), and `chart` for Dashboard and Reports (19, 30). The rail shows icons only, with names only on hover (`.tip`, index.css:252-254). *Cognitive load: three identical icons force a hover per item, and touch tablets cannot hover.* Fix: give each section its own icon (Bookings `calendar-check`, Test reports `flask`, Inventory `package`, Reports `file-text`). On touch devices (`pointer: coarse`), show the rail with labels under the icons, or default to expanded.
- **Medium: the rail state is per device, not per person** (`localStorage nav`, App.tsx:70). On a shared reception PC, the next person inherits someone else's collapsed rail. Fix: key it by user id, or reset it on sign-in.
- **Medium: sign-out is one icon with no guard, and it does not save first.** `signOut` (App.tsx:189) never fires `app:save-now`, unlike the idle path (180). (ASSUMPTION: the consultation pad has unsaved state between autosaves.) *An accidental tap can lose the doctor's draft.* Fix: dispatch `app:save-now` and await it before logout, the same as the idle path.
- **Medium: there is no fast user switch on a shared PC.** Every hand-over needs email plus password. Fix: "Switch user" with a 4-digit PIN per staff member, inside the same clinic session.
- **Low: role fit.** The Doctor sees 8 items (Dashboard, Today, Calendar, Bookings, Patients, Procedures, Follow-ups, Test reports). Follow-ups and Bookings are reception work and dilute a 6-minute-per-patient doctor's rail. Fix: hide Follow-ups and Bookings for roles with `encounter.complete` unless they also have `visit.write`.
- **Low:** the "Clinic" group label is 11px uppercase muted text (App.tsx:113), which the type scale maps to 11.5px. Fine for experts, invisible to others.
- **Low:** the mobile drawer has no close button. Only a backdrop tap closes it, and there is no Esc handler (App.tsx:206).

#### 4. Top bar (App.tsx:212-232)
- **Low: two Back buttons on Help.** The top-bar Back (parent `/help` leads to `/`, App.tsx:194) and Help's own "Back" (Help.tsx:308). This breaks the "no duplicate page actions" rule. Fix: remove Help's own Back.
- **Low:** the fallback title is "Home" (App.tsx:215) for any unmapped path, e.g. /audit when the role lacks it. Fine.
- **Low:** the theme toggle and Help are hidden under 640px (`hidden sm:inline-flex`, 220-221). Help is still in the drawer, so this is OK.

#### 5. "+" New menu (App.tsx:222-227, palette.tsx:10-31)
Purpose: start check-in, booking, registration and so on from anywhere.
- **Medium: the button is an icon with no word.** `aria-label="New"` and a `title` tooltip only. *Low-literacy staff do not read "+" as "check in a patient".* The user chose a single "+" (commit b237a2d), so a compromise fix: on Front desk, label it "+ Check in"; elsewhere keep the bare "+".
- **Medium: keyboard and Esc.** `role="menu"` but no arrow-key handling and no Esc close. Only the invisible backdrop closes it (225). Fix: reuse `Floating` (which handles Esc and outside clicks) plus roving focus.
- **Low:** the hints in `createActions` ("Arrival, vitals and fee") are defined but never shown in the + menu (226). Show them as a second muted line, because they explain the choice.
- **Low:** the menu order changes per page (`first`, palette.tsx:11). A good idea, but muscle memory breaks. Keep a fixed order and only **bold** the page's main action.

#### 6. Mobile account menu (App.tsx:228-231)
- **Low:** it closes on `onMouseLeave`, which never fires on touch, and it has no backdrop. Fix: use `Floating`.

#### 7. Theme toggle
- **Low:** dark mode is saved per device (App.tsx:59-61), so on a shared PC one person's dark mode becomes everyone's. Fix: store it per user.
- **Medium: dark mode is a different brand.** oat.css only overrides light (`:root`), so dark falls back to the old green palette and green orbs (index.css:48-55, glass.css:14-19). Light is cream/slate/teal. Fix: add an oat dark variant, or remove dark until it is designed.
- **High (dark mode): hard-coded `bg-white` breaks readability.** Help's step cards, tables, money cards and FAQ use `bg-white/80`, `bg-white/70` and `bg-white` with `text-ink`, which is near-white in dark mode (Help.tsx:23, 33, 41, 43, 70-72, 318). The result is white text on white. Same for the guardian search results (flags.tsx:54), the viewer arrows (viewer.tsx:74-75, light icon on white) and the patient-link slot buttons (PatientLink.tsx:67). Fix: replace with `bg-surface`/`bg-surface-2` tokens, and lint for `bg-white` in web/src.

#### 8. Header search (App.tsx:217-219, ui.tsx:195-205)
- **Low: three wordings for one search.** "Patients, phone or ID…" (App.tsx:218), "Patient name, phone or ID" (palette.tsx:55), "Find a patient: name, phone or ID" (Patients.tsx:44). Pick one: "Name, phone or patient no.".
- **Low:** the label `.toppill` has no `:focus-within` style, and the input is `outline-none` (ui.tsx:201). Keyboard users see no focus. Fix: add `.toppill:focus-within { box-shadow: ring clay }`.
- **Low:** the keyboard hint says "Ctrl K" in the top bar but "⌘K" in the palette footer (palette.tsx:72). Clinics run Windows. Use "Ctrl+K".

#### 9. Command palette (palette.tsx:34-76)
Purpose: find any patient from anywhere. Roles: anyone, but results need `patient.read`.
- **High: an error reads as "No match".** `search.isError` is ignored, so a timeout shows "No match" (70), leading to a duplicate registration. Fix: on error show "Could not search: no connection. Try again" with a Retry button, and never "No match".
- **Medium: wrong-patient risk.** A row shows name · age · sex · phone (66), but no patient number, last visit or flags. The Patients list shows the number, and Help says families share phones. Fix: add the patient no., last-visit date and FlagChips; highlight the matched digits.
- **Medium: dead end.** "No match" offers no next step. Fix: add "Register '{q}' as a new patient" (with `patient.write`) and "Check in" (with `visit.write`).
- **Medium: no dialog semantics.** No `role="dialog"`, `aria-modal` or focus trap; Tab escapes to the page behind. Fix: build it on `Modal`/`useDialogFocus`.
- **Low:** only 5 results with no "see all"; same-name families get cut off. Add "See all N in Patients", which goes to `/patients?q=`.
- **Low:** roles without `patient.read` (superadmin via Ctrl-K, App.tsx:162 is not gated by `platform`) get a box that always says "No match". Gate the shortcut.
- **Low:** the `actions` array is always empty (43), yet the code still handles letter shortcuts (57). Delete the dead code.

#### 10. App loading (App.tsx:187)
- **Low:** "Opening clinic…" has no timeout. A hung `/me` shows it forever. After 10s show "Still connecting. Check the internet." with Retry.

#### 11. Page crash fallback (App.tsx:127-135)
- Good copy ("Nothing you saved is lost"). **Low:** "nothing you saved is lost" is true, but unsaved input is lost. Add "What you were typing may need to be entered again." Add a small error reference for support.

#### 12. No access (ui.tsx:429-431)
- **Low: dead end.** There is only text. Add a "Go to my home page" button (`homeFor`). The copy is fine.

#### 13. Not found (ui.tsx:432-434)
- **Low: wrong copy.** "Use the menu above to find what you need." The menu is on the left, or behind the hamburger on phones. Fix: "This page doesn't exist. [Go to my home page]".

#### 14. Idle sign-out (App.tsx:166-185, Login.tsx:126, 133)
- **Medium: the privacy promise is false by default.** The login says "Auto sign-out after a quiet spell" (133), but `idleMinutes` defaults to 0, which means off (167, 173). Fix: default to 15 min, or show the line only when it is on.
- **Medium: the doctor is exempt while in a consultation** (168, 173). A doctor who walks away leaves a patient's record open on a shared screen indefinitely. Fix: blur the pad after N minutes ("Tap to continue, Dr. X") instead of signing out, so nothing is lost and the screen is still covered.

#### 15. Toasts (ui.tsx:381-406)
- **Medium: errors vanish in 3.2s,** as fast as successes (388). Busy staff miss "Phone must be 10 digits". Fix: errors stay until dismissed (with an ×), or 8s.
- **Medium: no `aria-live`/`role="status"`,** so screen readers miss every result. Fix: `role="status" aria-live="polite"` on the container, and `role="alert"` for err.
- **Low:** the `info` tone shows a green tick (399). "Document deleted" (viewer.tsx:59) gets a success tick. Give info an `i` icon.
- **Medium (phones):** toasts sit at `bottom-6 z-50` over the bottom-sheet modal's sticky footer (z-40), covering the Save button. Fix: place them at the top on phones, or above `.modal-foot`.

#### 16. Confirm / ask dialog (ui.tsx:334-379)
Purpose: the app's single confirm/prompt. Used by viewer delete and many pages.
- **High: Enter confirms a danger action.** The confirm button gets `data-autofocus` when there is no field (372), whatever the tone. For `tone:'danger'` (delete document, viewer.tsx:55), Enter deletes permanently. Fix: for danger, focus **Cancel/Keep**. Also require the action to be named in the button ("Delete report"), not "OK".
- **Low:** the danger button only has rose text. Its `!border-[#F0B8B3]` has no effect because `.btn` is `border-0` (index.css:145). Fix: a filled rose `btn-danger` class.
- **Low:** an amber "!" badge shows on every non-field confirm, including harmless ones (365), so the warning is diluted. Show it only for danger.
- **Low:** a required field disables OK with no explanation (348, 372). Add a helper line: "A reason is needed."
- **Low:** the default confirm label is "OK" (372), which is vague. Require callers to pass a verb.

#### 17. Standard modal (ui.tsx:308-332, index.css:281-299)
- **High: unsaved input is lost.** A backdrop click (323) or Esc (314) closes immediately. *One stray click on the dim area loses a half-filled check-in or onboarding form.* Fix: add a `dirty` prop. When dirty, the backdrop does nothing and Esc asks "Discard what you typed? [Keep editing] [Discard]".
- **Medium: size map is missing entries.** `SIZE` lacks `max-w-5xl` and `max-w-4xl` (306), so the document viewer (`max-w-5xl`, viewer.tsx:65) falls back to 720px, and photos meant "at full size" are small. Fix: add `'max-w-5xl': 'sm:max-w-[1040px]'`.
- **Low:** an Esc pressed inside a Floating panel within a Modal closes both (separate window listeners). Have the Floating stop propagation.
- Good: focus trap, restored focus, no autofocus on touch, a sticky footer, and a bottom sheet on phones.

#### 18-19. Filter dropdown / More menu (ui.tsx:157-270)
- **Low:** `Floating` closes on any scroll (172). On a phone, a slight page bounce closes the menu. Ignore scrolls under 10px.
- **Low:** menu items have no arrow-key navigation even though they are `role="menu"`/`menuitemradio`.
- **Low:** the More menu's `danger` items are only red text. Whether a confirm follows depends on the caller (ASSUMPTION: not all callers confirm). Enforce it: `danger` items go through `ask()` automatically.

#### 20. Segmented / Tabs (ui.tsx:115-235)
- **Low:** `role="tablist"` without arrow-key movement or `aria-controls`. Low priority.

#### 21. Empty / Skeleton / Stat / Num
- **Low:** `Num` animates money and counts up from 0 (139-154). A cashier glancing during the 700 ms reads a wrong amount. Fix: no count-up for money; flash only.
- **Low:** `Empty` copy relies on callers. Fine.

#### 22. MoneyInput / NumInput (ui.tsx:412-443)
- **Medium (billing): silent truncation.** `cleanMoney` cuts the whole part to 7 digits (416), so a pasted "12500000" becomes "1250000" with no warning. `NumInput` clamps silently to `max` (440): typing 150 in a max-99 field gives 99. (ASSUMPTION: which callers set low maxes, e.g. vitals or quantities.) *A silent clamp records a value nobody typed.* Fix: keep what was typed, show a red message "Most is ₹99,99,999", and disable Save.
- **Medium:** money is not grouped while typing. "125000" is hard to read against "1,25,000". Fix: show the formatted Indian value under the field ("₹1,25,000"), or format on blur.
- **Low:** `MoneyInput` always sets `aria-label`, which overrides a visible `<label for>`.

#### 23. DataTable (table.tsx, table.css)
Purpose: the shared list for Patients, Bookings, Follow-ups, Expenses, Pharmacy bills, Stock and Orders.
- **Critical: unaudited, unguarded export.** `exportable !== false` turns Export on by default (134). `exportCsv` (84-90) builds the file in the browser. It never calls `listOut()` (api.ts:95), so there is no audit event and no `privacy.canExport` check. Patients (Patients.tsx:42-53) exports name, phone, area and last visit for every role with `patient.read`: Doctor, Junior doctor, Reception, Coordinator, Pharmacist. FrontDesk and Reports gate on `canList`/`canExport`; DataTable does not. Fix: Export renders only when `me.privacy.canExport`, and click calls `listOut(exportName, total, exportCsv)`. Also enforce it on the server by serving exports from an endpoint, not client CSV.
- **High: an error looks empty.** There is no `error` prop. On a failed fetch, rows are `[]`, so the table says "No patients found"/"Nothing here" (138-141), which leads to duplicate registrations and "no bookings" misreads. Bookings works around it by putting `errText` in the title (Bookings.tsx:56); Patients does not. Fix: add an `error` prop that renders "Couldn't load. No connection. [Try again]", visually distinct from empty.
- **Medium: Export says "every page" but isn't.** The tooltip "Download what is shown, every page" (134) is false for server-paged tables (Patients). `list` is only the current page (`p.rows`, 66-70), so the CSV has 25 rows out of 4,000. Fix: for `server`, fetch all rows (or a server export), or say "this page only".
- **Medium: tablet touch targets.** `.dt-pg`, `.dt-tok`, `.dt-ghost` and `.dt-select` are 30px (table.css:15, 24, 59-60), checkboxes 16px (26), and the filter × is about 30×16. The phone media rule only fixes `.btn`/`.input`. Reception tablets at 768-1024px get 30px targets (ASSUMPTION: tablets at the desk). Fix: 40px minimum when `pointer: coarse`.
- **Medium: rows can't be opened by keyboard.** `onRow` rows have no `tabIndex`/`role="link"`/Enter handler (155). Fix: make the first cell a real `<a>`/button.
- **Low:** "No one matches these filters" (140) on Stock/Orders/Expenses tables. Use "Nothing matches these filters".
- **Low:** the Columns choice is saved per device (38, 83), so one person hiding "Phone" hides it for the next. Store per user, or keep phone/name `fixed`.
- **Low:** the header is UPPERCASE 11.5px (table.css:40), against the app's own "sentence case" rule (index.css:132).
- **Low:** when rows are ticked, the bulk bar replaces the filter bar (102-104). Filters vanish without explanation. Acceptable, but keep the filter count visible.

#### 24. Document viewer (viewer.tsx)
Purpose: view a patient's report or photo in place, with print, download and delete.
- **High: delete with Enter,** via the ask dialog (section 16), with "This cannot be undone." (55). Lab reports and biopsies are clinical records. Fix: focus Keep; soft-delete with an Undo toast (7s) instead of a hard delete.
- **Medium: Download is not recorded.** "Download" saves a patient file to a shared PC's Downloads folder with no audit and no role check (81). Fix: audit downloads; hide Download for roles without `document.write` or `canExport`.
- **Medium:** the viewer is 720px wide because of the missing size key (section 17).
- **Medium:** there is no **rotate**. Phone photos of reports are often sideways. Add a rotate-90° button.
- **Low:** the "Other documents" chips cut titles at 24 characters (77). Show the date instead ("CBC · 3 Nov").
- **Low:** the error copy "This file could not be opened. It may have been removed." (68) is also shown when offline. Add "or there's no connection" plus Retry.
- Good: the patient name and date sit in the subtitle (62), the file is fetched into memory, and arrow keys work.

#### 25. Print preview (printPreview.tsx)
- **Medium:** paper is forced to A5 for every Rx (20; PrintRx.tsx:39). Clinics with A4 letterheads or thermal printers cannot change it (ASSUMPTION: no setting found in this area). Fix: a paper-size setting per clinic.
- **Low:** no "Share on WhatsApp / Save PDF" next to Print. Indian patients expect the Rx on WhatsApp. Add "Send to patient" (with consent).
- **Low:** the patient's name is not in the modal title unless the caller passes it. Require `title` to include the patient name to avoid printing the wrong Rx.

#### 26. Flag chips / Careful banner (flags.tsx:9-22)
- **High (privacy): the Careful reason is hover-only.** It lives in a `title` attribute (14), which touch devices never show. The reason is the instruction, e.g. "discuss only with the mother". On a tablet queue the desk sees "Handle carefully" but not why. *A chip without the reason invites the exact disclosure it warns against.* Fix: make the chip a button that opens a small popover with the reason. On queue rows, show the first 40 characters inline.
- **Low:** "VIP" and "Family and friends" give no hint of what to do differently. Add one line in the editor ("VIP: priority, owner informed").

#### 27. Flag editor (flags.tsx:24-46)
- **Medium:** Save is disabled while the "Handle carefully" reason is under 3 characters, with no message (32, 42). Add "Write at least a few words".
- **Low:** native checkboxes about 13px inside a `text-sm` label (36-38). Make them 20px with a 44px row.
- **Low:** the title "Flags" is jargon. Use "Mark this patient".

#### 28. Guardian picker (flags.tsx:49-55)
- **High (dark mode):** a hard-coded `bg-white` list gives white-on-white text (54).
- **Medium:** no loading, no "No one found" and no error state. An empty box looks broken. Add the states and "Register the parent".
- **Low:** "change" as a lowercase underlined word (52). Use a `btn-sm` "Change".

#### 29. Login (Login.tsx)
Purpose: sign in. Shared by every clinic and the platform.
- **Critical: demo credentials in every clinic.** `DEMO` (7-14) lists owner, reception, pharmacy and **superadmin@cubott.in**. The label says "password demo1234" (136), and the password box starts as `demo1234` (78). A real staff member who types only an email submits `demo1234`, which burns lock-out attempts. Fix: render the demo block only when `import.meta.env.DEV` or the host is a demo host; start the password empty; remove superadmin from any list; make the seed fail if `SUPERADMIN_PASSWORD` is unset in production.
- **Medium: offline is misread as a wrong password.** Any non-API error (network) falls into `'That email or password is not right.'` (90). Staff retry and get locked out. Fix: use `errText(x)` for non-ApiError: "Could not reach the server. Check the internet."
- **Medium: no "Forgot password"** and no way to reset. Add "Forgot password? Ask the clinic owner to reset it in Settings → People." (ASSUMPTION: no self-service reset exists.)
- **Medium: clever copy.** The headline "One patient. Four hands. One sign-in." (116), the intro "Whoever you are in that walk…" (117) and the button **"Take my step"** (132). *A receptionist has to decode a metaphor to find the sign-in button.* Fix: the button says "Sign in"; the headline "Sign in to {clinic}".
- **Low:** the blocked notice says "the owner has been told" (123). (ASSUMPTION: server notifies the owner; not verified here.) If it doesn't, the promise is false.
- **Low:** no show-password toggle, which matters for older staff typing on a shared PC.
- **Low:** email-only sign-in. (ASSUMPTION: some pharmacy and reception staff have no email.) Consider phone + PIN.

Wireframe (redesign):
```
+-----------------------------------------------+
| [logo] Cubott OPD                             |
|                                               |
|  Sign in                                      |
|  Email or phone  [______________________]     |
|  Password        [______________] [Show]      |
|  (!) No internet. Check the Wi-Fi and retry.  |
|  [          Sign in  ->                    ]  |
|  Forgot password? Ask your clinic owner.      |
|  (Demo accounts: only on demo.cubott.in)      |
+-----------------------------------------------+
```

#### 30. Help (Help.tsx)
- **High (dark mode):** unreadable (section 7).
- **Medium: wrong default guide for the owner.** `mine` (301) picks Owner only when `config.write && !visit.write`. The owner has `*`, so `visit.write` is true and the owner lands on **Reception**. Admin also has `visit.*`. Fix: check `roles.includes('owner'|'admin')` first.
- **Medium: missing guides.** No Coordinator or Admin guide (`GUIDES`, 7). A coordinator falls back to Reception. `CONTEXT` has no entries for expenses, inventory or audit (10-14).
- **Medium: content contradicts product decisions.** "Tap Call to dial from a phone" (192) breaks the "no call buttons" rule. "Online" is listed as a visit type (111) though online booking was removed. "Walk-in sale" (260) is "New pharmacy sale" in the + menu (palette.tsx:18). Fix: re-check every button name against the UI.
- **Low:** the guide picker is a dropdown (`Filter`, 311) hiding 5 choices. Use visible segmented pills.
- **Low:** Back uses `history.length > 1` (308), which can leave the app. Remove it (the top bar has Back).
- **Low:** English only. This is the page that most needs Telugu/Hindi.
- Good: the role-colour steps, "Where money is taken", the FAQ and printing.

#### 31. Waiting-room TV (Display.tsx)
Purpose: tokens for patients across the room.
- **High: a blip shows "link not valid".** `q.isError` is checked first (21). In TanStack Query v5, a failed **refetch** sets `isError` even though `data` is still present, so one dropped poll (`retry:1`) replaces the whole screen with "This screen link is not valid… Ask the clinic to open Settings…" in front of patients. Fix: show the error screen only when `!q.data`; otherwise keep the board and add a small "Reconnecting…" dot.
- **High: the chime never plays.** Audio needs one user gesture (chime.ts:1). A TV has no one clicking, and there is no "Tap to turn on sound" prompt, so the "chime whenever a new token is called" promise silently fails. Fix: a full-screen "Tap to start the display (sound on)" overlay on first load.
- **Medium: the clock likely freezes.** `time` is computed at render (20). With structural sharing, an unchanged poll does not re-render (ASSUMPTION: v5 tracked props), so the clock stops whenever the queue doesn't change. It also uses the device time zone, while everything else uses IST. Fix: a 30s `setInterval` tick with `timeZone:'Asia/Kolkata'`.
- **Medium: the screen sleeps.** There is no Screen Wake Lock or full-screen request, so tablets and TVs dim. Fix: `navigator.wakeLock.request('screen')` plus a full-screen button.
- **Medium: the key line has the least contrast.** "Please wait for your token…" (40) is `text-white/30` at 16px on #15181B, about 2.4:1. Fix: white/70 at 24px.
- **Medium:** English only, no spoken token. For mixed literacy, add Telugu/Hindi labels ("ఇప్పుడు / अभी") and optional TTS "Token 12, please go to Dr. X".
- Good: tokens only, no names (server, public.ts:145).

Wireframe:
```
+-----------------------------------------------------------+
| Sahitya Derm                       10:42 am   ● Live      |
+----------------------------+------------------------------+
| Dr. A                      | Dr. B                        |
| NOW / ఇప్పుడు              | NOW                          |
|        12                  |        31                    |
| NEXT  [13]  14  15         | NEXT  [32]  33               |
| With junior doctor: 16     |                              |
+----------------------------+------------------------------+
|  Please wait for your token. Reception will call you.     |
|  దయచేసి మీ టోకెన్ కోసం వేచి ఉండండి                         |
+-----------------------------------------------------------+
 (first load: full-screen "Tap to start · sound on")
```

#### 32. Patient link (PatientLink.tsx)
Purpose: a patient confirms, cancels or reschedules from WhatsApp.
- **High: one tap reschedules.** A slot button calls `onPick` immediately (67). A thumb slip on a phone moves the visit. Fix: select the slot, then "Move to Tue 12 Nov, 10:30 am? [Yes, move] [Back]".
- **High: English only** for a patient-facing page (Andhra clinic, mixed literacy). Fix: language chips (తెలుగు / हिंदी / English) at the top, remembered per link.
- **Medium: a dropped connection reads as an invalid link.** `retry:false` (17) and any error shows "This link is not valid. It may be old or mistyped" (28), so the patient calls the clinic for nothing. Fix: show the invalid copy only on 404; network errors get "No internet. [Try again]".
- **Medium:** the clinic phone and address show only in the too-late case (52). Always show a "Call clinic" link and an address/map link in the shell.
- **Medium:** the time format is `v.startTime` raw (35, 67). (ASSUMPTION: 24-hour "14:30".) Use "2:30 pm".
- **Medium (privacy):** the visit type and doctor are shown to anyone holding a forwarded link (36). For "Handle carefully" patients, hide the visit type. (ASSUMPTION: the server does not already redact it.)
- **Low:** the status chip is lowercase "booked" (10). Use "Booked".
- **Low:** `useState(day > todayIst ? todayIst : todayIst)` (60) is dead code.
- **Low:** hard-coded "The wait can be 30–45 minutes." (37). Make it a clinic setting.
- **Low:** the footer says "Powered by CUBOTT Clinical" (81). The product is "Cubott OPD".

Wireframe:
```
+-------------------------------------+
| [S] Sahitya Derm   తెలుగు|हिंदी|EN   |
| Hello Ravi, your visit              |
| Tue 12 Nov · 10:30 am               |
| Dr. A · Booked                      |
| Arrive by 10:15 am                  |
| [  Yes, I will come  ]  (primary)   |
| [  Change day/time   ]              |
| [  Cancel visit      ]  (text, red) |
| Call clinic 98xxxxxx · Map          |
+-------------------------------------+
 slot pick -> "Move to Wed 13 Nov 11:00 am?" [Yes, move] [Back]
```

#### 33. Platform clinic list (Platform.tsx:7-26)
- **Medium:** no actions per clinic (open, suspend, reset owner password), no search, and the "Sign-in" column shows a slug that users never type (login is by email). Rename it "Clinic code" or drop it.
- **Low:** it uses the old `.table`, not DataTable, so it is inconsistent.
- **Low:** "Visits · 30d" is jargon. Use "Visits (last 30 days)".

#### 34. Onboard-a-clinic modal (Platform.tsx:28-64)
- **High: the sign-in name sticks at the first letter.** `slug: f.slug || derive(name)` (47). After the first keystroke `f.slug` is "s", which is truthy, so the slug stays "s" forever. Fix: track `slugTouched` and derive the slug from the name until the user edits it.
- **High: typed data is lost** on a backdrop click (section 17); this is a 10-field form.
- **Medium: raw codes in errors.** `e?.body?.code ?? 'Failed'` (32) shows "VALIDATION", "Failed" and so on. Use `errText`.
- **Medium: no field validation.** No email or phone format check, phone has no `inputMode="tel"`, and the slug isn't checked for allowed characters until the server rejects it. The password needs 6+ characters, but the button just stays grey with no hint (60).
- **Medium:** the temporary password is shown in plain text (56) and is not on the success screen. Superadmin must remember it to pass on. Fix: generate one, show it once on "Clinic is live" with a Copy button and "Send to owner on WhatsApp".
- **Low:** it always installs the dermatology pack (22, 44). Add a specialty choice before a second specialty arrives.

#### 35. Overview (parked, note only)
Not reachable (main.tsx:46 redirects to /dashboard). Notes in case it returns: old orange hard-coded colours (#C53B14, lines 50-53); raw states `r.state.replace('_',' ')` (76); "Intake" jargon (67); money count-up animation.

---

### 3. Jargon / microcopy (current → proposal)

| Where | Current | Proposal |
|---|---|---|
| Login.tsx:132 | "Take my step" | "Sign in" |
| Login.tsx:116 | "One patient. Four hands. One sign-in." | "Sign in to your clinic" |
| Login.tsx:117 | "Whoever you are in that walk, sign in here. Your email finds the clinic, your role opens your step." | "Use the email and password your clinic gave you." |
| Login.tsx:90 (offline) | "That email or password is not right." | "Can't reach the server. Check the internet and try again." |
| Login.tsx:133 | "Auto sign-out after a quiet spell. Every record opened is logged against your role." | "Every record you open is logged." (and the idle line only when idle sign-out is on) |
| ui.tsx:433 | "Use the menu above to find what you need." | "This page doesn't exist." + [Go to my home page] |
| ui.tsx:372 | "OK" (default confirm) | the verb: "Delete report", "Cancel visit" |
| palette.tsx:70 | "No match" (also on error) | "No patient called '{q}'. [Register new]" / "Couldn't search, no connection. [Retry]" |
| palette.tsx:72 | "⌘K opens this anywhere. Use the + button to start something new." | "Ctrl+K opens this from any page." |
| table.tsx:140 | "No one matches these filters" | "Nothing matches these filters" |
| table.tsx:134 | "Download what is shown, every page, as a spreadsheet (CSV)" | "Download as Excel (CSV)", and make it true |
| table.tsx:103 | "Clear selection" | fine |
| flags.tsx:34 | "Flags" | "Mark this patient" |
| flags.tsx:52 | "change" | "Change" (button) |
| Display.tsx:21 | "This screen link is not valid" (also on blips) | blip: "Reconnecting…"; 404 only: as now |
| Display.tsx:22 | "Connecting…" | fine |
| PatientLink.tsx:10 | "booked", "missed" (lowercase) | "Booked", "Missed" |
| PatientLink.tsx:28 | "This link is not valid" (also on no-internet) | 404 only; else "No internet. Try again." |
| PatientLink.tsx:81 / App.tsx:190 / index.html title | "CUBOTT Clinical" | "Cubott OPD" |
| Platform.tsx:18, 37, 48 | "Sign-in" / "sign-in name" (the slug) | "Clinic code" |
| Platform.tsx:18 | "Visits · 30d" | "Visits, last 30 days" |
| Platform.tsx:32 | `e.body.code` / "Failed" | `errText(e)` |
| api.ts:91 | "Failed" (bare fallback) | "Something went wrong. Please try again." |
| api.ts:91 | `b.message` passed through for INTERNAL | never show server internals; generic + reference id |
| api.ts:33 | ONLINE_BOOKING_OFF etc. | delete the stale online-booking codes (online booking removed) |
| Help.tsx:192 | "Tap Call to dial from a phone" | "Phone the number shown" |
| Help.tsx:260 | "Walk-in sale" | "New pharmacy sale" (match the + menu) |
| Help.tsx:77-87 | "Hand-off", "Drawer", "EMI awaiting settlement" | "Where they pay next", "Cash box", "EMI: bank money not in yet" |
| App.tsx:224 | "+" with title "New: check in, book, register…" | on Front desk: "+ Check in" |

---

### 4. Inconsistent patterns

- **Confirm style:** the app's `ask()` (ui.tsx:340) is mixed with browser `alert()` (api.ts:96 `listOut`) and `confirm()` (Followups.tsx:111). The danger button is outline-red-text (ui.tsx:372) while the patient link uses a filled rose (PatientLink.tsx:49).
- **Danger focus:** focus lands on the confirm button for danger (ui.tsx:372).
- **Date formats:** `fmtDate` gives "10 Nov" with **no year** (ui.tsx:410). It is used for last visit, the viewer's document date and Platform "Since", so a record from last year reads as this year. PrintRx uses "10 Nov 2026" (PrintRx.tsx:24) and PatientLink "Tue, 12 Nov" (7). Fix: add the year when it isn't this year.
- **Time formats:** `fmtTime` en-IN 12h "10:30 am" (api.ts:28); Today/Booking/Calendar use en-GB 24h "10:30" (Today.tsx:12, 14); the Display clock uses en-IN in the device time zone (Display.tsx:20); PatientLink shows raw `startTime`. Pick 12h "10:30 am" everywhere.
- **Money:** `money()` keeps paise (ui.tsx:409); `rupees()` rounds to whole rupees (api.ts:26) but is unused (dead code, delete it). `errText` builds its own ₹ strings (api.ts:75, 78), one with 2 decimals and one with none.
- **Brand:** "CUBOTT Clinical" (index.html title, App.tsx:190 fallback, PatientLink.tsx:81, manifest), "Cubott OPD" (Login.tsx:93), "CUBOTT admin" (Login.tsx:13). manifest `theme_color #C53B14` (old orange), index.html `theme-color #F2F2F2`, live accent teal #1F5E63.
- **Tables:** DataTable (uppercase 11.5px headers, 30px controls) against `.table` (Platform, Overview: sentence case, 12px).
- **Section switchers:** `Segmented` pills, `Tabs` underline, DataTable `dt-tabs` underline, and Help's `Filter` dropdown for guides.
- **Search wording:** three placeholders (section 8).
- **Error vs empty:** Bookings puts errors in the empty title; Patients and palette show nothing; Display and PatientLink treat every error as an invalid link.
- **Icons:** the same `inbox` for 3 sections and `chart` for 2; `spark` used as "photo" (Worklist.tsx:62) and as "light theme".
- **Back:** top bar Back plus a page Back on Help.
- **Colour hard-codes vs tokens:** `bg-white` in Help, flags, viewer and PatientLink; toast `#141C18`; Display `#15181B`; Overview `#C53B14`.
- **Light vs dark brand:** oat (cream/teal) is light only; dark is the old green.

### 5. Accessibility / responsiveness summary

- **Base size:** `html { font-size: 14px }` (index.css:46). Most secondary text is 11.5-12.5px (labels, chips, kbd, role name, dt headers). For older doctors and mixed literacy, raise the base to 15-16px and the minimum to 13px.
- **Contrast:** muted #5B6470 on cream #F1ECE1 is about 5:1 (OK). Placeholder `text-muted/70` is about 3:1 (fails 4.5:1). The Display footer is white/30, about 2.4:1. Disabled buttons at opacity .45 are OK as "disabled".
- **Touch targets:** buttons are 38px, `.btn-sm` 32px, `.btn-icon` 36px, DataTable controls 30px and checkboxes 16px at 768px and up. Only under 768px do they grow to 40-44px (index.css:264-269). Tablets need the coarse-pointer bump.
- **Keyboard:** Modal and ask have good focus traps. The palette, + menu and mobile drawer have none, and table rows aren't focusable. The header search has no focus ring.
- **Screen readers:** toasts have no live region. Page `h1` is `sr-only` (ui.tsx:76), which is good, but the visible title is a `nav` breadcrumb (App.tsx:215).
- **Motion/perf:** `backdrop-filter: blur(22px)` on every card (glass.css:39), three 500-640px orbs with `blur(90px)` still animating under oat even at opacity 0 (`--g-orb:0`, oat.css:17; glass.css:24-28), staggered fade-up on every row and card, and view transitions. This is heavy for low-end shared PCs and tablets (ASSUMPTION: no device testing done). Fix: `display:none` the orbs when `--g-orb` is 0; skip blur for `(prefers-reduced-transparency)` or low `deviceMemory`.
- **Reduced motion:** handled globally (index.css:113). Good.
- **Fonts:** Urbanist from Google Fonts (index.html) has no Telugu or Devanagari glyphs, so a fallback font will mix in once local languages arrive.

### 6. i18n

- **None in the shell.** Every string is hard-coded English. `index.html` is `lang="en"`. No i18n library and no locale switch. The only local-language support found is the Telugu phrase table for Rx printouts (SettingsPad.tsx:97-105, out of this scope).
- Patient-facing surfaces (PatientLink, Display, and ASSUMPTION: WhatsApp templates) are the priority for Telugu/Hindi; then Help.
- Lazy path: a flat `t()` map per surface for PatientLink + Display first (about 40 strings), a language chip, `lang` attribute per block, and a Noto Sans Telugu/Devanagari fallback in `--font-sans`.

### 7. Offline / patchy internet

- **No offline handling.** There is no `navigator.onLine` or `online`/`offline` listener anywhere in web/src, no service worker (the manifest has no icons and no SW), and no offline banner or write queue.
- Queries retry once (api.ts:3); `/me` doesn't retry (api.ts:24), and its failure redirects to login (App.tsx:188).
- `errText` has good copy for network failure ("Could not reach the server. Check the connection and try again.", api.ts:68). Few screens use it in their empty/error states: palette, DataTable, Display and PatientLink all show misleading text instead.
- Lazy fix: one global `useOnline()` with a top-bar amber strip "No internet. Changes will not save until it's back." Also: treat `TypeError: Failed to fetch` distinctly, `/me` retry 3 with backoff, and never redirect to login unless the status is 401.

### 8. Could not inspect / limits

- Nothing was run. Visuals, actual contrast, real tablet layout and performance are unverified.
- Whether demo/seed accounts and `SUPERADMIN_PASSWORD` fallback exist in production.
- Whether `/patients` returns masked phones for roles without permission (that would limit the export leak), and whether the server already audits list reads.
- TanStack Query v5 behaviour assumed for the Display error and clock findings (refetch error sets `isError` with data present; tracked props skip re-render).
- PrintRx content and paper settings (outside this area), the WhatsApp message templates, and whether the owner is really notified on `IP_NOT_ALLOWED`.
- Which callers pass small `max` values to `NumInput`, and which More-menu `danger` items skip `ask()`.


---

<a id="appendix-B"></a>
# Appendix B — Front desk / reception

## Front desk / receptionist UX audit — Cubott OPD

Scope: `web/src/pages/FrontDesk.tsx` (route `/queue`), `pages/frontDeskJourney.tsx`, `pages/frontDeskSchedule.tsx`, `screening.tsx`, `takePayment.tsx`, `vitals.tsx`, `dayChange.tsx`, `endOfDay.tsx`, `invoices.tsx`, `packages.tsx`, `routine.tsx`, `frontdesk.css`; server checks read in `src/modules/visits.ts`, `billing.ts`, `dayclose.ts`, `patients.ts`, `src/lib/auth.ts`. Files audited as they are on disk (uncommitted working tree, 10 Nov 2026). Nothing was run in a browser; every finding comes from the code. Anything inferred is marked **ASSUMPTION**.

Severity: **Critical** = can harm a patient, cause wrong billing or expose private data. **High** = a busy or untrained user will get it wrong or get stuck. **Medium** = slows people down or confuses them. **Low** = polish.

---

### 0. Who sees what (from the code)

| Role | Front desk nav (`App.tsx:21`) | Lands on (`homeFor`, `App.tsx:38`) | Relevant perms (`auth.ts:17-25`) |
|---|---|---|---|
| owner | yes | `/today` (has `encounter.complete`) | everything |
| admin | yes (`visit.*`) | `/queue` | `payment.*` incl. refund, `day.close`, no `discount.give` |
| receptionist | yes | `/queue` | `visit.*`, `payment.record`, **`payment.waive`**, `report.daily`, **no `payment.refund`, no `day.close`, no `discount.give`** |
| assistant ("Junior doctor") | yes (intake && !complete) | `/queue` | no `visit.write`, no `fees.see` (server strips `due`, `visits.ts:181`) |
| doctor | no | `/today` | — |
| coordinator / pharmacist | no | `/worklist` / `/pharmacy` | — |

What changes for the receptionist versus others on `/queue`: `canDesk = visit.write` (`FrontDesk.tsx:90`) turns on "For you now", Send in, Check in, Collect, Select, Schedule view, History, the journey drawer and the filmstrip. Junior doctor sees a read-only board with an **Intake** button (`:167`).

---

### 1. Screen inventory and findings

30 surfaces found. Ordered by how often the receptionist meets them.

#### 1.1 Front desk board shell (stage tiles + header row)
- **Where:** `FrontDesk.tsx:37-253`, tiles `frontDeskJourney.tsx:61-83`, CSS `frontdesk.css:9-17, 69-83`
- **Who / how:** receptionist, admin, owner (full); junior doctor (reduced). Sidebar "Front desk" or landing page.
- **Purpose:** one board for the whole day, stage tiles as tabs.

| # | Sev | Issue | Why it costs thought | Fix |
|---|---|---|---|---|
| 1 | High | Up to **9 stage tiles** (`:217`: For you now, Waiting, Initial screening, With doctor, Pending tests, Reports awaited, Done, Still to arrive, All) **plus** Table/Schedule toggle (`:219`), date + "History ›" (`:220`), "Select" (`:221`), doctor chip (`:218`). | 13 controls on one row; a new receptionist cannot tell which one is "my work". Fails the 5-second test. | Keep 4 tiles: **Next for me · Waiting · With doctor · Still to come**. Move Pending tests / Reports / Done / All into one "Later today" tile or the journey drawer. History becomes a sidebar link. |
| 2 | High | **No search on the board.** `const find = '';` (`:54`) hard-codes the search to empty; `match()` (`:93`) always returns true. The only search is the global Ctrl K palette. | Finding "Priya, 3 pm" among 60 rows means scrolling tabs. | Put a big search box at the top of the board: phone/name/token; Enter on a match opens that row; no match offers "Check in as new". It is search, not a duplicate "Check in" button, so it respects the no-duplicate-actions rule. |
| 3 | High | **No error/offline state.** `!d ? <Skeleton rows={3} />` (`:213`). If `/frontdesk` fails the first time, the skeleton spins forever. If it fails later, `refetchInterval: 5000` (`:41`) silently keeps showing stale data. | On patchy internet the desk acts on a queue that may be minutes old and nothing says so. | A thin top band: "Offline: last updated 10:42. Actions will wait." Show "Couldn't load. Retry" on first-load error. Grey out Send in/Collect while offline. |
| 4 | Medium | Polling every 5 s pulls the whole day (appointments, visits, recommendations, charges, payments) (`visits.ts:160-185`), plus `/orders` every 30 s (`:103`). | On a low-end PC or 3G this costs data and makes the table re-render and re-animate (`fd-tr` fade-up, `frontdesk.css:64`). | 15-20 s when the tab is hidden; send only what changed (ASSUMPTION: no ETag/If-Modified-Since support today). |
| 5 | Medium | Names drift for the same stage: tile "Done" vs group "Completed · newest first" (`:146`) vs empty text "Nothing completed yet" (`:150`); tile "Still to arrive" vs "Not yet arrived" (`:140`) vs "Booked, not arrived" (journey `:171`) vs "Booked, not here yet" (schedule `:10`); "Pending tests" vs "Pending tests & procedures" vs "Checkout" (`:140`) vs "Nothing pending after the doctor"; "Reports awaited" vs "Reports pending" vs "Awaiting reports" (`:649`); "Initial screening" vs "with junior" vs "Intake". | Staff learn one word and then see another for the same thing. | One word list (see §4) used in tiles, groups, empty states and chips. |
| 6 | Low | Dead code: `tabs` (`:140`), `Stat`/`Sep` (`:258-261`), the `needs` and `intake` groups, `emptyText.needs` — "Needs you" can never be reached from the tiles. | Not visible to users, but the next change is more likely to break something. | Delete. |
| 7 | Medium | Tile labels are 11 px uppercase muted (`frontdesk.css:13`); counts are 22 px. | Hard to read from arm's length on a shared monitor; uppercase is slower to read. | 13-14 px sentence case, ink colour. |
| 8 | Medium | Doctor filter can only be set from the "For you now" table header (`:236`, only when there are 3+ options) or Schedule (`frontDeskSchedule.tsx:45`), but it silently filters every other tab; outside those tabs there is only an "×" chip (`:218`). | The receptionist forgets the filter and thinks patients have vanished. | Show the doctor filter as a visible dropdown in the header on every tab, with "All doctors" as its label when it is off. |

#### 1.2 "Doctor is calling" banner
- **Where:** `FrontDesk.tsx:106-110, 212`. Receptionist (`canDesk`).
- **Purpose:** the doctor pulled a patient in from the pad; the desk hears a chime once.

| Sev | Issue | Why | Fix |
|---|---|---|---|
| Medium | It disappears by itself after 45 s (`:109`) and chimes only once. | A receptionist on the phone misses it and there is no trace. | Keep it until dismissed; also show "called 2 min ago" on that row. |
| Low | The dismiss button says **"Sent"** (`:212`). | Sounds like a sending action, but it only hides the banner. | "OK, sending them in". |

#### 1.3 "For you now" (NextForYou), the receptionist's default tab
- **Where:** `frontDeskJourney.tsx:119-187`; wired at `FrontDesk.tsx:233-236`. Default tab for `visit.write` (`:42`).
- **Purpose:** only the rows that need the desk, in groups: Send in now, Pending tests & procedures, Reports came in, Reports running late, Booked, not arrived, Money due.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | **Critical** | **Money due → "Collect ₹X" records a cash payment in one tap** (`journey:179` → `FrontDesk.tsx:236` → `collect` `:87`). No choice of mode (always `method: 'cash'`), no confirm, no amount, no receipt. `collect` is not disabled while pending and gets a fresh `uuid()` on every call, so a double-tap posts **two payments**. Server `/payments` (`billing.ts:255-273`) has **no check against the amount due**: it inserts and then marks the charge paid. | A UPI payment is booked as cash, so the drawer count fails at night; a double-tap doubles the takings; there is no undo. | Turn the button into a split control **[₹500 Cash] [₹500 UPI]**, disable it while sending, use one idempotency key per row, and on the server reject the payment when it is more than the amount due (as `/payments/take` already does, `billing.ts:299`). Show a 7 s "Undo" toast and offer the receipt. |
| 2 | High | "Reports came in" → **"Send in"** (free return) creates a visit, gives a token, waives the fee and sends the patient into the room in one tap (`FrontDesk.tsx:77-86`, `journey:164`). The row's token is "—" because the patient is not checked in yet. | The receptionist may tap it just to "see" the row; a token is issued for someone who is not in the building. The same action is labelled "Patient is here" past the free days. | Use one label for both: **"Patient is here"**. Free returns then show "No fee · send in now?" with Send in as the second tap. |
| 3 | High | Rows open the journey drawer only when the **name** is tapped (`journey:34`, `title="Show the journey"`); nothing shows it can be tapped. | A hidden affordance. | Make the whole row tappable, with a chevron. |
| 4 | Medium | A 7-column table (`journey:146`) inside `overflow-x-auto`. On a tablet in portrait the action column scrolls off screen. | The single action per row is the thing people need, and it is the first thing lost. | Below 900 px, use cards: name + status on top, one big action on the right. |
| 5 | Medium | The "Nothing to do for" chips use the first name only (`journey:184`). | Two "Priya"s cannot be told apart. | Token + first name ("A-12 Priya"). |
| 6 | Medium | The Send in animation waits 420 ms before sending (`journey:127-130`); if the request fails the row comes back after 2 s with only a toast. | On a slow network the row "leaves" and then reappears, and the toast is gone in 3.2 s. | Send at once, animate only on success, and show the error on the row itself. |
| 7 | Low | "Reports running late" → "Reports" opens `/tests` and leaves the board (`journey:169`). | A context switch for a look-up. | Open the journey drawer with the late tests listed. |
| 8 | Low | Status "Ready" vs "Screening done" vs "Back with reports" vs "Room full" in one column (`journey:150`). | Fine, but "Ready" is vague. | "Ready to go in". |

**Redesign sketch: Next for me**
```
[ Search phone / name / token ............ ]   Dr Rao 4 waiting | Dr Sen 2   ● Live 10:42
┌ Send in now ───────────────────────────────────────────────┐
│ A-12  Priya S · 28F · waited 34 min (amber)   [ Send in → ]│
│ A-13  Ravi K  · 41M · back with reports       [ Send in → ]│
├ Collect ───────────────────────────────────────────────────┤
│ A-09  Meena · ₹500 due          [ ₹500 Cash ] [ ₹500 UPI ] │
├ Not arrived (slot over) ───────────────────────────────────┤
│ 10:00 Arjun · Dr Rao                  [ Check in ] [ ⋯ ]   │
└────────────────────────────────────────────────────────────┘
```

#### 1.4 Table tabs (Waiting, With doctor, Still to arrive, Done, All, Initial screening)
- **Where:** row renderer `FrontDesk.tsx:142-204`, list `:238-241`, empty texts `:150`.
- **Purpose:** one list per stage with one main action per row.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | **Critical** | Done tab → **"Collect ₹X"** primary button (`:194`) and "Collect by UPI" in ⋯ (`:198`): the same one-tap, no-confirm, double-post problem as 1.3-1. | Same as above. | Same fix. |
| 2 | High | Waiting ⋯ → **"Left without consultation"** (`:170`) runs at once: no confirm, no undo in the UI, and the status `left` takes the patient off the queue. The bulk version does ask (`:71`). | One mis-tap in a menu and a waiting patient disappears; any fee paid now needs an owner refund. | Ask first: "Ravi K (A-13) left without seeing the doctor? Fee ₹500 was paid; the owner can refund it from History." Plus a 7 s Undo toast that sets the status back to `waiting`. |
| 3 | High | Waiting ⋯ → **"Change doctor"** (`:170`) silently picks `doctors.find(x => x.id !== current)`: the first other doctor. With 3 doctors you cannot choose; there is no toast. | Patients get sent to the wrong doctor's queue without anyone noticing. | Open a small picker listing each doctor with their waiting count; toast "Moved to Dr Sen's queue". |
| 4 | Medium | Still to arrive ⋯ → **"Mark no-show"** (`:181`) runs at once; toast "Updated" (`:60`). | Vague feedback; a mis-tap hides the booking. | Toast "Arjun marked no-show · Undo". |
| 5 | Medium | Waiting row sub-line shows phone, complaint, weight, BP (`:165`) to anyone near the screen. See 1.16 privacy. | — | Hide phone and complaint behind the drawer on the board. |
| 6 | Medium | Done row **"Explained"** primary button (`:195`) and "Mark as explained" (`:200`). | It is not clear what was explained, or to whom. | "Told the patient the plan" (tick). |
| 7 | Medium | "Move up" (`:170`) only moves one place; patients with priority are always sorted first (`visits.ts:168`), so "Move up" next to them seems to do nothing. | Looks broken. | Hide "Move up" when the row above has priority, or say "Priority patients stay on top". |
| 8 | Low | Select mode's exit button reads **"Done"** (`:221`). | Reads like "finished the job". | "Cancel selection". |
| 9 | Low | Row actions are `btn-sm` (32 px, `index.css:154`) and ⋯ is `btn-icon` 36 px. | Under the 44 px touch target. | 40-44 px on touch (`@media (pointer:coarse)`). |
| 10 | Low | Empty texts are fine and plain ("Nobody waiting", "Everyone booked has arrived"). Keep them. | — | — |

#### 1.5 Bulk selection bar + bulk confirm
- **Where:** `FrontDesk.tsx:62-73, 221-229`; dialog via `ask` (`ui.tsx`).
- **Purpose:** end-of-day no-shows / walked-out in one go.

| Sev | Issue | Fix |
|---|---|---|
| Medium | Runs one PATCH after another (`:63`); if the network drops halfway, some are marked and some are not, and the toast shows only the error. | Report "7 of 10 marked; 3 failed: retry". |
| Low | Late bookings come pre-ticked when entering Select on Still to arrive (`:221`): good default. The danger tone and body copy are clear. | — |

#### 1.6 Arrival step 1: "Who has arrived?" search modal
- **Where:** `FrontDesk.tsx:477-488`. Opened from "+" → "Check in a patient" (`palette.tsx:13`, `/queue?arrive=1`, `FrontDesk.tsx:57`).
- **Purpose:** find the patient or start a new registration.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | **Critical** | **Weak duplicate guard.** The server warns only when phone **and** full name match exactly, case-insensitive (`patients.ts:203-207`: `ilike(fullName, body.fullName)` with no wildcards). "Priya S" vs "Priya Sharma" on the same phone, or no phone at all, creates a second record. Results also never show `lastVisitAt`/`mainProblem`, which the server already returns (`patients.ts:177-178`). | A second record splits the allergy history entered at first visit (`FrontDesk.tsx:535`). The doctor opens a record that says "no allergies". That can harm a patient. | On "New patient", always run a phone-only match first and list **everyone on that number** ("2 people use 98765 43210: Priya S 28F last seen 3 Oct · Ravi S 55M"), so the receptionist has to pick or say "Someone else". Show last visit + main problem in the result rows. |
| 2 | High | "New patient" is enabled before anything is searched (`:485`, shown even when `q.length < 2`). | Encourages registering before searching. | Show it only after 2+ characters with no exact phone hit, worded "Not in the list: register new". |
| 3 | Medium | No keyboard pick: arrow keys/Enter do nothing in the results; each result is a mouse target. | Fast typists have to reach for the mouse. | ↑/↓ + Enter; the top result is highlighted. |
| 4 | Medium | Placeholder "98765…" (`:480`). | It reads like a real number. | "Phone, name or P-number". |
| 5 | Low | "Type at least 2 characters" / "No match. Register below." are plain and good. | — | — |

#### 1.7 Check-in form (the big one)
- **Where:** `ArrivalSheet` `FrontDesk.tsx:403-606`; modal `max-w-6xl`. Sections: patient card or New patient (1), About the patient (first visit), Vitals, Why they came; right rail: Doctor, Visit type, Paid by, Amount, Waive, Check in.
- **Who:** `canDesk` only (`:210`).

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | **Critical** | **The amount has no upper bound.** `MoneyInput` defaults to the fee (`:591`), but `blocker` checks only `collect <= 0` (`:468`); the server accepts any `amountPaise` up to ₹10,00,000 (`visits.ts:50`) and never compares it with the fee (`:117-121`). Typing 5000 for a ₹500 fee records ₹5,000 received. Typing less silently leaves the charge "due" with no message. | Wrong takings, a drawer that will not balance, and part-payments nobody notices. | Lock the amount to the fee by default (shown as text). A small "Different amount" link opens the field; above the fee → block "More than the fee"; below → show "₹200 will stay due" before the button. Server: reject `amountPaise > fee` at check-in. |
| 2 | **Critical** | **Check-in payments skip the day lock.** `/payments` and `/payments/take` call `assertDayOpen` (`billing.ts:258, 290`); `POST /visits` does not (`visits.ts:60-124`). After the day is closed, every check-in still adds money to the closed day. | The closed figures and the real takings no longer match. | Call `assertDayOpen` in `POST /visits` when there is a payment; in the UI show "Today is closed: the fee will be recorded as due" (or block the payment). |
| 3 | High | **Payment mode defaults to Cash** (`:415`) and is a small segmented control above the amount (`:588`); the big button says "Check in · collect ₹500" without the mode (`:596`). There is no UPI reference/UTR field, although the API accepts `reference` (`visits.ts:50`). | UPI payments get booked as cash, so the drawer is "short" every evening. | Replace the mode toggle + button with **three submit buttons: [₹500 Cash] [₹500 UPI] [₹500 Card]**: the same clicks, and the mode can no longer be skipped. UPI: an optional "last 4 of UTR" field. Optionally show the clinic's UPI QR with the amount filled in. |
| 4 | High | **A stray click outside the modal, or Esc, throws away the whole form** (`ui.tsx` `Modal`: backdrop `onClick={onClose}`, Esc → `close.current()`). The form can hold name, DOB, conditions, allergies, vitals, complaints. | Re-typing a full first-visit form while the patient waits. | No backdrop close on this modal; on Esc with typed data, ask "Discard this check-in?". |
| 5 | High | **Waive is one link + one character.** Receptionist has `payment.waive` by default (`auth.ts:22`); "Waive the fee" (`:598`) shows a text box, and the moment one letter is typed the fee becomes ₹0 ("Fee waived") (`:590-594`); server min length 1 (`visits.ts:51`). | Leakage nobody notices; the toggle is also odd (clear the text to un-waive). | Make waive a checkbox "Waive ₹500" + a reason picker (Staff family / Doctor said / Hardship / Other…) with 3+ characters required, server `min(3)`. Consider moving `payment.waive` from receptionist to admin/owner, or require the owner's approval above ₹X. |
| 6 | High | **No receipt.** Check-in payments get no `receiptNo` (only `/payments/take` assigns one, `billing.ts:300`), so "Print receipt" never appears for the commonest payment (`invoices.tsx:48` hides it when `!rno`). The success feedback is a 3.2 s toast "Checked in · token A-12" (`:454`). | The patient asks for a receipt and the desk has nothing to give; the token vanishes before it is read aloud. | After check-in show a confirmation sheet: big **Token A-12**, "₹500 UPI received", [Print token & receipt] [Send on WhatsApp] [Done]. Give receipt numbers at check-in. |
| 7 | High | **Too many fields for a walk-in on one screen.** A first visit shows: name, mobile, DOB, age, sex, address, a conditions grid (`Checks`), allergy tags, 5+ vitals, complaints with duration, doctor list, visit type, mode, amount, waive. None are marked required/optional except Vitals ("Optional"). The rules live only in the amber `blocker` line (`:468`), which shows **one** problem at a time. | The receptionist cannot tell what is mandatory; the button stays grey with one reason at a time. | Required at the desk: name, mobile, age or DOB, sex, fee. Everything clinical (conditions, allergies, vitals, complaints) goes into a collapsed "For the doctor (optional)" section, or is left to screening. Mark "(optional)" in labels; show all missing items at once next to the button. |
| 8 | Medium | "Location today" (returning, `:518`) vs "Address" (first visit, `:531`) write the same field `locality`. | Same data, two names. | "Area / town" in both. |
| 9 | Medium | Doctor is preselected as "the shortest queue" for walk-ins (`:424`) without saying why. | Patients often ask for a named doctor; the receptionist may not notice it was preselected. | Label "Dr Sen (shortest queue)" and do not preselect when the patient was booked. |
| 10 | Medium | A REVIEW_LIMIT error for a receptionist is a long toast (`:458`) that disappears in 3.2 s (`ui.tsx` toast). | Unreadable in time; nothing tells the receptionist what to do next. | Show it inline in the rail: "1 free review already used since 3 Oct. Choose a paid visit, or ask the owner." with a button that switches to the paid type. |
| 11 | Medium | `isFirst` depends on the timeline load (`:431`): while it loads the form shows the returning layout, then "About the patient" jumps in. | Layout shift; focus can land in the wrong field. | Skeleton until the timeline arrives. |
| 12 | Medium | Retry after a network timeout: `idempotencyKey: uuid()` is made inside `mutationFn` (`:452`), so a retry is a new key. Same-day check-in is guarded server-side (`ALREADY_CHECKED_IN`), but a **new** patient without a phone is created again (`:444`). | Duplicate records on bad networks. | Make the keys once per sheet (`useState(uuid)`), for both the patient POST and the visit POST. |
| 13 | Medium | On tablets the rail (doctor, fee, Check in) is sticky only at `lg` (`:577`); below that, the button sits under all the sections. | Long scroll to the only action. | A sticky bottom bar with the fee + submit at every width. |
| 14 | Medium | No ABHA field, no language preference, no WhatsApp consent. | Indian context: ABHA linking and WhatsApp reminders are expected. | Optional "ABHA number / address" under "More details"; a "WhatsApp OK" tick next to mobile. |
| 15 | Low | The phone is cleaned to 10 digits (`:501`) but not checked for a leading 6-9. | Junk numbers get in. | `/^[6-9]\d{9}$/`. |
| 16 | Low | The numbered section badges (1, 2, 3…) are renumbered on the fly (`let n = 2`, `:474`). | Numbers suggest a fixed order and steps that are not there. | Drop the numbers. |

**Redesign sketch: Check in (walk-in, new)**
```
Check in                                                     [×]
┌ Who ──────────────────────────────────────────────────────────┐
│ Mobile [98765 43210]  ⚠ 2 people use this number: [Priya S 28F]│
│ Name   [Priya Sharma        ]  Age [28] or DOB [  ]  [M][F][O] │
└───────────────────────────────────────────────────────────────┘
▸ For the doctor (optional): complaint, vitals, allergies
──────────────────────────────────────────────────────────────────
Doctor: (•) Dr Rao · 4 waiting   ( ) Dr Sen · 2 waiting
Visit:  General consultation ₹500 ▾      Waive…  Different amount…
[  ₹500 Cash  ]   [  ₹500 UPI  ]   [  ₹500 Card  ]      ← submit
──────────────────────────────────────────────────────────────────
then:  Token A-12 · ₹500 UPI received   [Print] [WhatsApp] [Done]
```

#### 1.8 Duplicate-patient banner
- **Where:** `FrontDesk.tsx:521`. Shown on 409 `POSSIBLE_DUPLICATE`.

| Sev | Issue | Fix |
|---|---|---|
| High | It only appears **after** pressing Check in, and only on an exact name+phone match (see 1.6-1). "It is someone else" registers at once (`forceNew` → `submit.mutate()`, `:464`) with no second look. | Show matches while the mobile number is typed; "Someone else" should need a different name or a guardian link. |
| Low | The icon is `spark` (`:521`) for a warning. | Warning icon. |

#### 1.9 Review-limit dialog
- **Where:** `FrontDesk.tsx:459`. Only users with `payment.refund` (owner/admin) see it; the receptionist gets the toast (1.7-10).

| Sev | Issue | Fix |
|---|---|---|
| Low | Clear title "Allow one more free review?" and a required reason: good. Confirm "Allow and check in" is explicit. | — |

#### 1.10 Journey drawer
- **Where:** `frontDeskJourney.tsx:204-268`. Opened by tapping a name, a filmstrip token, an idle chip or a schedule chip.
- **Purpose:** one patient's day as steps, with the open tasks inside.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | Medium | Shows the "₹X due" chip (`:255`) but no Collect action. | You see the problem but have to close the drawer to act on it. | Put the Cash/UPI collect buttons in the drawer. |
| 2 | Medium | `${inLine}th in line` (`:222`) gives "2th", "3th", "22th". | Visibly wrong English. | "2nd", or "1 ahead". |
| 3 | Medium | Not a dialog: focus does not move into it, and there is no focus trap (`Drawer`, `:261-268`); on phones it is full width, covering the board. | Keyboard users and screen readers lose their place. | Move focus to the heading on open and back to the row on close. |
| 4 | Low | The step titles are plain and good ("Checked in → Initial screening → Doctor → Tests & procedures → Reports → Done"). | — | — |

#### 1.11 Filmstrip (bottom token strip + keyboard)
- **Where:** `frontDeskJourney.tsx:86-116`; `FrontDesk.tsx:242-243`.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | High | **A window-wide Enter key sends the selected patient in** (`:98`, `onEnter` → PATCH `in_consult`, `FrontDesk.tsx:243`), whenever focus is not in an input or button, the drawer is the selection, and no modal is open. Arrows change the selection globally too. | After closing a dialog, focus often falls back to `body`; one Enter sends whoever is selected, perhaps the wrong patient. Nothing confirms it. | Only handle keys when focus is inside the strip; the toast should name the patient with Undo ("Priya sent in · Undo"). |
| 2 | Medium | Stage is shown by colour only (`fd-ft.arr/doc/jr`, CSS `:50-52`); the name and stage are in a hover `title`. | Colour-blind users and touch screens get nothing. | A small text or icon per group ("Waiting · With doctor · Done"). |
| 3 | Low | "← → step · Enter sends in" (`:114`) is a hint only power users read. | — | Keep, but see #1. |

#### 1.12 Pending tests & procedures (CheckoutList), plus its decline and close dialogs
- **Where:** `FrontDesk.tsx:618-662`; tab "Pending tests" and inside the journey drawer (`bare`).
- **Purpose:** after the doctor, settle every plan item (schedule a procedure, give the lab slip, book the review).

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | Medium | Action words: "Plan" vs "Schedule" (`:646`) for the same procedure row depending on `procedureId`; "Slip given"; "Book visit"; ⋯ "Do later", "Patient declined". | "Plan" is not a verb the desk uses. | "Book sittings", "Lab slip given", "Book review", "Not now", "Patient said no". |
| 2 | Medium | "Close visit" stays disabled while items are open; the receptionist cannot force it (`canForce = config.write`, `:237`). The helper text "Close visit unlocks when nothing above is pending." is good. | When the patient has simply left, the desk is stuck with a row that never clears. | Let the desk use "Patient left: close" with a reason (the reason is already audited, `:626`). |
| 3 | Low | The "hand-off" chip text (`:650`) says the payment rule in plain words ("Consultation was paid at check-in… Procedures are paid on the procedure day"). Good, and it matches the clinic's rule. | — | Keep. |
| 4 | Low | Decline dialog: "Patient declined tests?" with an optional reason and "Declined"/"Keep" labels (`:623`): clear. | — | — |

#### 1.13 Reports awaited (ReportsQueue)
- **Where:** `FrontDesk.tsx:665-689`.

| Sev | Issue | Fix |
|---|---|---|
| Medium | "Send in · partial" / "Patient is here · partial" (`:683`). "partial" is unclear. | "Patient is here (2 of 3 reports in)". |
| Medium | Same "Send in creates visit + token" problem as 1.3-2. | Same fix. |
| Low | Status chips ("all results in", "waiting for the lab", "reviewed · patient to be told") are plain. Keep. | — |

#### 1.14 History panel (+ filter dropdown, print, export)
- **Where:** `FrontDesk.tsx:266-333`; reached by "History ›" (`:220`).
- **Who:** `canDesk`; Refund only for `payment.refund` (owner/admin); print/export only when `privacy.canExport`.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | **Critical** | **"Refund" records a refund in one tap**, with no confirm, a fixed reason "left without consultation" and no mode (`:283, :326`). The server only flips `charge.status` to `refunded` (`billing.ts:276-284`); it **creates no outgoing payment**, so the money stays in the day totals and the End-of-day drawer (`dayclose.ts:27-31` counts `payment` rows only). | The drawer is short by the refunded cash and nothing explains it. One accidental tap with no way back. | Confirm "Refund ₹500 to Ravi K by Cash / UPI?" and record a negative payment (or a refund row) dated today with its mode, so End of day subtracts it. Show it on the day's report. |
| 2 | Medium | Summary "₹X collected" (`:310`) sums every payment on those visits, refunded ones included (`visits.ts:143`). | It overstates takings. | Net of refunds. |
| 3 | Medium | Filter dropdown labelled with the period ("Last 7 days · No-shows"), funnel icon, and a chevron rotated 90° (`:293`). Fine, but the "Pick dates" option needs a second interaction inside the popover. | — | OK; add "Apply". |
| 4 | Low | Loading/empty states ("Loading…", "Nothing found for this period") and the 500-row cap note (`:329`) are good. | — | — |

#### 1.15 Schedule view
- **Where:** `frontDeskSchedule.tsx:22-151`; toggled from the header (`FrontDesk.tsx:219`), remembered in localStorage.
- **Purpose:** the day as columns per doctor/room, patients as coloured chips.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | Medium | **Tapping a booked chip opens check-in directly** (`:87`) on today, even for a late chip. | People tap to look, not to act. | Tap → drawer/booking details with a "Check in" button inside. |
| 2 | Medium | A visit with status `left` is drawn as **"No-show"** (struck through) (`FrontDesk.tsx:231` → `noshow`, CSS `:119`). | "Left after arriving" and "never came" are different and are reported separately in History. | A separate "Left" kind. |
| 3 | Medium | Chips are 28 px tall with 11-12.5 px text (CSS `:105-108`); details are in a `title` tooltip only (`:149`). | Small targets on touch; hover-only info. | 36 px chips on touch; long-press shows details. |
| 4 | Medium | A sitting tile navigates away to `/worklist` (`:137`). | Leaves the board. | Open the sitting in a drawer. |
| 5 | Low | Empty copy "No doctor has hours on Tue 11 Nov. Hours are set in Calendar." (`:65`) is helpful. | — | — |
| 6 | Low | "+ Book · 3 free" (`:123`) is clear. "3 of 7" capacity (`:125`) has no label. | — | "3 of 7 booked". |

#### 1.16 Privacy on the board (cross-cutting)
| Sev | Issue | Fix |
|---|---|---|
| High | Every row shows the full mobile number and the presenting complaint in plain text (`FrontDesk.tsx:165, 180`; journey `:29`). In a dermatology clinic complaints can be sensitive, and reception screens usually face the waiting area (ASSUMPTION: monitor placement). The export is gated (`:271`) but the screen is not. | Mask the phone (98••• ••345, as `patients.ts:216` already supports) and hide the complaint on the board; show both in the drawer. A "privacy screen" toggle (names only as "Priya S."). |

#### 1.17 Book modal from Schedule
- **Where:** `FrontDesk.tsx:245-246` → `BookForm` (`pages/Booking.tsx`, not in scope).

| Sev | Issue | Fix |
|---|---|---|
| Low | Subtitle "Today · 10:00–11:00 · Dr Rao" is clear. The form itself was not inspected. | — |

#### 1.18 Toasts (all front-desk feedback)
- **Where:** `ui.tsx` toast: 3.2 s, or 7 s with an action; pill at the bottom centre.

| Sev | Issue | Fix |
|---|---|---|
| High | **Errors vanish in 3.2 s** like successes; several are long sentences (review limit `FrontDesk.tsx:458`, room full `:83`). | Errors stay until dismissed; long guidance goes inline, not into a toast. |
| Medium | Vague text: "Updated" (`:60`), "Collected" (`:87`), "Visit closed". | Name the patient and amount: "₹500 cash from Meena". |
| Medium | Undo exists only for Change my day (`dayChange.tsx:267`). | Add Undo to Send in, Left, No-show and Collect. |

#### 1.19 Take payment modal
- **Where:** `takePayment.tsx:86-123`. Patient profile → Take payment (`Patients.tsx:156`). Users with `payment.record`.
- **Purpose:** settle one or more invoices across several modes (UPI/Cash/Card/EMI/Bank).

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | Medium | Default mode **UPI** here (`:91`) vs **Cash** at check-in (`FrontDesk.tsx:415`) and Collect (`:194`). | Same task, different defaults; muscle memory picks the wrong one. | No default anywhere: the mode buttons are the submit (as in 1.7-3). |
| 2 | Medium | UPI reference label "Ref, last 4 digits" (`:113`); a UPI UTR is 12 digits and the field takes 60 characters. | It is unclear what to type. | "UPI ref (last 4 of UTR), optional". |
| 3 | Medium | No receipt after success: the server returns `receiptNo` (`billing.ts:313`) but the toast only says "Taken ₹X" (`:99`). `courses.tsx:61` does print. | Inconsistent; the patient asks for a receipt. | Same success sheet as check-in: [Print receipt] [WhatsApp]. |
| 4 | Low | Guards are good: "Tick at least one invoice", "That is ₹X more than is due", EMI needs lender + code (`:96`); the server agrees (`billing.ts:299`). The "Split across another mode" button is fine. | — | — |

#### 1.20 EMI awaiting + "Match the bank credit"
- **Where:** `takePayment.tsx:126-141`; Reports page (`Reports.tsx:49`). `payment.record` (receptionist sees it).

| Sev | Issue | Fix |
|---|---|---|
| Medium | Jargon: "EMI awaiting settlement", "Bank credit arrived", "Match the bank credit", "What the lender kept (fee)", button "Matched". A front-desk person rarely sees the bank statement. | Admin/owner only. Copy: "Lender has paid us" → "How much did the lender keep?" → "Save". |

#### 1.21 Invoices section + its dialogs (discount, cancel, refund, leave out of tax)
- **Where:** `invoices.tsx:25-57`; patient profile (`Patients.tsx:154`).

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | High | **"Leave out of tax reports"** (`:31, :52`): permanent ("This cannot be undone"), any reason of 3+ characters, confirm button **"Save"**; available to anyone with `payment.refund` (owner and admin by default). | A dangerous, compliance-sensitive action behind a generic "Save". | Owner only; the confirm says "Leave ₹X out of tax reports"; the reason comes from a picker; show it in the audit log and the day report. |
| 2 | Medium | All dialogs confirm with **"Save"** (`:28`) even for "Refund ₹500?" and "Cancel this invoice?". | The button does not say what will happen. | "Refund ₹500", "Cancel invoice", "Give ₹100 off". |
| 3 | High | Refund here has the same server problem as 1.14-1: no money-out record, full amount only, no mode. | — | Same fix. |
| 4 | Medium | Discount is two dialogs in a row ("Rupees off" → "Take ₹X off?") (`:32-36`); "Rupees off" is a free-text box. | — | One dialog: amount (₹ input) + reason picker, showing the new total. |
| 5 | Medium | Status words: "Unpaid", "Part paid", "Paid", raw `Cancelled/Refunded/Waived` (`:42`). Fine. There is no invoice number in the row. | Patients and auditors ask for invoice numbers. | Show the invoice no. |

#### 1.22 Receipt print view
- **Where:** `invoices.tsx:9-22` (popup window, `document.write`); data from `billing.ts:376-384`.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | High | **"Received by" is the person printing, not the person who took the money** (`billing.ts:382`: `receivedBy: req.ctx.name`). | A reprint by the admin says the admin received cash: a wrong financial record. | Use `payment.receivedBy` joined to the user name. |
| 2 | High | **Not a tax invoice.** No GSTIN, no invoice number, no HSN/SAC, no taxable value / CGST / SGST split, although procedures can be 18% "cosmetic" (`Settings.tsx:441`, `charge.taxRateBp`). Patient phone/address missing. (Pharmacy bills do print the GSTIN, `Pharmacy.tsx:509`.) | Cosmetic procedure bills need a GST tax invoice; patients claiming reimbursement need a proper bill. ASSUMPTION: amounts are tax-inclusive; that is not visible. | A "Tax invoice / Bill of supply" layout: clinic GSTIN, invoice no., SAC 999312 (or the clinic's code), taxable value, CGST 9% + SGST 9%, amount in words, mode, received by. Print at A5 and 80 mm thermal. |
| 3 | Medium | Pop-up blocked → toast "Allow pop-ups to print the receipt" (`:12`). | Non-technical staff cannot fix browser settings. | Print in-page through the existing `PrintHost`. |
| 4 | Medium | No language other than English; no "Thank you / visit again" line beyond the footer setting. | — | Optional second language line (Hindi/Telugu) for the clinic name and totals. |

#### 1.23 End of day
- **Where:** `endOfDay.tsx:10-58`; Reports → "End of day" segment (`Reports.tsx:27`). GET needs `report.daily` + `fees.see`; closing needs `day.close` (`dayclose.ts:54-64`).

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | **Critical** | The drawer figure ignores refunds and check-in payments made after close (1.14-1, 1.7-2). | "The app says ₹X" is wrong whenever there was a refund; the cash count "fails" for a true drawer. | Fix the server money model (refund rows, day lock on check-in). |
| 2 | High | **"Close the day" has no confirmation** (`:52`), yet it locks the day for good (`:28`: "This day takes no new payments"). | One click past the notes locks the books. | Confirm: "Close Mon 10 Nov? Cash ₹12,400 counted (₹200 short, note given). No more payments today after this." |
| 3 | High | **Role mismatch:** the code comment says "The head receptionist reads one page…" (`:9`), but the receptionist has no `day.close` (`auth.ts:22`) and sees "Closing the day needs the Close the day permission." (`:54`). | The person who counts the drawer cannot close it; the owner has to come to the desk. | Decide who closes it. Either give a "head receptionist" role `day.close`, or let the receptionist "Submit count" and the owner "Approve & lock". The message should say who to ask: "Ask the owner or admin to close the day." |
| 4 | Medium | **Diary counts are pre-filled with the app's numbers** (`:46`, `diary[k] ?? String(d.counts[k])`), so the comparison with the paper diary passes without anyone checking. | The safety check checks nothing. | Leave the diary boxes empty; require each one. |
| 5 | Medium | "Against the doctor's diary" and row keys printed raw (`General`, `Procedure follow-up`, `Relatives and friends`) (`:45-47`). | Fine for this clinic, but jargon for others. | "Check against the paper register". |
| 6 | Medium | "Counted" cash is one number; there is no denomination helper. | Counting ₹2,000/500/200/100/50 notes on paper and then adding up. | An optional note counter (₹500 × [ ]…) that fills the total. |
| 7 | Low | The difference chips ("over by ₹200", "matches", "same") and "Each difference needs a note before the day can close." are clear. | — | — |

**Redesign sketch: Close the day**
```
Close Mon 10 Nov                                   (owner/admin)
1 Cash   App expects ₹12,600 (cash in ₹13,100 − refunds ₹500)
         Counted [₹12,400]   ⚠ short ₹200   Why [ ............ ]
2 UPI    App ₹18,200   Bank app shows [₹18,200] ✓
3 Visits Register  General [  ] Review [  ] Procedure [  ] …  (blank, required)
──────────────────────────────────────────────────────────────
[ Close the day… ]  → confirm: "No more payments today. Close?"
```

#### 1.24 Change my day (doctor exceptions)
- **Where:** `dayChange.tsx:18-123`; Calendar → doctor → change (`Calendar.tsx:108,121`, when `canChangeDoc`; ASSUMPTION: includes the receptionist with `appointment.write`), and Today for doctors.

| # | Sev | Issue | Why | Fix |
|---|---|---|---|---|
| 1 | Medium | First-person copy when the desk acts for a doctor: title "Change my day", "I'll leave at" (`:81`). | The receptionist reads "my". | "Change Dr Rao's day", "Leaves at". |
| 2 | Medium | **"Tell N"** for Running late sends WhatsApp at once (`:51`, the save button) with only the preview as a check. Undo exists only in the 7 s toast (`:46`). | Messages go to patients; Undo does not un-send them. | The button says "Send WhatsApp to 6 patients"; note "Messages cannot be recalled". |
| 3 | Low | Stale copy: "Front desk and online booking can fill it" (`:11`); online booking was removed (project memory 9 Nov). The message preview shows a literal "link." (`:104-105`). | — | Drop "online booking"; show the real link in the preview. |
| 4 | Low | Good: affected patients are listed before saving, with "Nobody is affected." (`:91`). | — | — |

#### 1.25 Weekly routine modal
- **Where:** `routine.tsx:59-68`; Calendar → Weekly hours.

| Sev | Issue | Fix |
|---|---|---|
| Medium | No check that start < end or that ranges do not overlap (`:38-39`); "Patients per hour" can become 0 or empty (`:52`, `Number('')` = 0). Errors show the raw code (`:61`, `e?.body?.code`). | Validate inline ("End must be after start"); capacity min 1; use `errText`. |
| Medium | "Routine saved · windows follow it from today" (`:61`): what happens to bookings already made outside the new hours is not said (ASSUMPTION: the server keeps them). | Preview "3 bookings fall outside the new hours" before saving, as Change my day does. |
| Low | Jargon "OP windows", "Window length". | "Booking slots", "Slot length". |

#### 1.26 Packages card / Calendar text size (Settings)
- **Where:** `packages.tsx:9-50`; Settings → Procedures. `config.write` only, so **not the receptionist** (it is in the requested file list, so it is covered briefly).

| Sev | Issue | Fix |
|---|---|---|
| Low | Remove (×) deletes a package without a confirm (`:26`). | Undo toast. |
| Low | Price is required but the label does not say so; the Add button is just disabled. | "(required)". |

#### 1.27 Screening block / Screening card (junior doctor, on the pad)
- **Where:** `screening.tsx:23-70`; used in `Encounter.tsx:847, 907`. Assistant role, not the receptionist.

| Sev | Issue | Fix |
|---|---|---|
| High | **"All the rest: No"** (`:41`) records every question not yet asked as an answered "No". The doctor's card then shows them as "Answered No" (`:66`), not "Not asked". | A screening answer that was never asked is shown to the doctor as a clinical negative. Label it "Mark remaining 6 as No" with the count; keep a flag saying they were bulk-answered. |
| Low | The `role="radiogroup"` on YesNo has no accessible name (`:17`). | `aria-label={q.q}`. |

#### 1.28 Vitals (check-in fields + pad tiles + Past values popover)
- **Where:** `vitals.tsx` (fields/ranges `:4-21`, `VitalsCard` `:34-73`); used in the check-in form `FrontDesk.tsx:541-555`.

| Sev | Issue | Fix |
|---|---|---|
| Medium | At check-in, height is not pre-filled from the last visit; adults are re-measured every time (ASSUMPTION: the clinic does not want that). | Pre-fill the last height for adults. |
| Medium | Temperature in °F only (`:10`). | Fine for India, but accept °C input (convert values < 45). |
| Low | Range errors are clear ("Weight should be 1–400 kg", "BP should read like 120/80"). Pad tiles save on blur: tapping away saves silently. | Keep; show "Saved" briefly. |

#### 1.29 Front desk CSS (cross-cutting look)
- **Where:** `frontdesk.css`.

| Sev | Issue | Fix |
|---|---|---|
| Medium | Glass with `backdrop-filter` on every sheet (`:7`) plus several continuous animations (`fd-drop`, `fd-pulse`, `fd-leave`, `fd-tick`, ring transitions). | Heavy on low-end PCs; text contrast on glass depends on the backdrop (ASSUMPTION: not measured). Add a "lite" mode (solid surfaces, no blur) when `prefers-reduced-transparency` or a device setting is on; measure muted-text contrast against the darkest backdrop. |
| Low | `sibling-index()` (`:64`) is not supported in most browsers yet; the stagger silently does nothing. | Remove, or set an inline `--i`. |
| Low | `prefers-reduced-motion` is respected (`:54`). Good. | — |

#### 1.30 Rx print button / CourseDialog / ScheduleModal / AppointmentDrawer
Reached from the front desk but defined outside the files in scope. **Not inspected** (see §6).

---

### 2. Core flows: clicks today vs proposed

Counting taps/clicks; typed fields are listed separately. "Proposed" assumes the fixes above.

#### (a) New walk-in, check in, consult fee by UPI
| Step today | Click |
|---|---|
| "+" in the top bar (`App.tsx:224`) | 1 |
| "Check in a patient" (`palette.tsx:13`) | 2 |
| type mobile in "Who has arrived?" | (type) |
| "New patient" (`FrontDesk.tsx:485`); mobile carried over, name focused | 3 |
| type name | (type) |
| click Age (or DOB) and type | 4 |
| Male / Female / Other (required on first visit, `:468`) | 5 |
| Paid by **UPI** (default is Cash, `:415`) | 6 |
| "Check in · collect ₹500" | 7 |
| (optional: complaint chip, vitals, conditions) | +1-6 |

**Today: 7 clicks + 3 typed fields; no UPI ref, no receipt, and the token disappears with the toast.** Cash = 6 clicks.
**Proposed: 3 clicks + 3 typed fields.** Type the mobile in the board search → "Register new: 98765…" (1) → name, age typed (Tab moves on), sex (2) → **[₹500 UPI]** (3) → confirmation sheet with token (Done, or Print as a 4th click when wanted).

#### (b) Booked patient arrives (returning patient)
| Step today | Click |
|---|---|
| Default tab "For you now" lists the booking only once its slot is **over** (`late`, `:113`). So: tap "Still to arrive" tile | 1 |
| scroll to find (no search on the board) | (scroll) |
| "Check in" on the row (`:181`) → form opens with doctor from the booking and visit type suggested | 2 |
| Paid by UPI (skip for cash) | 3 |
| "Check in · collect ₹500" | 4 |

**Today: 3 clicks (cash) / 4 (UPI)**, plus a scroll. If the patient was registered at booking and never seen, age + sex are required: **+2 → 5-6.**
**Proposed: 2 clicks.** Type the name/phone in the board search → the row shows "Booked 10:00 · Dr Rao" with **[Check in]** (1) → the form opens with everything preset → **[₹500 UPI]** (2).

#### (c) End-of-day close (owner/admin only today; the receptionist cannot)
| Step today | Click |
|---|---|
| Front desk: "Still to arrive" (1), "Select" (2; late pre-ticked), "Mark no-show · N" (3), confirm (4) | 4 |
| Waiting: tile (5), "Select" (6), "All" (7), "Mark as left" (8), confirm (9) (only if people walked out) | +5 |
| Sidebar "Reports" (10), "End of day" segment (11) | 2 |
| click "Counted", type cash | 1 (+type) |
| diary boxes pre-filled: 0 clicks if accepted blindly (the problem in 1.23-4); each real mismatch is click + type + click "Why" + type | 0-10 |
| "Close the day" (**no confirm**) | 1 |

**Today: 4 clicks minimum for the close itself (8 with no-shows, 13 with walk-outs)**, and the check is weak because the diary is pre-filled.
**Proposed: 6-7 clicks, on purpose not fewer.** One "Close today" page linked from the front desk header at closing time: (1) "Mark 3 late bookings as no-show" one button + confirm (2) → cash counted (3) → register counts typed (blank, required) → UPI total check (4) → "Close the day…" (5) → confirm (6). It asks for more input but takes fewer page changes, and it cannot pass without someone checking.

---

### 3. Inconsistent patterns

| Pattern | Where | Make it |
|---|---|---|
| Default payment mode: Cash (check-in `:415`, Collect `:194`, NextForYou `:236`) vs UPI (Take payment `takePayment.tsx:91`) | money | No default: the mode buttons are the submit |
| Confirm before destructive actions: yes for bulk left/no-show (`:71`) and decline (`:623`); no for single Left (`:170`), No-show (`:181`), Collect (`:194`), Refund (`:326`), Close the day (`endOfDay:52`), package remove | safety | Confirm, or Undo toast, for every irreversible or money action |
| Dialog confirm labels: explicit ("Mark no-show", "Allow and check in", "Close visit") vs generic "Save" (invoices `:28`) / "OK" (ask default) | dialogs | Always verb + object + amount |
| Same action, different words: "Send in" vs "Patient is here" for reports (`journey:164`); "Plan" vs "Schedule" (`:646`); "Record" (drawer `:253`) vs "Profile" (⋯ `:170`) vs "Open record" (`:199`) | labels | One word each |
| Patient detail: drawer (journey), page (`/patients/:id`), schedule chip → profile for other days (`schedule:82`), sitting → `/worklist` | navigation | Drawer first, everywhere on the board |
| Waive: free-text reason min 1 (check-in) vs reasons min 3 (`billing.ts:346`) | validation | min 3 + picker everywhere |
| Idempotency: per-sheet key (TakePayment `:92`) vs per-call `uuid()` (check-in `:452`, Collect `:87`, backIn `:80`) | network safety | Per-intent key |
| Errors: inline amber `blocker` (check-in), toast (most), raw code (routine `:61`) | feedback | Inline for form errors, sticky toast for action errors, never raw codes |
| Stage names (see 1.1-5) | vocabulary | §4 list |
| Left vs no-show drawn the same in Schedule (`FrontDesk.tsx:231`) | status | Separate kinds |

---

### 4. Jargon and microcopy (current → plain)

| Where | Current | Proposed |
|---|---|---|
| tile `:217` | "For you now" | "Next for me" |
| tile `:217` | "Initial screening" / chip "with junior" `:164` | "With junior doctor" (one term) |
| tile `:217` | "Pending tests" / group "Pending tests & procedures" | "Tests & procedures to book" |
| tile `:217` | "Reports awaited" / "Reports pending" / "Awaiting reports" | "Waiting for reports" |
| tile `:217` | "Done" / "Completed · newest first" | "Finished" |
| tile `:217` | "Still to arrive" / "Not yet arrived" / "Booked, not arrived" / "Booked, not here yet" | "Not here yet" |
| banner `:212` | "Sent" | "OK, sending them in" |
| row `:195` | "Explained" / "Mark as explained" | "Told the patient the plan" |
| row `:221` | Select → "Done" | "Cancel selection" |
| toast `:60` | "Updated" | "Arjun marked no-show · Undo" |
| toast `:87` | "Collected" | "₹500 cash from Meena · Undo · Receipt" |
| step 1 `:480` | placeholder "98765…" | "Phone, name or P-number" |
| check-in `:518` | "Location today" | "Area / town" |
| check-in `:525` | "About the patient" hint "Asked once, on the first visit; the doctor sees it on every visit." | "First visit only: age, sex, address" |
| check-in `:558` | "Why they came" hint "Each complaint opens its checklist for the doctors." | "Main problem (optional)" |
| check-in `:578` | "token on check-in" | "Token number comes after check-in" |
| check-in `:598` | "Waive the fee" | "No fee for this visit…" |
| check-in `:594` | placeholder "Why? (known person, doctor said…)" | reason picker: Staff/family · Doctor said · Hardship · Other |
| checkout `:646` | "Plan" / "Schedule" | "Book sittings" |
| checkout `:647` | "Slip given" | "Lab slip given" |
| checkout `:640` | "Do later" | "Not now" |
| checkout `:649` | "carries on in Awaiting reports, it does not hold up closing" | "Tracked under Waiting for reports" |
| checkout `:650` | chip "hand-off" | "Payments" |
| reports `:683` | "· partial" | "(2 of 3 reports in)" |
| journey `:222` | "2th in line" | "2nd in line" |
| filmstrip `:114` | "← → step · Enter sends in" | (keep, but make Enter local) |
| take payment `:113` | "Ref, last 4 digits" | "UPI ref, last 4 of UTR (optional)" |
| EMI `:134-138` | "EMI awaiting settlement", "Bank credit arrived", "Match the bank credit", "Matched" | "Lender still to pay", "Lender has paid", "Lender's payment", "Save" |
| invoices `:28` | confirm "Save" | "Refund ₹500" / "Cancel invoice" / "Give ₹100 off" |
| invoices `:52` | "Leave out of tax reports" | "Exclude from GST report (owner)" |
| receipt `:16` | "Receipt R-0042" | "Receipt / Tax invoice No. R-0042" |
| end of day `:45` | "Against the doctor's diary" | "Check against the paper register" |
| end of day `:54` | "Closing the day needs the Close the day permission." | "Ask the owner or admin to close the day." |
| change day `:81` | "Change my day" / "I'll leave at" | "Change Dr Rao's day" / "Leaves at" |
| change day `:11` | "Front desk and online booking can fill it" | "The front desk can book into it" |
| routine `:66` | "every day's OP windows are made from this" | "Booking slots for every day come from this" |
| screening `:41` | "All the rest: No" | "Mark remaining 6 as No" |
| schedule `:125` | "3 of 7" | "3 of 7 booked" |

Language: every string is hard-coded English; there is no i18n layer at all (grep shows only a CSV BOM comment mentioning Telugu/Hindi, `FrontDesk.tsx:29`). For mixed-literacy staff, give at least the stage names, the main buttons and the receipt a second language (Hindi/Telugu), chosen per user.

---

### 5. Top issues (ranked)

1. **Critical: one-tap "Collect"** records cash with no mode choice, no confirm, double-tap = double payment, and the server does not check the amount due (`FrontDesk.tsx:87,194,236`; `billing.ts:255-273`).
2. **Critical: check-in amount has no bounds** (overpay accepted silently, underpay silently left due), and **check-in payments skip the day lock** (`FrontDesk.tsx:468,591`; `visits.ts:50,60-124`).
3. **Critical: refunds move no money.** A charge status flip with no money-out row; End of day ignores it; the History "Refund" is one tap with no confirm (`FrontDesk.tsx:283,326`; `billing.ts:276-284`; `dayclose.ts:27-31`).
4. **Critical: duplicate-patient guard is exact name+phone only** and results hide last visit; split records split allergy history (`patients.ts:203-207`; `FrontDesk.tsx:482-485`).
5. **High: no search on the board, 13 header controls, no offline/error state.** The receptionist cannot find a patient or trust the screen (`FrontDesk.tsx:54,213,217-221,41`).

Also high: modal backdrop/Esc wipes the check-in form; waive by one character; no receipt at check-in; the receipt's "Received by" is wrong and it is not a GST invoice; a global Enter sends the selected patient in; "Left" and "Change doctor" act with no confirm or choice; Close the day has no confirm and the receptionist cannot do it; "All the rest: No" in screening.

---

### 6. Could not inspect / limits

- Not run in a browser: contrast on glass backgrounds, real touch-target sizes, tablet breakpoints, print output and timing are judged from code only.
- Out of scope files reached from the desk, not read: `pages/Booking.tsx` (`BookForm`, `NewBooking`), `apptDrawer.tsx` (`AppointmentDrawer`), `pages/Worklist.tsx` (`ScheduleModal`), `courses.tsx` (`CourseDialog`), `printPreview.tsx` (Rx print), `flags.tsx`, `chime.ts`, `templates.ts`, `palette.tsx` beyond `createActions`, `pages/Patients.tsx` beyond the import lines.
- `src/modules/rxpad.ts` `Vitals` (server vital ranges) not read; I relied on the comment in `vitals.tsx:15`.
- Whether charge amounts include GST, whether existing bookings survive a routine change, and where the reception monitor faces are **ASSUMPTIONS**.
- The `/orders` endpoint (Reports awaited data) and its permission were not read.
- No offline/service-worker code was found (grep for `offline`/`navigator.onLine` returned nothing in `web/src`).


---

<a id="appendix-C"></a>
# Appendix C — Doctor and junior doctor

## UX + safety audit: doctor and junior-doctor surfaces (Cubott OPD)

Scope read in full: `web/src/pages/Today.tsx`, `web/src/pages/Encounter.tsx` (993 lines), `encounterDetail.tsx`, `rxLine.ts`, `historyChips.tsx`, `skinmap.tsx`, `labs.tsx`, `templates.ts`, `vitals.tsx`, `pages/PrintRx.tsx`, `printPreview.tsx`, `flags.tsx`; server `src/modules/clinical.ts`, `rxpad.ts`, `orders.ts` (review/inform/split), `templates.ts` (routes), `src/lib/history.ts`, `src/lib/pad.ts`; plus `pharmacy.ts:16-27` (quantity) and `api.ts` (query defaults, `errText`).
Partly read: `photos.tsx` (consent, capture, remove). Not inspected: `screening.tsx` (junior's ScreenBlock/ScreeningCard), `dayChange.tsx` (Change my day modal), `viewer.tsx`, `ui.tsx` beyond `ask`/`toast`/`NumInput`. Nothing was run in a browser; every finding is from code. Inferences are marked **ASSUMPTION**.

Line numbers are per file. Roles: **D** = doctor (and owner, who has `*`), **J** = junior doctor (`assistant`, `encounter.intake` only).

---

### 0. Patient-safety summary (read this first)

| # | Finding | Where | Sev |
|---|---|---|---|
| S1 | Allergy check is a 3-class word list matched on the **typed name**. Brand names (Augmentin, Amoxyclav, Moxclav), cephalosporins, tetracyclines (doxy/mino, derm staples) and local anaesthetics are never flagged although they are offered as allergy chips. `"amoxyclav"` does not contain `"amoxi"`. | `Encounter.tsx:37-46`, chips `history.ts:11` | Critical |
| S2 | The pad then **tells the doctor it is safe**: `"{allergy} allergy checked: no clash found."` after a template load. | `Encounter.tsx:562` | Critical |
| S3 | Allergy hit never blocks or asks for acknowledgement; Finish goes straight through. In **Review** layout the medicines table is not on screen and the "Leaves with" aside shows no allergy warning; the banner at `:598` only renders in Stacked (`inline &&`). | `:487-491`, `:598`, `:857-864` | Critical |
| S4 | No drug–drug interaction, no same-molecule/duplicate check. `addRx` (type bar, search pick) does not dedupe at all; only `addRxMany` dedupes by exact name. Isotretinoin + doxycycline/minocycline (both seeded, `seed.ts:43-44`) passes silently. | `:408`, `:358` | Critical |
| S5 | Pregnancy / breastfeeding exist only as chips inside "Existing" history (`history.ts:8`); never shown in the header, never checked against isotretinoin (seeded, teratogenic) or other drugs. No LMP / "could be pregnant?" prompt for women 12-50 on Schedule X/H1/teratogens. | `:797-803` | Critical |
| S6 | Empty Dose/Frequency/Days cells show grey placeholders that read as values (`"1 tab"`, `"1-0-1"`, `"after food"`, `"days"`). Finish does not check that a medicine line has frequency and duration, so a line prints as a bare name. | `:582-587`, `missingNow :478-486` | Critical |
| S7 | Quantity is computed from the first number in the Dose text: dose `"500 mg"` × `1-0-1` × 7 d = **7000** on the pad (`rxLine.ts:34`) and 500× packs at the pharmacy (`pharmacy.ts:24`), which pre-fills the bill with `min(left, onHand)` — i.e. the whole shelf. The doctor's own Qty edit is ignored by the pharmacy (it recomputes). | `rxLine.ts:31-36`, `pharmacy.ts:16-26`, `Pharmacy.tsx:64` | Critical (billing) |
| S8 | **Preview prints a draft that looks identical to a final prescription** (same header, date, Signature line, no "DRAFT"). `/encounters/:id/print` has no status check and is open to `visit.read` (reception). | `PrintRx.tsx:24,69`, `clinical.ts:209` | Critical |
| S9 | Stale print: Preview fires `save.mutate` and `openPrint` in the same tick (`:933`, `:950`), so the preview can render pre-save data; after Finish nothing invalidates `['print', id]` and the global `staleTime` is 10 s (`api.ts:3`), so Finish within 10 s of a Preview prints the cached old version. **ASSUMPTION** on network timing; cache behaviour is factual. | `:323-324`, `PrintRx.tsx:13` | Critical |
| S10 | Telugu-only print mode (`lang: 'te'`) drops every frequency/timing/instruction that has no table entry: English line hidden (`en` false) and no fallback. `"1-0-0-1"`, `"SOS"` typed as `"sos"` works but `"apply at night on face"` vanishes. | `PrintRx.tsx:36,60-61` | Critical (when that setting is on) |
| S11 | Infant age is hidden everywhere: `p.ageYears ? …` treats 0 as missing (pad header `:792`, print `PrintRx.tsx:45`, Today `:146,:154`). No weight requirement, no mg/kg, no paediatric flag. | — | High |
| S12 | Junior's **autosave marks the visit "screened" every 15 s** (server sets `screened` on any intake-only PATCH, not only on "Save intake"). The doctor's Today then lists the patient as screened and `POST /visits/:id/encounter` no longer returns `WITH_JUNIOR`, so doctor and junior can edit the same draft; each save deletes and re-inserts all medicines (`clinical.ts:127-128`), last write wins. | `clinical.ts:160-162`, `Encounter.tsx:343` | High |
| S13 | No amendment path after Finish: `ALREADY_COMPLETED` (`clinical.ts:91`) and the pad goes read-only. A wrong dose found 2 minutes later cannot be corrected and reprinted with an audit reason. | — | High |
| S14 | "Auto" section templates add medicines/tests silently when a complaint or diagnosis matches (`:373-378`); the only trace is an amber line. | — | High |
| S15 | Free-text medicine line picks the best partial match with no confirmation (`rxLine.ts:13-16`): any medicine whose name contains one typed word wins. | — | High |
| S16 | `<Route path="/encounter/:id" element={<Encounter />}>` has no `key`; state (`data`, `rx`, `recs`, `loaded`) would survive a direct A→B navigation and autosave A's content into B. No in-app path does this today (**ASSUMPTION** checked: only Today/FrontDesk navigate in, both from outside the route). Latent wrong-patient bug. | `main.tsx:52`, `Encounter.tsx:301-316` | High (latent) |

---

### 1. Inventory of surfaces (38)

| # | Surface | File:line | Roles | Reached by |
|---|---|---|---|---|
| 1 | Today page | `Today.tsx:26-236` | D (needs `encounter.complete`; `App.tsx:20,40`) | Landing for doctors |
| 2 | Today loading skeleton | `Today.tsx:63` | D | First load |
| 3 | Next / In your room card | `Today.tsx:139-160` | D | Today |
| 4 | Stat tiles (Booked, Waiting, With you, Reports) | `Today.tsx:176-183` | D | Today |
| 5 | Your day timeline + legend + NowLine | `Today.tsx:209-231,239` | D | Today |
| 6 | Before you leave list | `Today.tsx:191-201` | D (+owner security rows) | Today |
| 7 | Tomorrow card | `Today.tsx:202-206` | D | Today |
| 8 | Day-change buttons (desktop + phone grid) | `Today.tsx:168-173,189-190` | D with practitionerId | Today → ChangeMyDay modal (not inspected) |
| 9 | "Sent in" chime + alert row | `Today.tsx:57-61,143-148` | D | Reception sends a patient in |
| 10 | Pad loading skeleton | `Encounter.tsx:392` | D, J | Open / Continue |
| 11 | Patient header in top bar (name, flags, line, allergy chip, layout switch, Templates, gear) | `Encounter.tsx:797-826` | D, J (J sees chip "Intake · doctor reviews next") | Pad |
| 12 | Whole-pad Templates popover | `Encounter.tsx:805-822` | D | Header "Templates" |
| 13 | Handle-carefully banner | `flags.tsx:21-24` via `Encounter.tsx:827` | D, J | Flagged patient |
| 14 | Tabs Rxpad / Past visits / Photos / Reports | `Encounter.tsx:829-832` | D | Pad |
| 15 | Type-anything bar + "not in the lists" chooser | `Encounter.tsx:836-842` | D (Stacked) | Pad |
| 16 | Toolbar: scoped search, Load previous, section Templates, Clear | `Encounter.tsx:761-775` | D (Focused/Review) | Pad |
| 17 | Held-for-reports banner | `Encounter.tsx:844` | D, J | Patient back with reports |
| 18 | Template/Load-previous note | `Encounter.tsx:845` | D | After auto/section template or Load previous |
| 19 | Junior screening block | `Encounter.tsx:847` (`screening.tsx`, not inspected) | J | Intake |
| 20 | Vitals card + Past values popover | `vitals.tsx:36-75` | D, J | Pad |
| 21 | Medical history chips + category editor | `historyChips.tsx:13-53` | D, J | Pad |
| 22 | Symptoms card | `Encounter.tsx:533-548` | D, J | Pad |
| 23 | Diagnosis card + "Filled from" banner | `Encounter.tsx:549-563` | D, J (J: "the doctor decides; leave it if unsure") | Pad |
| 24 | Examination card + small map + Pins line + "More" popover | `Encounter.tsx:564-569,162-176,976-983` | D, J | Pad |
| 25 | Skin map modal (propose pin, pin detail) | `Encounter.tsx:957`, `skinmap.tsx:75-159` | D, J | Tap small map / Pins |
| 26 | Medications table + Combo dropdowns + allergy banner + leaflet line | `Encounter.tsx:570-599,235-254` | D | Pad |
| 27 | Advice card | `Encounter.tsx:600-604` | D | Pad |
| 28 | Lab investigations card | `Encounter.tsx:605-615` | D | Pad |
| 29 | Lab results card + Add lab values modal + history popover | `labs.tsx:79-119` | D | Pad |
| 30 | Follow-up ("Review in") | `Encounter.tsx:511-516,617` | D | Pad |
| 31 | Procedures, Private notes, Referral, Photos, custom sections | `Encounter.tsx:618-654` | D (Photos card: J) | Pad |
| 32 | Review card (Since <date>) + Review layout + "Leaves with" aside | `Encounter.tsx:656-676,850-865` | D, review visits | Layout "Review" |
| 33 | Focused layout (section nav, fold rows, "+ section" chips) | `Encounter.tsx:866-889` | D | Layout "Focused" |
| 34 | Section popovers: SectionTemplates, LoadPrevious, SearchLine list, ask() dialogs (save template, clear) | `Encounter.tsx:85-124,202-231,380-389,418-421,495` | D | Card headers / toolbar |
| 35 | Bottom action bar (Stacked, sticky) / in-page bar (Focused/Review) incl. "Cannot finish yet" chips | `Encounter.tsx:922-955` | D, J | Pad |
| 36 | Past visits tab + Previous consultation modal | `Encounter.tsx:897-908`, `encounterDetail.tsx:21-62` | D | Tab |
| 37 | Reports tab / Photos tab / PhotoCapture / consent / compare / remove | `Encounter.tsx:909-918`, `photos.tsx:36-48,51-148,225-229` | D (J via Photos card) | Tabs |
| 38 | Print preview modal + PrintRx (A5) + `/print/:id` + results sheet | `printPreview.tsx:13-34`, `PrintRx.tsx:9-73` | D (and reception via `visit.read`) | Preview, Finish, Print Rx |

Toasts on the pad (all transient, 3.2 s, `ui.tsx:386-389`): `"Consultation completed"`, `"Prescription issued · held open for the reports"`, `"Kept open for the rest of the reports"`, `"Intake saved · ready for the doctor"`, `"Please fill in: …"`, `"Cannot finish yet: …"`, `"There is nothing to save yet: no medicines."`, `"Saved as a template"`, `"Saved. The owner approves it before it is suggested."`, `"Saved as template “X”"`, `"“X” is not in the findings list."`, `"Pinned <area>"` (with Undo), plus every `errText` (e.g. `"Could not reach the server. Check the connection and try again."`).

---

### 2. Screen-by-screen findings

#### 2.1 Today (`Today.tsx`) — D

Purpose: who is with me, who is next, what is left today.

| Sev | Issue | Cognitive-load reason | Fix |
|---|---|---|---|
| High | No error state: `if (!d || !c) return <Skeleton…/>` (`:63`). If `/frontdesk` or `/calendar` fails (patchy internet), the doctor sees a grey skeleton for ever with no "offline" message and no way to reach the patient in the room. | Doctor cannot tell "loading" from "broken". | Show last good data with a "Not updated since 10:42 · retrying" strip; keep the In-your-room card from cache. |
| High | Up to 3 patients "In your room" (`:142`, "· 2 of 3") each with Open/Continue. With two pads half-filled, wrong-patient entry is likely (S16 makes it worse). | Three equal buttons, names only. | One patient per pad; show the others as "Waiting inside" without a Continue button unless the current pad is finished or explicitly parked. |
| Medium | `"Change my day"` calls `quick('early')` (`:172`) — same as "Leave early". Bug. | Button says one thing, opens another. | `quick('late')` or open the chooser with no kind. |
| Medium | Polling: `/frontdesk` every 5 s, calendar/orders/procedures every 30 s, security 60 s (`:32-41`) on a low-end shared device on mobile data. | — | 15-30 s with push/refetch-on-focus; pause when the tab is hidden. |
| Medium | Header is decorative: 34 px animated greeting letter-by-letter (`:165,244`), sentence of 6 numbers (`:166`), then 4 tiles repeating the same numbers (`:176-183`). "Booked" sub `"12 last Monday"` is irrelevant mid-clinic. | Same counts twice; >5 s to find "who's next". | Drop greeting animation and the sentence; one row: `With you · Next · Waiting n · Reports n`. |
| Medium | Only the Reports tile is clickable (`:182`); the other three look identical but do nothing. | Inconsistent affordance. | Make Waiting open the queue, With you open the pad; or style Reports as a button. |
| Medium | Timeline pills open the **patient record**, even the "· with you" pill (`:222`), not the pad. | Clicking the patient you are seeing takes you away from the consult. | "with you"/"waiting" pills open the pad; others the record. |
| Medium | Pill labels are long concatenations: `"Name · screened · 12 min · back with reports · walk-in"` (`:71,91`). Legend chips (`:211`) look like buttons. Footnote needed to explain the screen (`:230` `"Times are booking windows, not exact minutes."`). | Reading, not scanning. | Name + one status chip + one icon for walk-in/reports. Remove the legend by colouring only the status chip. |
| Medium | "Before you leave" mixes clinical work (reports, unfinished notes) with admin (follow-ups overdue for reception, IP-lock sign-in alerts for owners `:199`). | Doctor triages non-doctor items. | Split: "Your work" (reports, unfinished notes, plans to approve) vs "For the desk". |
| Low | `"note unfinished"` / `"note not finished"` / Attn tag `"note"` / action `"Finish"` — three wordings for one state. | — | "Rx not finished" everywhere. |
| Low | Age hidden when 0 (S11), sex printed raw (`:146,154`). | — | `ageLabel()` helper: `"8 mo F"`. |
| Low | `Open` on Next has a long hover title (`:156`) — not visible on tablet. | Hover-only help. | Remove; behaviour should be obvious. |

#### 2.2 Pad header and patient identity (`Encounter.tsx:792-826`) — D, J

Purpose: who is this, any allergy, which layout.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| Critical | Pregnancy/breastfeeding never shown here (S5). | Doctor must open History chips to know. | Fixed red/amber chips beside the allergy chip: `Pregnant`, `Breastfeeding`, `Child 8 mo · 9 kg`. |
| High | Allergy chip shows only if text exists (`:802`). "Not asked" and "No known allergies" both show nothing. `historyChips.tsx:36` shows "none" at 70 % opacity inside a lower card. | Absence of a chip is ambiguous. | Always show one chip: `Allergy: Sulfa` (red) / `No known allergy` (grey, with date) / `Allergy not asked` (amber, tap to ask). Make "not asked" block Finish when medicines are present. |
| High | Patient line is one truncated grey string of 6 parts (`:792`): age sex · ID · phone · "visit 3" · "review of …" · "screened: …". On a tablet the layout switch + Templates + gear squeeze it (`truncate`). | Identity details lost to truncation. | Line 1: **Name, 34 F, ID 1043**. Line 2 only on wide screens. Move phone out (privacy on shared screen). |
| Medium | Layout switch `Stacked / Focused / Review` (`:804`) on every pad; persisted per browser (`localStorage`, `:284`) — on a shared device the next doctor inherits it. | Three modes = three mental models of one form. | Pick one default per visit type (Review for follow-ups, Stacked for new); hide the switch in a menu. |
| Medium | Gear "Configure pad" (`:823`) **and** "Print settings" on the bottom bar (`:930`) both go to `/settings?tab=pad` — duplicate page actions (against the project rule). | — | Keep one, in the overflow menu. |
| Low | `"Intake · doctor reviews next"` chip shown only when `me.role === 'assistant'` (`:803`) — a user with both roles never sees it. | — | Base on `!isDoctor`. |

#### 2.3 Medications table (`Encounter.tsx:570-599`) — D

Purpose: write the prescription.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| Critical | S1, S3, S4, S6, S7 above. Allergy hit is shown only as a rose row tint and a truncated Stock-column text `"allergy: sulfa"` (`:588`). | Safety signal sits in the inventory column. | Inline red bar under the row: `Sulfa allergy (rash, 2024). Cotrimoxazole contains sulfa.` with `Remove` / `Prescribe anyway — reason`; Finish asks again. Move check server-side (`clinical.ts` PATCH complete) against a molecule/class table on `medicine` (add `generic`, `class` columns). |
| Critical | Placeholders that look like data (`placeholder="1 tab"`, `"1-0-1"`, `"after food"`, `"days"`, `"qty"`, `"if any"`) on `cell-in` inputs that "read as text until you are in them" (`:582-587`). | Empty looks filled. | Empty cells show a red dash `—` and a dashed outline; Finish requires frequency + days (or "SOS"/"as directed" chosen explicitly) for every line. |
| High | Choosing a name in the Combo **overwrites** dose/frequency/days/instructions with defaults (`:581`), even when the doctor only corrected a spelling. | Silent loss of edits. | Only fill empty fields; or ask "Use this medicine's usual dose?" |
| High | No dose sanity: Dose is free text, Frequency free text (Combo accepts anything), Days 0-365 client (`NumInput max=365`), server `durationDays: z.number().int()` with no min (`clinical.ts:15`). | — | Server: `durationDays` 1-365, frequency from a closed list or a parsed grid; flag doses above a per-medicine max (`medicine.defaults.maxDose`). |
| High | Topical items print `"1-0-1"` (and Telugu `"ఉదయం 1, రాత్రి 1"` = "morning 1, night 1") for creams (`FREQ :27`, `pad.ts TE`). | A patient reads "1" as a tablet. | When `medicine.form` is cream/gel/lotion, the frequency list becomes "apply morning / night / twice daily" with matching Telugu. |
| Medium | Table `min-w-[760px]` (`:573`) inside a card: on a 768 px portrait tablet it scrolls sideways and the remove × is off screen. Touch targets 28 px (`!h-7 !w-7`). | — | Below 900 px render each medicine as a 2-line card (name/strength; dose · freq · days · timing chips). 44 px targets. |
| Medium | Seed default frequency `"once daily after food"` (`seed.ts:43`) plus a separate Timing column → print shows "after food" twice or contradicts ("with food" vs "after food"). | — | Frequency and timing as separate fields everywhere, including medicine defaults. |
| Medium | Header says **"Medications"** (`:570`); everything else says Medicines (`"Medicines is required"`, toolbar, settings `pad.ts`). | — | "Medicines". |
| Medium | Stock column `"not in list"` (`:588`) for free-typed names — reads like an error; and the doctor's Qty is ignored by the pharmacy (S7). | — | Drop Qty from the pad (pharmacy owns it) or send it and use it. Show "not stocked here" only if the clinic has a pharmacy. |
| Low | `"Frequently prescribed"` chips and `"Repeat last Rx"` (`:594`) — Repeat appears only when the visit is not a review (`!isReview`), i.e. it is hidden exactly on follow-ups where it would be used… because Review card has Continue all. Two names for one action. | — | One action name: "Same as last visit". |

**Ideal redesign (medicine row + safety):**
```
┌ Medicines ─────────────────────────────────────── 3 ┐
│ 1  Doxycycline 100 mg cap   1 cap  1-0-0  after food  28 d │
│ 2  Isotretinoin 20 mg cap   1 cap  0-0-1  with food   30 d │
│    ⚠ Doxycycline + isotretinoin: raised brain pressure.     │
│      [Remove one]  [Keep both · reason ▾]                  │
│    ⚠ Woman 24 y: pregnancy status not recorded. [Ask now] │
│ 3  Clobetasol 0.05% cream   apply  — at night —  14 d      │
│ + type a medicine…  (Enter shows the match; Enter again adds)│
└──────────────────────────────────────────────────────────┘
```

#### 2.4 Type-anything bar / scoped search / free-text parser (`:836-842`, `:129-158`, `rxLine.ts`) — D

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | S15: `parseRxLine` chooses the best partial name match silently; `"keto cream"` becomes whichever name contains "keto"/"cream" first; free text that matches nothing becomes a medicine named with the leftover string (`rxLine.ts:18`, `name: rest.trim()`). | Doctor must re-read the table to see what was filed. | Show a preview chip under the bar: `→ Ketoconazole 2% cream · 1-0-1 · 7 d   Enter to add`; ambiguous → list of 3. |
| Medium | Three search entry points on Stacked: top type bar (`:839`), each card's SearchLine (`:543,558,595,603,613`), plus quick-add chips. Placeholders are long examples: `'Type anything · medicines, symptoms, diagnosis, tests · “itra 100 1-0-1 7d”, “itching 2 weeks”, “KOH mount”'`. | Which box do I use? | One bar, scoped by the card that has focus; placeholder `Add medicine, test, symptom…`. |
| Medium | `"“X” is not in the lists. Add as  Symptom Diagnosis Medicine Test Advice Cancel"` (`:841`) — a typo becomes a "medicine" with no medicineId, no stock, no allergy class. | — | For Medicine, require choosing from the list or "Add as outside medicine" (marked on the print as brand-as-written). |
| Low | `"Enter to fill"` kbd hint (`:840`), `"↑↓ to pick · Enter adds · not in the list? Enter adds it as typed"` (`:154`). | Jargon/keyboard-only. | "Enter adds". |

#### 2.5 Diagnosis, Symptoms, Examination, Skin map — D, J

| Sev | Issue | Fix |
|---|---|---|
| Medium | Junior can type a diagnosis (`:549`, meta `"the doctor decides; leave it if unsure"`); it lands on the doctor's pad unmarked. Review visits also carry the old diagnosis forward automatically (`:310`). The doctor can finish without ever touching Diagnosis. | Show "added by junior" / "from 12 Oct" chip until the doctor confirms (tap = confirm). |
| Medium | Severity and Provisional/Confirmed as two Segmented controls on every row (`:553-554`) — 5 extra targets per diagnosis, 28 px tall. | Fold into a single "Mild ▾" menu. |
| Medium | Examination mixes small body map, Pins line, compact lists with "More (n)" popovers and a "+ findings" textarea link (`:566-568,985`). | Map collapsed by default for review visits; one findings search. |
| Medium | Skin map pin **Remove** is immediate, no confirm, no undo (`skinmap.tsx:129`) — a pin is a clinical record across visits. | Undo toast as for Add, or soft-delete. |
| Low | Card title "Examination findings", section label "Examination", template logo "T O/E", toolbar "findings", print "O/e:". | One word: "Examination". |

#### 2.6 Templates and Load previous (`:85-106`, `:202-228`, `:805-822`, `:380-421`) — D

Purpose: reuse earlier work.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | S14: "auto" sets apply themselves (`:373-378`) and add medicines/tests the doctor did not pick; note at `:845` is an amber sentence like `"Acne set: added 3."` | Silent change to the Rx. | Never auto-add medicines; show a suggestion chip "Acne set (3 medicines) — Add". |
| High | Whole-pad template **replaces** the pad (`applyTpl :410-416`, `setRx(t.prescription…)`), keeping only symptoms and review answers; undo is a small underlined "Clear loaded" link. | Destructive one-tap. | Merge by default; "Replace" as an explicit option. |
| Medium | Two template systems with different save rules: whole-pad (`/rx-templates`, saved instantly, header "Templates", bottom "Save template") vs section sets (`/templates`, "T Sx/T Dx/T O/E/T Rx/T Adv/T Lab" logos, card "Save", lands as owner-approval draft `"Saved. The owner approves it before it is suggested."`). Plus "Load previous" per card and in the toolbar. Each card header carries 4 ghost buttons (`cardActs :528-529`): Load previous, T-logo, Save, Clear. | 6 cards × 4 tiny buttons = 24 near-identical controls. | One "Reuse" menu per card: *From last visit · My sets · Save as set*. Clear only via the × on rows. |
| Medium | T-logo buttons are `aria-hidden` glyphs `T` + `Sx` (`:82`); meaning only in `title` (hover). | Unreadable on tablet. | Text "Sets". |
| Low | `"Anything already on the pad is kept once."` (`:223`), `"Loaded from 12 Oct. Anything already on the pad was kept once."` (`:429`). | "Nothing is duplicated." |

#### 2.7 Review card / Review layout (`:656-676`, `:850-865`) — D, review visits

| Sev | Issue | Fix |
|---|---|---|
| Critical | No allergy/interaction/pregnancy signal anywhere in this layout (S3). "Continue all" (`:665`, also Alt+C) re-prescribes everything in one tap. | Same safety bar as 2.3 inside "Leaves with"; Continue all re-runs checks and shows hits. |
| Medium | Per-line segmented `Continue / Change / Stop` pre-selects **Stop** for every old line as soon as any medicine is on the pad (`:667`, `st = !cur ? (rx.length ? 'stop' : '')`), e.g. after an auto set. | Unknown state until the doctor chooses; count "2 of 3 decided". |
| Medium | Review layout hides the Medicines editor; "Change" jumps to a peek view (`goTo('medicines')` → `setPeek(true)`), "Back to the review" button to return. | Inline edit of days/dose in the review row. |
| Low | `"How is it?"`, `"Side effects … none reported · Change"` — fine; `"Review again"` card title vs "Follow-up" elsewhere. | "Next visit". |

#### 2.8 Follow-up (`:511-516`) — D

| Sev | Issue | Fix |
|---|---|---|
| High | No way to choose a custom interval or a date: chips `7d 14d 1 m 3 m none`; the days box appears only when the saved interval is already off-list (`:514`), which cannot happen from the UI. No calendar date or weekday shown, so a review landing on Sunday/holiday is not seen. | Chips + "Other…" date picker; show `→ Mon 24 Nov` beside the chip; warn if the clinic is closed that day. |
| Medium | Print reads `"Review on 2026-11-24"` (ISO, `PrintRx.tsx:67`), not translated although `TE.review` exists (`pad.ts`). | `24 Nov 2026 (Mon)` + Telugu line. |

#### 2.9 Lab investigations / Lab results (`:605-616`, `labs.tsx`) — D

| Sev | Issue | Fix |
|---|---|---|
| Medium | Quick add shows the first 8 of a fixed list (`TESTS :29`) — KOH mount, the commonest derm test, is 11th and needs typing. | Order quick chips by the doctor's frequency (as medicines do). |
| Medium | A lab value is corrected inline on blur (`labs.tsx:103`) with no confirm and the server PATCH writes no audit event (`rxpad.ts:80-89`). A tap-away saves an accidental edit to a shared result. | Explicit Save; emit `lab_result.corrected` with old/new. |
| Low | Titles: "Lab investigations" (card), "Tests" (settings, toolbar), "Investigations" (print), "T Lab". | "Tests". |
| Low | `"Print only out-of-range"` checkbox default on (`pad.ts` printSettings) sits in the results card header — a print setting in a clinical card. | Move to Preview. |

#### 2.10 Bottom action bar, Finish, autosave (`:318-345`, `:487-491`, `:922-955`) — D, J

Purpose: save, preview, finish.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| Critical | S8/S9 (draft print, stale print). | — | See redesign below. |
| High | **Finish has no review step**: one click (or Ctrl+Enter in Focused/Review, `:749`) completes, sends WhatsApp (`queueRxMessage`), opens print, navigates to Today. With allergy hits present. | Irreversible action, no summary. | Finish opens a sign-off sheet (below). |
| High | S13: no amend after completion. | — | "Amend" on a completed Rx: reason required, new version, old print marked "superseded", audit event. |
| High | Autosave failure is invisible: `savedAt` only updates on success, so the bar keeps saying `"Saved 10:42"` (`:926`) while every 15 s a 3-second toast says "Could not reach the server…". No local copy (no IndexedDB/localStorage draft), no `beforeunload` guard. Closing the tab or a browser crash loses everything since the last good save. | Doctor believes it is saved. | Persistent state pill: `Saved 10:42` / `Saving…` / `Not saved — offline, kept on this device`. Write the draft to IndexedDB on every change; replay on reconnect; `beforeunload` when dirty. |
| High | Dirty-flag race: edits typed while a save is in flight are marked clean when that save returns (`onSuccess` sets `dirty.current = false`, `:321`), so they are not autosaved until the next change. On a slow link this is seconds of typing. | — | Track a revision counter; clear dirty only if the saved revision equals the current one. |
| High | S12: junior's autosave flips the visit to "screened". | — | Server: only the explicit `back: true` hand-off sets `screened`; add an `If-Match`/version on PATCH. |
| Medium | Stacked bar for an owner-doctor has 6 buttons: Clear, Print settings, Save, Save template, Preview, Finish (`:923-935`); "Clear" (whole pad) is first on the left beside the status. | Destructive control in the most-clicked corner. | Left: status. Right: Preview, **Finish & print**. Rest in "⋯". |
| Medium | Two status texts for one behaviour: `"Autosaves every 15 s"` (`:926`) vs `"Saves as you go"` (`:944`); shortcuts line `"Alt ↑↓ section · / search · Alt L previous · Alt T templates · Ctrl ↵ finish"` (`:945`) is keyboard-only and invisible on tablets. | — | One status pill; shortcuts in Help. |
| Medium | Mixed save models on one screen: vitals, history chips, pins, photos, lab values save immediately on their own endpoints; the rest autosaves every 15 s; "Save" button also exists. | "Is this saved?" per card. | Everything goes through the same pill; per-card "saved ✓" tick for the instant ones. |
| Medium | `"Finish · hold for reports"` / `"Complete"` / `"Keep open for the rest"` / `"Finish prescription"` — four labels for the primary button depending on state (`:935`). | — | Always "Finish & print"; a line above explains "Tests pending: the visit stays open for reports." |
| Medium | Missing-fields chips `"Cannot finish yet · missing: Diagnosis"` only after Finish is tried (`showMissing`). | Surprise at the end. | Show required stars with a quiet count from the start: "1 thing left: Diagnosis". |
| Low | J's button `"Save intake & return to queue"` — "intake" is jargon; J lands on Front desk queue. | "Done — send to doctor". |

**Ideal redesign — Finish & sign sheet (modal, one screen):**
```
┌ Finish prescription · Priya Sharma · 24 F · ID 1043 ────────┐
│ ⚠ 1 check needs you                                         │
│   Isotretinoin: pregnancy status not recorded  [Not pregnant]│
│                                                [Pregnant]    │
│ Allergy: Sulfa · no clash (checked by molecule)             │
│ Dx  Acne vulgaris, moderate                                 │
│ Rx  1 Doxycycline 100 mg   1-0-0 after food   28 d          │
│     2 Isotretinoin 20 mg   0-0-1 with food    30 d          │
│     3 Adapalene 0.1% gel   apply at night     30 d          │
│ Tests  LFT, Lipid profile      Next visit  Mon 24 Nov       │
│ Prints in English + తెలుగు · WhatsApp to 98xxxxx345          │
│                    [Back to pad]   [Sign, finish & print ▸] │
└─────────────────────────────────────────────────────────────┘
```

#### 2.11 Pad states: loading, error, read-only, held (`:392-395`, `:844`) — D, J

| Sev | Issue | Fix |
|---|---|---|
| High | Error state missing: `if (!enc.data || !timeline.data) return <Skeleton/>` (`:392`). A 403/404/offline pad shows a skeleton for ever; a failing `/timeline` blocks the whole pad even though the encounter loaded. | Render the pad from `enc.data`; show "History could not load · Retry" inside the Past visits tab only. |
| Medium | Held banner `"Held for reports. Prescription issued 12 Nov. 1 of 2 reports in; pending: LFT (expected 14 Nov). Add or change what the results call for, then Complete. Issued medicines stay as written."` (`:844`) — three sentences in amber 12.5 px. | `Waiting for LFT (due 14 Nov) · 1 of 2 in`. |
| Low | Completed pad: chips `completed`, all inputs disabled, only "Print Rx". No "who signed / when" line. | `Signed by Dr X, 10 Nov 11:42`. |

#### 2.12 Print (`PrintRx.tsx`, `printPreview.tsx`) — D, reception

Purpose: the legal prescription the patient carries.

| Sev | Issue | Fix |
|---|---|---|
| Critical | S8 draft looks final; S9 stale data; S10 Telugu-only drops lines. | Watermark `DRAFT — NOT VALID` when `status==='draft'`; server refuses `/print` for drafts unless `?preview=1`; invalidate `['print', id]` after every save; in `te` mode fall back to English for any phrase without a translation. |
| High | Generic names not printed: only `i.name` (+ `dose`) (`:59`). `medicine` has no generic column (`schema.ts:75-87`). NMC guidance asks for generic names, legibly, preferably in capitals. **ASSUMPTION**: clinics will enter brand names. | Add `generic` to medicine; print `DOXYCYCLINE 100 mg (Doxt-SL)`. |
| High | Doctor block prints only if `e.doctor` exists and prints `"Reg. No. "` with an empty value when `regNo` is null (`:42`); no State Medical Council named; no digital signature/stamp; "Signature" line only (`:69`). | Block finishing if the signing doctor has no reg. no.; print `Reg. No. 12345 (Telangana MC)`; optional signature image. |
| High | Infant age missing (S11); weight prints only if the clinic's print-vitals setting includes it (`pad.ts` default `['weight_kg','bp']`) and it was recorded. | Under 12 y: age in months/years and weight mandatory on the print. |
| Medium | Frequency/timing/days/instructions at 11 px under a 12 px name (`:60-61`), Telugu in grey (`text-gray-800`) at 11 px, A5. Elderly patients. | 13-14 px instruction line, black, Telugu same size as English. |
| Medium | Multi-page: with many lines, page 2 has no patient name/ID/page number (single flowing div). | Repeat name, ID, date and "page 2 of 2" in a print header. |
| Medium | Date is `completedAt ?? createdAt` (`:24`) with no time; reprints carry no "Reprint/Copy" marker (EncounterDetail "Print prescription" `encounterDetail.tsx:55`). | Date + time; "Copy printed 12 Nov" on reprints. |
| Medium | `/print/:id` shows `"Loading…"` for ever on error (`:15`) and auto-calls `window.print()` 400 ms after data (`:14`). | Error message; no auto-print when data is a draft. |
| Low | `OP {e.visit?.opNumber}` prints `"OP undefined"` if missing (`:46`). Sex raw. Phone and locality printed (`:45`). | Guard; "Token 23". |

**Ideal print layout (A5):**
```
┌──────────────────────────────────────────────────────────────┐
│ SAHITYA SKIN CLINIC            Dr A. B, MD (DVL)             │
│ 12 Road No 3, Hyderabad 500034 Reg 12345 · Telangana MC       │
│ Ph 040-xxxxxxx                 10 Nov 2026, 11:42             │
├──────────────────────────────────────────────────────────────┤
│ PRIYA SHARMA · 24 y · F · ID 1043 · Wt 52 kg   Token 23       │
│ ALLERGY: SULFA (rash)            Pregnancy: not pregnant      │
├──────────────────────────────────────────────────────────────┤
│ Dx: Acne vulgaris, moderate                                  │
│ ℞ 1. DOXYCYCLINE 100 mg cap                        28 caps   │
│      1 cap morning, after food · 28 days                     │
│      ఉదయం 1, భోజనం తర్వాత · 28 రోజులు                        │
│   2. ADAPALENE 0.1% gel                             1 tube    │
│      apply thin layer at night on face · 30 days             │
│      రాత్రి ముఖంపై పలుచగా రాయండి · 30 రోజులు                 │
│ Tests: LFT, Lipid profile    Next visit: Mon 24 Nov 2026     │
│ Advice: Sunscreen every 3 hours / ప్రతి 3 గంటలకు సన్‌స్క్రీన్  │
│                                         Signature / stamp     │
│ page 1 of 1                                                  │
└──────────────────────────────────────────────────────────────┘
```

#### 2.13 Medical history chips (`historyChips.tsx`) — D, J

| Sev | Issue | Fix |
|---|---|---|
| High | Allergy capture is optional and buried: a dashed chip "Drug allergy" among six; "None of these" vs not asked differ only by 70 % opacity + grey "none" (`:36`). | See 2.2 header chip; ask "Any allergy?" as the first junior/desk question with Yes/No/Not sure. |
| Medium | `commit` writes `{...history, [open]: …}` from the props snapshot (`:23-28`): two people editing different categories overwrite each other. | PATCH one category server-side. |
| Medium | "Drug allergies" option list has classes (Sulfa, Penicillin, NSAIDs, Local anaesthetic, Cephalosporins, Tetracyclines — `history.ts:11`) but the pad's checker knows only three (S1). | One class table shared by chips and checker. |
| Low | `"· asked once, kept for every visit · confirmed 3 Nov by Ravi"` — good, but "confirmed" is updated on any save of any category. | Per-category confirmation date. |

#### 2.14 Vitals (`vitals.tsx`) — D, J

| Sev | Issue | Fix |
|---|---|---|
| Medium | Tiles save on blur (`:54-55`); an invalid value shows a 3-s toast and leaves the editor open, the tile does not turn red. | Inline red text under the tile. |
| Medium | `"Past values"` popover up to 900 px wide (`:62`) — overflows tablet portrait. | Scrollable sheet. |
| Low | BMI word `"obese"` chip in amber shown to patient-facing screen. | "BMI 31" only. |

#### 2.15 Past visits / Previous consultation modal (`:897-908`, `encounterDetail.tsx`) — D

| Sev | Issue | Fix |
|---|---|---|
| Low | Raw enums: status chip `{e.status}` → `"awaiting_reports"`, plan chips `followup` / `investigation` / `open` (`encounterDetail.tsx:29,50`). | "Waiting for reports", "Next visit", "Test", "Pending". |
| Low | `"Load Dx + Rx"` (`:904`) only in Stacked. | "Use this visit's diagnosis and medicines", every layout. |
| Low | Modal reprint has no "copy" marker (see 2.12). | — |

#### 2.16 Photos and consent (`photos.tsx`) — D, J

| Sev | Issue | Fix |
|---|---|---|
| Medium | Remove photo hard-deletes a clinical record (`:225-228`, body says "It is deleted for good"). Confirmed by dialog, but medico-legal records should be retained. | Soft-delete / hide with reason; owner can purge. |
| Low | Photo card title flips between "Photos" and "Then and now" (`:640`). | "Photos" + a compare button. |

#### 2.17 Junior doctor role fit — J

| Sev | Issue | Fix |
|---|---|---|
| High | S12 (screened on autosave; concurrent edit). Junior open on a doctor's `in_consult` draft moves the patient back to `intake` (`clinical.ts:73-74`) — pulls the patient out of the doctor's room status. | Refuse with "Doctor is with this patient". |
| Medium | Junior sees doctor-only clutter that does nothing for them: Diagnosis card, Examination with full lists, layout switch hidden but Stacked-only cards. Their job (vitals, history incl. allergy/pregnancy, complaint) is spread over 4 cards plus the screening block. | A 1-screen intake: Vitals · Allergy? · Pregnant/breastfeeding? · Complaint + duration · Photos · "Send to doctor". |
| Medium | Idle sign-out applies to juniors (only doctors in consult are exempt, `App.tsx:168-182`): it fires `app:save-now`, waits 800 ms, logs out — on a slow link the save is lost. | Await the save promise before logout; keep a local draft. |

---

### 3. Core flow: follow-up consult, 3 medicines, 1 test, follow-up date (Stacked, default)

Assumptions: review visit, last Rx had the same 3 medicines, one dose changes, test KOH mount, review in 14 days. **ASSUMPTION** timings for a practised user on a desktop.

| Step | Today (clicks) | Notes |
|---|---|---|
| Open patient from Today | 1 | "Continue"/"Open" (`Today.tsx:147/156`) |
| Wait for pad (encounter + timeline + docs + templates + stock + frequent, 6 requests) | 0 | skeleton until **both** encounter and timeline load (`:392`) |
| "How is it?" | 1 | Review card |
| Continue all | 1 | `:665` |
| Change one line's days | 2 + typing | "Change" → jumps/focus → edit Days |
| Diagnosis | 0-2 | carried forward only if the fee category is a review (`isReviewVisit :53`); otherwise 1 chip or typing |
| Scroll to Tests (past Advice) | 2-3 scrolls | 13 cards in Stacked |
| KOH mount | typing ~4 keys + Enter | not in the first 8 quick chips |
| Scroll to Follow-up | 1-2 scrolls | card ~11th |
| 14d | 1 | |
| Finish prescription | 1 | no summary |
| Print in modal | 1 | |
| Browser print dialog | 1 | |
| **Total** | **~10-12 clicks, 3-5 scrolls, ~20 keystrokes; ≈ 60-90 s** | |

**Proposed (Review layout by default for follow-ups, safety sheet, sticky plan strip):**

| Step | Clicks |
|---|---|
| Open | 1 |
| "Same" (how is it) | 1 |
| Last Rx rows pre-continued; tap the days chip on one row, pick 21 | 2 |
| Test chip (doctor's frequent tests first) | 1 |
| Next visit chip in the sticky plan strip (shows "Mon 24 Nov") | 1 |
| Finish & print → sign-off sheet (checks shown) → Sign | 2 |
| OS print (or silent kiosk print) | 1 (0 with kiosk) |
| **Total** | **8-9 clicks, 0 scrolls, 0-2 keystrokes; ≈ 25-35 s** |

---

### 4. Jargon and microcopy (current → proposed)

| Current (file:line) | Proposed |
|---|---|
| `Rxpad` (tab, `:830`) | Prescription |
| `Stacked` / `Focused` / `Review` (`:804`) | (remove switch) or "Full form" / "One section" / "Follow-up" |
| `T` + `Sx` / `Dx` / `O/E` / `Rx` / `Adv` / `Lab` logos (`:82`, `:501-508`) | Sets |
| `Load previous` (`:207-211`) | From last visit |
| `Anything already on the pad is kept once.` (`:223`) | Nothing is added twice. |
| `Clear loaded` / `Clear loaded (Acne)` (`:562`, `:820`) | Undo template |
| `Filled from <b>X</b>.` (`:562`) | Template X added. |
| `… allergy checked: no clash found.` (`:562`) | (remove — false reassurance) |
| `Type anything · medicines, symptoms, diagnosis, tests · “itra 100 1-0-1 7d”…` (`:839`) | Add medicine, test, symptom… |
| `Enter to fill` (`:840`) | Enter adds |
| `“X” is not in the lists. Add as` (`:841`) | "X" not found. Add it as: |
| `Quick add` (`:542` etc.) | Common |
| `Frequently prescribed` (`:594`) / `Repeat last Rx` | Your usual / Same as last visit |
| `Medications` (`:570`) | Medicines |
| `Examination findings` / `O/e` / `findings` | Examination |
| `Lab investigations` / `Investigations` / `tests` | Tests |
| `Review in` / `Review again` / `Review on` / `Follow-up` | Next visit |
| `Refer to a doctor` / `Referred to` | Referral |
| `Private notes` · `never printed or sent` | Private note (not printed) |
| `from check-in · tap a value to change it` (Vitals meta `:531`) | Tap to edit |
| `Since 12 Oct` (Review card title `:656`) | Since last visit (12 Oct) |
| `patient did not buy` (`:671`) | not bought here |
| `Held for reports.` / `Finish · hold for reports` / `Keep open for the rest` / `Complete` | Waiting for reports / Finish & print / Save, still waiting / Close visit |
| `Cannot finish yet · missing:` (`:924`) | Still needed: |
| `Autosaves every 15 s` / `Saves as you go` | Saved · 10:42 |
| `Save intake & return to queue` (`:928`) | Send to doctor |
| `Intake · doctor reviews next` (`:803`) | You are screening |
| `screened: itching · 2 weeks` (patient line `:792`) | Complaint: itching, 2 weeks |
| `not in list` (Stock column `:588`) | not stocked |
| `allergy: sulfa` (Stock column `:588`) | (move to a red bar under the row) |
| `Print settings` (bottom bar `:930`) | (remove; one entry in ⋯) |
| `Then and now` (`:640`) | Photos |
| `In your room · 2 of 3` (`Today.tsx:142`) | 2 inside |
| `note unfinished` / `note not finished` (`Today.tsx:73,195`) | Rx not finished |
| `screened · 12 min` (`Today.tsx:71`) | Ready · 12 min |
| `with junior` (`Today.tsx:71`) | With Dr <junior name> |
| `Click a name to open the patient. Times are booking windows, not exact minutes.` (`Today.tsx:230`) | (remove; design so it is not needed) |
| `awaiting_reports`, `followup`, `investigation`, `open` (`encounterDetail.tsx:29,50`) | Waiting for reports, Next visit, Test, Pending |
| `Reg. No. ` (empty) (`PrintRx.tsx:42`) | block finish until filled |
| `Review on 2026-11-24` (`PrintRx.tsx:67`) | Next visit: Mon 24 Nov 2026 |
| `OP 23` (`PrintRx.tsx:46`) | Token 23 |

Regional language: only Telugu is supported (`pad.ts` `lang: 'te+en' | 'en' | 'te'`, `TE` table). Hindi and other languages cannot be selected; free-text instructions are never translated and, in `te` mode, are dropped from the medicine lines (S10).

---

### 5. Inconsistent patterns

1. **Save models**: instant (vitals, history, pins, photos, lab values), 15-s autosave (note, Rx), explicit Save button, and "Save template" — four on one screen.
2. **Templates**: two systems, two endpoints, two approval rules (`rx-templates` instant vs `/templates` draft for owner approval), three entry points (header, card header, toolbar).
3. **Search**: global type bar, per-card SearchLine, toolbar ScopedSearch, Combo in the table, LabValuesEditor uses a native `datalist` (`labs.tsx:45`) — five different pickers.
4. **Primary button label** changes with state (4 labels); Today's "Open" vs "Continue" vs "Finish" for the same pad.
5. **Section names** differ between card, toolbar, settings, print (see §4).
6. **Quantity**: pad `qtyFor` counts units and returns null for SOS (`rxLine.ts`); pharmacy `prescribedQty` counts packs and treats unknown frequency as once a day (`pharmacy.ts:21`). The printed "× n" and the pharmacy's figure disagree.
7. **Allergy text** comes from `patient.allergies` (server-built from two history categories, `history.ts:40`), so food allergies (Milk, Eggs, Nuts, Dust) feed the drug checker as plain words (`allergyHit` falls back to `[word]`) — false positives on any medicine name containing "milk"/"dust"; drug classes give false negatives (S1).
8. **Confirmation**: whole-section Clear asks; pin Remove does not; photo Remove asks and hard-deletes; Finish (irreversible) does not ask.
9. **Error/empty states**: Today, pad and print all fall back to an endless skeleton/"Loading…" on failure.
10. **Touch targets**: card actions, row × and segmented controls are 28 px (`!min-h-7`, `!h-7 !w-7`), below 44 px for tablet use.

---

### 6. Server-side validation actually present (for the record)

- `PATCH /encounters/:id` (`clinical.ts:87-165`): Zod shape only. Required form fields + option membership on complete (`validate :24-34`). **No** check of: diagnosis present (client-only, `missingNow`), allergy, interactions, pregnancy, dose/frequency/duration ranges (`durationDays` int, no bounds; `qty` 0-10000), medicine existing in the catalogue, same doctor as the visit, version/concurrency. Completed encounters are immutable (`ALREADY_COMPLETED`).
- Vitals ranges are enforced server-side (`rxpad.ts:21-22`) — the one clinical value that is.
- Lab results: value 1-40 chars; flag computed server-side; edits not audited.
- `/encounters/:id/print` requires only `visit.read`; no status check.
- `POST /orders/review` requires all received; ok.
- `GET /encounters/:id` writes an audit view (`auditView`) — good.

### 7. Could not inspect

- `screening.tsx` (junior's ScreenBlock / ScreeningCard), `dayChange.tsx` (Change my day), `viewer.tsx` (report viewer), `ui.tsx` Modal/Floating focus handling and Segmented semantics, `index.css` print rules (`.printing-doc`), the default encounter form definition in the DB (which exam fields exist), Settings → Rx pad. No browser run: tablet layout, real print output and network-failure behaviour are inferred from code.


---

<a id="appendix-D"></a>
# Appendix D — Calendar, bookings, patients, follow-ups, broadcast

## UX audit: scheduling and the patient record (Cubott OPD)

Scope: `web/src/pages/Calendar.tsx`, `Bookings.tsx`, `Booking.tsx`, `web/src/apptDrawer.tsx`, `pages/Patients.tsx`, `pages/Followups.tsx`, `pages/Broadcast.tsx`, plus server `src/modules/scheduling.ts`, `patients.ts`, `followups.ts`, `broadcasts.ts`, with `src/lib/auth.ts`, `src/lib/audit.ts`, `src/app.ts`, `web/src/App.tsx`, `web/src/palette.tsx`, `web/src/table.tsx`, `web/src/api.ts` for context. I read the files on disk, including uncommitted changes. I ran nothing in a browser, so everything below comes from the code. Anything inferred is marked **ASSUMPTION**.

### 0. Who sees what (from `src/lib/auth.ts:17-26`, `web/src/App.tsx:18-35`)

| Role | Calendar / Bookings (`appointment.read`) | Book / move / cancel (`appointment.write`) | Patients (`patient.read`) | Register / edit (`patient.write`) | Follow-ups (`worklist.read` / `.write`) | Broadcast (`message.broadcast`) | Phones unmasked (`audit.ts:12`) |
|---|---|---|---|---|---|---|---|
| owner | yes | yes | yes | yes | yes / yes | yes | yes |
| admin | yes | yes | yes | yes | **no** / no | yes | yes |
| doctor | yes | no (own day only) | yes | yes | yes / no | no | yes |
| assistant (Junior doctor) | no | no | yes | no | no | no | **masked** |
| receptionist | yes | yes | yes | yes | yes / yes | no | yes |
| coordinator | yes | yes | yes | no | yes / yes | no | yes |
| pharmacist | no | no | yes | no | no | no | **masked** |

Notes:
- `appointment.overbook` is not in the `PERMISSIONS` catalogue (`auth.ts:42-77`). It is still granted through `appointment.*` to admin, receptionist and coordinator, so **everyone who can book can overbook**. A clinic that re-tunes a role in Settings saves only catalogue keys (`expandPerms`, `auth.ts:81-83`), and that role then loses overbooking without anyone being told.
- The `canExport` privacy setting (owner only by default, `audit.ts:12,22`) is **not checked by `DataTable`** (`table.tsx:134`). Every list in this area has an Export button for every role.

---

### 1. Inventory of screens and states (39 units)

Each entry gives the name, file:line, roles, how you reach it and its purpose, then the issues, each with a severity, the cognitive-load reason and the fix.

#### 1.1 Calendar page shell: `/calendar`, `Calendar.tsx:34-125`
Roles: owner, admin, doctor, receptionist, coordinator. Reached from the sidebar "Calendar", and from `/booking`, which redirects to `/calendar?book=1` (`main.tsx:49`). Purpose: see doctors' and rooms' days or weeks, and book or move people.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| High | **Three different booking forms** reach the same goal. (1) `BookPanel` (`Calendar.tsx:315-387`) opens from "+ → New booking" (`palette.tsx:14` → `?add=book`), the calendar search box and the waiting list. (2) The "Book" modal with `BookForm` (`Calendar.tsx:116-119`) opens when you click a free window. (3) `NewBooking` (`Booking.tsx:13-68`) opens through `?book=1` from Front desk "Rebook", Worklist and follow-up "Book visit" (`App.tsx:240`). They differ in order (patient first vs window first), wording ("New patient" vs "New caller"), options (only `BookForm` has Repeat and "Send confirmation") and the arrive-early default (30 at `Calendar.tsx:118`, 35 at `Booking.tsx:64` and `apptDrawer.tsx:35`). | Staff learn three mental models for one job; trainers can't say "this is how you book". | Keep one booking sheet: patient → slot chips → visit type → Book. Every entry point pre-fills it (patient, doctor, day, window). Delete the other two. |
| Medium | The "Show" filter (`:101-104`) defaults to `me.practitionerId ?? docs[0]` (`:46`). A receptionist always lands on whichever doctor is first in Settings, not "everyone today". | They have to re-orient on every visit. | Default to "Every doctor and room" for non-doctors and to their own column for doctors. The localStorage memory already exists (`:44`). |
| Medium | Each view returns `<Skeleton>` while `!q.data` (`:132, :190, :222, :494, :568`), so **a failed request looks like loading forever**. There is no error state and no "last updated" marker. | On patchy internet staff wait and trust a stale or blank calendar. | Show an inline error with "Try again" and a "Last updated 10:42" line once a refetch fails. |
| Medium | Moving by drag (`:58-68`) toasts `"… moved to 10:00. The patient is told."`. There is no undo, and that line is false when WhatsApp is not connected (messages are only `logged`; see `apptDrawer.tsx:14`, "ready (WhatsApp not connected)") or the patient has no phone. | Staff skip the call because the screen said the patient was told. | Toast `"Moved Ramesh to Tue 10:00 · Undo"`, plus "WhatsApp not connected: please call 98xxxxxx" when the message did not go. |
| Low | `style={{ zoom }}` (`:86`) is a non-standard CSS property. | Layout can break on older browsers on low-end devices. | Use a root font-size or a `--cal-scale` variable. |
| Low | Dead code: `WindowBox` (`:444-480`) and the `svc`/`status`/`show` fields of `Grid` (`:69`) are no-ops, because `TimeGrid` is only used for rooms (`:528, :582`) and both pass `windows: []`. The `nav` variable at `:445` is unused. | Maintenance only. | Delete them. |

#### 1.2 Colour key: `Calendar.tsx:87`
Purpose: legend of visit-type colours. **Low**: the meaning rests on colour alone, and it shows only when services have colours. **Fix:** keep it, but the pills should also carry a 1-2 letter visit-type tag so colour-blind staff can tell them apart.

#### 1.3 Calendar header search results: `SearchBox`, `Calendar.tsx:260-279`
Reached by typing two or more characters into the header search. Purpose: find a patient's upcoming bookings, or book them.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| High | Results show `fullName · patientNo · phone` (`:270`) with **no age or sex**. Family members who share one mobile look alike (for example "Priya Sharma" and "Priya S."). | Picking the wrong family member is the main same-phone risk. | Show `Priya Sharma · F 34 · P00123 · last visit 3 Oct` and group the rows under the phone number: "3 people on 98765 43210". |
| Medium | Only **upcoming** open bookings show (`scheduling.ts:320`). A booking cancelled this morning is invisible here. | "She says she's booked" can't be answered in one place. | Add "Last cancelled/no-show: 8 Nov" under the list. |
| Low | `Other matches` (`:272`) is an unclear label for "back". | | Use "← Back to results". |

#### 1.4 Attention strip: `Calendar.tsx:282-296`
Roles: appointment.write. It shows when patients need a call because a doctor's day changed, or when people are waiting for an earlier place.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| Medium | There is no way to mark someone in "to call" as **called** (`scheduling.ts:278-293` lists every booked appointment overlapping a leave/other block). The row stays until the booking is moved or cancelled. | The same people get called twice, and nobody knows who was reached. | Add "Called · told" / "No answer" per row, reusing the follow-up call log (`followups.ts` `callback`). |
| Low | `"See"` buttons give no clue what is inside. | | Use "Call list (4)" and "Waiting list (2)". |

#### 1.5 "Patients to call" modal: `Calendar.tsx:291-293`
Purpose: call patients whose doctor is away. The phone is shown as text, which is good given the no-call-button rule. **Medium:** "Move or cancel" opens the drawer and loses this list. When the drawer closes you start again from the strip. **Fix:** after an action, return to the list with the row ticked.

#### 1.6 Waiting list modal: `Calendar.tsx:298-312`
Purpose: offer earlier places. **Low:** `Remove` has no confirmation and no undo (only a toast, "Taken off the list"). **Fix:** add Undo on the toast. **Medium:** no free slot is suggested per person, although the strip already knows "N places free today" (`:288`). **Fix:** show the matching free time next to each person, with a one-click "Book 4 pm".

#### 1.7 Doctor day view: `DayDoc`, `Calendar.tsx:128-182`
Default view. Purpose: one row per OP window with names, free places, procedures, a now-line and drag-to-move.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| High | **Receptionists get a "Weekly hours" button they cannot use.** `canChangeDoc` is `canBook \|\| own` (`:81`), but `PUT /calendar/routine` needs `config.write` or own (`scheduling.ts:124`). The save fails, and `routine.tsx:61` toasts the raw code `FORBIDDEN:routine`. | Dead end, plus an error the user can't read. | Show "Weekly hours" only with `config.write` or own, and use `errText`. |
| Medium | You can drop onto **earlier windows today**. Drop is enabled on `!past`, which is a day-level check (`:159-160`). The server only refuses earlier days (`scheduling.ts:415`). | A drag slip can move a patient to 10:00 when it is already 17:00. | Disable drop when `isToday && w.endTime <= now`, and make the server check time too. |
| Medium | Name pills (`:164-169`) show the name only. The phone, service and note sit in `title`, which is a tooltip that never appears on touch. | Two "Ramesh" pills are indistinguishable. | Add an age/sex suffix when names collide, and show the note as a small dot. |
| Medium | `"3 / 7"` capacity at the right (`:175`) gives no meaning. | | Use "3 booked of 7". |
| Low | The help text `"Click a name to open the booking (move, call, cancel)"` (`:179`) promises "call", but the drawer cannot call. | | Use "Click a name to move, remind or cancel." |
| Low | The empty state `"No weekly hours set for this doctor"` gives non-owners nothing to do. | | "Ask the doctor or owner to set weekly hours in Settings." |

#### 1.8 All doctors cards: `AllCards`, `Calendar.tsx:189-217`
Purpose: one card per doctor and room. **Low:** a card shows "Next free: 10:00" but clicking it only switches view; it doesn't book. **Fix:** make "Next free 10:00 · Book" a direct action.

#### 1.9 Week grid: `WeekGrid`, `Calendar.tsx:220-257`
Purpose: how full each doctor's morning and evening are.

| Sev | Issue | Fix |
|---|---|---|
| Low | Colours are hard-coded (`#F6DCCF`, `#F4EBD3`, `:232`) and ignore dark mode and the `--g-*` glass tokens. The legend sentence at `:254` ("Green has room, sand is filling, peach is full") relies on colour names. | Use tokens and add "Full" / "Filling" words in the cell (the `sub` text partly does this already). |
| Low | Morning/evening is split at a fixed `14:00` (`:226`). | Derive the split from the routine gap. |
| Low | The grid scrolls sideways on phones (`min-w-[760px]`, `:249`). | On a phone, stack one day per row. |

#### 1.10 Rooms day view: `RoomsDay`, `Calendar.tsx:485-533`
Purpose: room status now, plus "Find a room". **Low:** "Find a room" finds one, but there's no "Schedule here" from the result. **Fix:** make each free room name a link into procedure scheduling. The rest is clear.

#### 1.11 Room week view: `RoomWeek`, `Calendar.tsx:564-594`
Clear. **Low:** the room avatar is the letter "R" (`:578`), which adds nothing; drop it.

#### 1.12 Block a room modal: `Calendar.tsx:536-561`
Good: undo toast, inline error ("End must be after the start."), quick reason chips. **Low:** the server doesn't warn when the block overlaps a booked procedure (`scheduling.ts:165-171`). **Fix:** preview "1 sitting in this time: move it first".

#### 1.13 "Book" modal from a calendar window: `Calendar.tsx:116-119` + `BookForm`, `Booking.tsx:70-127`
Reached by clicking a dashed "N free" or a window. See 1.21 for the form itself.

#### 1.14 BookPanel ("Book: Who, when, for what"): `Calendar.tsx:315-387`
Reached from + → New booking, from calendar search "Book Priya", and from the waiting list "Book". Purpose: phone-call booking.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **High** | **Silent duplicate patients.** If you type a name in "Phone number or name", `typedName` becomes the new patient's name (`:322`), and **Book is enabled even while the matching existing patient is listed right above** (`:382`, `!patient && name.length < 2`). The server creates a new patient with **no duplicate check** (`scheduling.ts:367-372`; only `POST /patients` checks, `patients.ts:86-90`). | The fastest path, typing a name and pressing Book, creates a second record and splits the history (allergies, dues). | When the search returns results and none is picked, Book reads "Pick a patient or tap 'New patient'". Make "New patient" an explicit choice, and apply the same name+phone check on the server for `newPatient`. |
| **High** | **Search failure looks like "no match".** `found.isError` is ignored. When the request fails, the list is empty and the "New patient" fields appear (`:348`). | Offline → duplicate patient. | On error show "Couldn't search, check internet" and keep Book disabled for a new patient. |
| **High** | **Phone normalisation.** The search needs exactly `^\d{10}$` (`:321`). Typing or pasting `+91 98765 43210` or `98765 43210` matches nothing and the new-patient form opens. In the mobile field, `replace(/\D/g,'').slice(0,10)` (`:351`) turns `+919876543210` into **`9198765432`**, a wrong but valid-looking number. | Wrong number → confirmations, reminders and private messages go to a stranger. | Normalise once in `api.ts`: strip non-digits, drop a leading `91` or `0` when the length is 12 or 11, require `/^[6-9]\d{9}$/`, and use the same rule on the server (`scheduling.ts:328`, `patients.ts:13`). |
| Medium | Family on the same number: "Same number:" (`:355`) only lists people from the current search results, and only after a pick, so it is empty when the patient came in pre-selected (`initialPatient`). Search rows show age/sex (`:347`); the chosen chip does not (`:344`). | Wrong family member. | The chosen chip should show `F 34 · last visit`, with "Others on this number: Ravi (M 40), Anu (F 8)" always fetched by phone. |
| Medium | A new patient can be booked **without a phone** (`:333`, phone optional). The toast still says `"Confirmation sent."` (`:334`) and the subtitle promises "The patient gets a WhatsApp." | False assurance. | Require a mobile for phone bookings, or show "No phone: no WhatsApp; tell the caller the time now". |
| Medium | The visit type silently defaults to the first service (`:329`). **ASSUMPTION:** if check-in derives the fee from the visit type, this can lead to the wrong fee. | Wrong billing risk. | Default to the patient's last visit type, or require a choice when there is more than one. |
| Medium | No "any doctor / earliest" option; you must pick a doctor first (`:359-361`), and it defaults to `docs[0]`, not the patient's usual doctor. | Extra clicks on "whenever is free". | Add an "Earliest with any doctor" chip; default to the patient's last doctor. |
| Low | Section labels `1 · Who` / `2 · When` / `3 · For` (`:343,:358,:374`): "For" is vague. | | Use "Visit type". |
| Low | It has no Repeat and no "Send confirmation" toggle, unlike `BookForm`. | Inconsistent. | Merge (see 1.1). |

**Redesign (one booking sheet, replacing 1.13, 1.14, 1.20, 1.21):**
```
┌ Book ─────────────────────────────────────────────── × ┐
│ Mobile or name  [ 98765 43210            ]  (normalised)│
│ On 98765 43210:                                          │
│  (•) Priya Sharma   F 34  P00123  last: 3 Oct, Dr Rao    │
│  ( ) Ravi Sharma    M 40  P00124  last: 1 Aug            │
│  ( ) Anu Sharma     F 8   P00410  guardian: Ravi         │
│  [+ Someone new on this number]                          │
│──────────────────────────────────────────────────────────│
│ Doctor [Dr Rao ▾] (her last)   [Earliest any doctor]     │
│ Tue 11  [10:00 3 left] [11:00 1 left] [17:00 5 left]     │
│ Wed 12  [10:00 6 left] …                    [More days]  │
│ Visit type [Review ▾] (last time)                        │
│──────────────────────────────────────────────────────────│
│ WhatsApp: ✓ confirmation will be sent | ⚠ not connected  │
│                         [Cancel]  [Book Tue 10:00 ✓]     │
└──────────────────────────────────────────────────────────┘
```

#### 1.15 Overbook dialog on drag: `Calendar.tsx:63`
`ask({ title: '10:00 is full', confirmLabel: 'Overbook', cancelLabel: 'Leave it' })`. **Low:** "Overbook" is jargon. **Fix:** "Add anyway (8 of 7)".

#### 1.16 Change my day: `dayChange.tsx`, opened at `Calendar.tsx:121`
**Not inspected** (outside my files). Server side (`scheduling.ts:206-275`): `handling: 'move'` auto-moves patients to the next free place within 14 days and messages them. **Medium (ASSUMPTION about the UI):** make sure the preview list (`preview: true`) is shown before saving, because auto-move is a mass, message-sending action.

#### 1.17 Weekly hours (routine) modal: `routine.tsx`, opened at `Calendar.tsx:122`
Only partially inspected: the error toast shows a raw code (`routine.tsx:61`). See 1.7.

#### 1.18 Procedure drawer (`procDrawer.tsx`, opened at `Calendar.tsx:115`)
Not inspected (new uncommitted file, outside my area).

#### 1.19 Bookings list: `/bookings`, `Bookings.tsx:23-70`
Roles: appointment.read. Purpose: a table of bookings with tabs (Upcoming/Past/No-shows/Cancelled), filters and search.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **Critical** | **Export CSV is open to everyone** (`table.tsx:134`, no `canExport` check). The tooltip says "every page", and Bookings exports up to 500 rows of names + phones + visit types (`:35, :54`). The privacy setting says only the owner may take lists out (`audit.ts:12`), and `listOut` (`api.ts`) audits only where it is used (Reports). | Mass patient-data exfiltration from a shared front-desk PC. | Hide Export unless `me.privacy.canExport`, route it through `listOut(...)` so it is audited, and enforce on the server (CSV built server-side, or at least the audit event required). |
| Medium | **Bookings duplicates Calendar.** Both sit in the sidebar for the same permission (`App.tsx:22-23`), both search a patient's bookings (`Calendar.tsx:261` vs `Bookings.tsx:27`), and both open the same drawer. | Two places to look; "which one do I use?". | Make Bookings a "List" toggle of Calendar (Day / Week / List), with one search. |
| Low | The Phone column falls back to `patientNo` in the same slot (`:42`). | You can't tell which is shown. | Use "no phone" in muted text. |
| Low | `"Last message"` shows `"Confirmation ready · …"` when WhatsApp is not connected (`:14`), while the drawer says "ready (WhatsApp not connected)". | Inconsistent; "ready" is jargon. | Use "Not sent (WhatsApp off)". |
| Low | Tabs have no counts; the "No-shows" tab has no "Call" link. | | Add counts, and "Add to call list" (they already flow into Follow-ups, `followups.ts:38-40`). |
| Low | The cap note "Showing the first 500…" (`:66`) appears under the table, away from where the eye is. | | Put it in the table footer. |

States: loading via DataTable; error text shown as the empty title (`:56`), which is good; bad custom dates are handled (`:34, :56`).

#### 1.20 New booking modal (`?book=1`): `Booking.tsx:13-68`
Reached from Front desk "Rebook" and "Book visit" (follow-up), Worklist "Book", and `/booking`. Purpose: doctor → day → window → patient.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| Medium | The "next day with room" search fires **up to 30 sequential requests** (`:24-28`) on open and on every doctor change. | Slow, and fragile on patchy internet. | One server call: `/calendar/free?from=&days=30&practitionerId=` (it already exists, max 21 → raise it). |
| Medium | Full windows are still selectable (`:56`, only dimmed at capacity 0), which leads to a WINDOW_FULL error after the form is filled. | Wasted typing. | Mark them "Full" and make them unselectable, with "Add anyway" only on a long-press or menu. |
| Low | Subtitle `"Doctor, day and window, then the patient"`: "window" is jargon. | | "Pick a time, then the patient." |
| Medium | **Patient name in the URL** (`App.tsx:240`, `pname=`; `FrontDesk.tsx:186`, `Worklist.tsx:54`). It stays in browser history on shared PCs. | Privacy leak on a shared device. | Pass only `patient=<id>` and fetch the name. |

#### 1.21 BookForm (shared): `Booking.tsx:70-127`
Used by 1.13 and 1.20.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **High** | Same duplicate-patient path as 1.14. Book is enabled with a typed name while results are listed (`:124`), and the server creates the patient without a check. Result rows show `name phone · patientNo` with **no age/sex** (`:107`). | Duplicates, wrong family member. | As in 1.14. |
| High | Phone `slice(0,10)` bug (`:113`). | Wrong number. | Shared normaliser. |
| Medium | Placeholders double as labels: "Phone number or name", "New caller: name", "Mobile (10 digits)", "Note (optional)" (`:106-116`). Once typed, the label disappears. | Low-literacy users lose context. | Use visible labels. |
| Medium | Repeat bookings: skipped dates are reported only in the toast as `"11-24, 12-08"` (`:90`, `day.slice(5)`). | Missed repeat visits go unnoticed. | After booking, show a result panel: "4 booked: 24 Nov, 8 Dec…; 1 not booked: 22 Dec (no window), Book another time". |
| Low | "Overbook anyway" (`:124`) appears for anyone; the server may refuse it for custom roles (`scheduling.ts:338`), and the user then sees the same "full" error again. | | Show it only with `appointment.overbook`. |
| Low | "New caller" here vs "New patient" in BookPanel. | | Use "New patient" everywhere. |

#### 1.22 Appointment drawer: `apptDrawer.tsx:21-102`
Opened from Calendar and Bookings rows. Roles: appointment.read (doctors read-only). Purpose: one booking with every action.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| High | **Moving is one click with no confirmation and no undo.** MovePicker tiles call `onPick` → PATCH immediately (`:82, :115`), and the server queues a "moved" WhatsApp (`scheduling.ts:444`). | A mis-tap on a cramped tile moves the patient and messages them. | Selecting a tile highlights it; a "Move to Tue 11:00" button commits; the toast offers Undo for 10 s (send the message after the undo window). |
| Medium | **No-show** is available all day for today's bookings (`:67`, `a.window.day <= today()`), even at 9:00 for a 18:00 booking, with one click and no confirmation. Undo exists (`:71`), and the server drops reminders (`scheduling.ts:432`). Undo re-plans reminders but doesn't resend. | Mis-marking a no-show at 9:00 for an 18:00 patient pushes them into the "Missed visits" calls. | Show No-show only after the window ends. |
| Medium | **Cancel has no undo**, and the cancellation WhatsApp is queued at once (`scheduling.ts:441`). The UI only allows undo for no-show. | Wrong cancel → patient told, slot given away. | Delay the message 2 minutes and offer "Undo cancel" (the server already accepts `status: 'booked'` from cancelled). |
| Medium | It shows `"Booked online"` (`:44`), but online booking was removed. | Confusing leftover. | Remove it. |
| Medium | The patient link the server returns (`scheduling.ts:478`, `link`) is never shown. **ASSUMPTION:** staff need it to resend "your booking" to the patient. | Feature unreachable. | Add "Copy patient link". |
| Low | Missing "Mark confirmed" (the server supports it, and the drawer toast even handles it, `:31`), and the note or visit type can't be edited. | | Add an "Edit" menu. |
| Low | `role="dialog"` without `aria-modal` or a focus trap; Esc closes it. | Keyboard users tab behind the drawer. | Add a focus trap and `aria-modal="true"`. |
| Low | `"Reminder queued"` (`:32`): "queued" is jargon. | | "Reminder will go on WhatsApp" / "WhatsApp off: reminder not sent". |

**Redesign:**
```
┌ Priya Sharma  F34 · P00123 · 98765 43210    [×] ┐
│ ⚠ 2 no-shows before                              │
│ Tue 11 Nov · 10:00–11:00 · Dr Rao · Review       │
│ Arrive by 09:30                                  │
│ [Move]  [Send reminder]  [Cancel]  [⋯ more]      │
│ ── Move ─────────────────────────────────────    │
│ Tue [11:00 2] [17:00 4]  Wed [10:00 6] …        │
│ Selected: Wed 10:00   [Move here]                │
│ ── WhatsApp ── ✓ Confirmation sent 9 Nov         │
│               ⚠ Not connected: call the patient  │
│ [Open record] [Copy patient link]                │
└──────────────────────────────────────────────────┘
toast: "Moved to Wed 10:00 · Undo" (message waits 10 s)
```

#### 1.23 Cancel panel: `apptDrawer.tsx:73-81`
Good: two steps, "Keep it", optional reason, and a "later repeat visits" checkbox that defaults off. **Low:** the reason input is free text; add chips ("Patient travelling", "Feeling better", "Doctor away").

#### 1.24 Move picker: `apptDrawer.tsx:105-121`
| Sev | Issue | Fix |
|---|---|---|
| High | One-click commit (see 1.22). | Select, then confirm. |
| Medium | **Windows that have already ended today are offered** (`:109` filters only the current window; the server checks the day only, `scheduling.ts:415`). | Filter `endTime > now` for today, client and server. |
| Medium | Same doctor only; you can't move to another doctor. You browse one date at a time with a date input. | Reuse the slot chips over 7 days with a doctor switch, as in BookPanel. |
| Low | Full windows are struck through but still occupy space. | Hide them behind "show full". |

#### 1.25 Patients list: `/patients`, `Patients.tsx:21-62`
Roles: every role except none (patient.read is held by all seven). Purpose: find and open a patient.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **Critical** | **Diagnosis shown in the list to every role.** The "Last visit" cell shows `mainProblem` (`:53`), which is the **diagnosis**, else the chief complaint (`patients.ts:60-61`). Pharmacists, junior doctors, receptionists and coordinators all see it on a list that is often on a shared front-desk screen. **ASSUMPTION:** a dermatology (DVL) clinic will have sensitive diagnoses (STIs, leprosy, vitiligo). | Private health data exposed to non-clinical roles and bystanders. | Show the diagnosis only with `encounter.complete`. For others show "Last visit 3 Oct · Dr Rao", and strip it server-side, not just in the UI. |
| **Critical** | Export CSV is not gated (same as 1.19). Here it exports only the current page (server mode, `table.tsx:79`), while the tooltip promises "every page". | Privacy plus a wrong promise. | Gate by `canExport` and audit; fix the tooltip. |
| **High** | **A failed search shows "No patients found"** (`:46`; `list.isError` is ignored). | Staff then register a duplicate. | Error state: "Couldn't load, check internet · Try again". |
| Medium | Search is substring on name, **prefix only** on phone (`patients.ts:40`). Typing the last 5 digits ("43210", how people often read numbers) or `+91…` finds nothing. There is no ABHA ID search, and the data model has no ABHA field (grep: none). | Missed matches → duplicates. | Normalise the phone, match the last 4 digits as well, and add ABHA (14-digit / `name@abdm`) as a field and a search key. |
| Medium | The empty state on the "Sent messages" view says "Use 'Message patients'…" (`Broadcast.tsx:105`), but no such button exists on the page; it is only in the "+" menu (`palette.tsx:28`). | Dead-end hint. | "Use + → Message patients". |
| Low | "Registered" is the default sort (newest first). For a receptionist, "recently seen" is more useful. | | Sort by last visit. |

#### 1.26 Register patient modal: `NewPatient`, `Patients.tsx:162-186`
Reached from + → Register a patient (`/patients?new=1`). Roles: patient.write (owner, admin, doctor, receptionist).

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **High** | The duplicate check is **exact name (case-insensitive) AND same phone** only (`patients.ts:86-89`; `ilike` with no wildcards). "Priya Sharma" vs "Priya  Sharma", "Priya S" or "Pria Sharma" on the same number passes silently, and a different phone with the same name+age is never checked. | Duplicates split medical history, including allergies. | As soon as the phone is typed, show **everyone on this number** (name, age, sex, last visit) with "This is her → open". Keep "Register anyway (family member)". |
| High | Phone `slice(0,10)` (`:175`) turns a pasted `+91…` into a wrong number; the label is just "Phone". | Wrong recipient for messages. | Label it "Mobile (10 digits)", normalise, check `^[6-9]`. |
| Medium | The duplicate banner (`:181`) shows only `patientNo`, no name, age or last visit. | Can't decide "same person?". | Show the full identity line. |
| Medium | No fields for **who answers this phone**, guardian (minor), preferred language, or ABHA. The edit form has the first two (`:106-107`). | Shared-phone families and Hindi/regional messaging need them at registration. | Add "Phone belongs to: self / mother / father / other" and language as quick chips. |
| Low | Sex as bare `M F O` letters (`:177`); Age/Sex `<label>`s are not linked to their inputs. | | Use "Male / Female / Other" and add `htmlFor`. |
| Low | `"RMP/PMP referral card"` (`:180`): jargon. | | "Referred by a local doctor (RMP/PMP card)". |

#### 1.27 Patient profile header: `/patients/:id`, `Patients.tsx:64-112`
Roles: all (patient.read). Reached from list rows, the drawer "Open record", Follow-ups.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **High** | **No upcoming bookings and no "Book" button** on the patient record (the file has no appointment list; the timeline API returns none, `patients.ts:114-144`). | The receptionist on a call opens the patient and can't see or make the next booking; they have to go to Calendar and search again. | Add an "Next: Tue 11 Nov 10:00 Dr Rao [Move] [Cancel]" strip plus a **Book** button, pre-filling the single booking sheet. |
| **Critical** | **Clinical detail for all roles.** Pharmacists, receptionists and coordinators get the full timeline: diagnoses, prescriptions (`:130-131`), the skin map (`:119`), photos (`:120`), and the guardian. The server only trims money (`patients.ts:141-143`). **ASSUMPTION:** `PhotoTimeline` lets `document.read` roles view lesion photos (not inspected). | Sensitive data visible to the wrong roles. | Role-shaped profile: front desk sees identity, contact, bookings, dues and visits (dates only); clinical sections need `encounter.intake`/`encounter.complete`. Enforce on the server. |
| High | The section order puts the **Skin map first** for everyone (`:119`). | Front desk scans past clinical widgets to find dues or phone. | Role-based order (see the sketch). |
| Medium | The `Visits` count is `visits.length`, capped at `limit(20)` (`patients.ts:119`), and consultations are capped at 10 (`:120`) with no "show older". | Wrong count; the doctor misses history. | Return a total count; paginate the encounters. |
| Medium | A missing or failed record shows a **skeleton forever** (`:78`, `if (!t.data)`). | Dead end. | "Record not found / couldn't load". |
| Low | Edit is an icon only (`:98`, pencil, `title="Edit"`). | Low-literacy users miss it. | Use a labelled "Edit details" button. |

**Redesign (front desk version):**
```
┌ Priya Sharma  F 34  P00123  [VIP]          Due ₹500 [Take payment] ┐
│ 98765 43210 · phone of: self · shared with Ravi (M40), Anu (F8)    │
│ ⚠ Allergy: sulfa                                [Edit details]     │
├────────────────────────────────────────────────────────────────────┤
│ NEXT  Tue 11 Nov 10:00 · Dr Rao · Review   [Move] [Cancel]  [Book] │
├────────────────────────────────────────────────────────────────────┤
│ Visits (12) 3 Oct · 1 Aug · …  (clinical details: doctors only)    │
│ Missed (1) · Messages (4) · Reports (2)                            │
└────────────────────────────────────────────────────────────────────┘
```

#### 1.28 Patient edit (inline): `Patients.tsx:100-111`
| Sev | Issue | Fix |
|---|---|---|
| **High** | The `save` mutation has **no `onError`** (`:76`), and `qc` has no global mutation error handler (`api.ts:3`). An invalid phone, a too-long field or a network failure → **nothing happens**: the form stays open with no message, and the user thinks it saved or gives up. | Add `onError: (e) => toast(errText(e), 'err')` plus inline field errors. |
| High | The phone field has no `inputMode`, `maxLength` or normalisation (`:102`, a generic text input for all fields). Changing a phone has no duplicate or family check. | Use the same mobile input as registration; show "Others on this number" after the change. |
| Medium | Fixed `grid-cols-3` (`:101`) gives three cramped columns on a phone. | Use `grid-cols-1 sm:grid-cols-3`. |
| Low | Labels aren't linked to inputs (`:102`). | Add `htmlFor`/`id`. |

#### 1.29 Profile sections (filter, Open plans, Reports, Missed, Sittings, Messages): `Patients.tsx:114-158`
| Sev | Issue | Fix |
|---|---|---|
| Low | The "Show" filter (`:114`) uses "Missed" with a count. Good. "Open plans" rows show raw statuses (`r.status`: "open", "contacted", "scheduled", `:141`). | Plain words: "Not yet called", "Called", "Booked". |
| Low | Messages (`PatientMessages`, `Broadcast.tsx:124-137`) shows `kind.replace('_',' ')`, which gives "followup call" and "confirmation". Status "logged" is shown as "demo" only for broadcasts, but as raw "logged" for others. | Map the kinds to words; one status vocabulary. |

#### 1.30 Follow-ups list: `/followups`, `Followups.tsx:33-103`
Roles: owner, doctor (read), receptionist, coordinator. **Admin has no access** (no `worklist.read`). Purpose: who to call today.

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **High** | **"Booked" doesn't book.** The CallDialog says `"Book the visit or sitting as usual; this takes the patient off the list."` (`:120`). Saving "Booked" removes the row (`followups.ts:50`) **even if no booking is ever made**. There is no Book button on the page. | Dead end; patients silently fall off the list. | Put a **Book** row action that opens the booking sheet with the patient, `day=dueOn` and `rec=` pre-filled (the `?book=1&rec=` flow already exists, `App.tsx:240`). Only a real booking removes the row. |
| **High** | **Patients already booked stay on the list.** Booking through Calendar or Bookings doesn't touch the recommendation (`scheduling.ts:352-397`), and a no-show who was rebooked stays in "Missed visits" (`followups.ts:38-40`) until someone logs a call. | Staff call people who are already booked; that annoys patients and wastes time. | When building the list, drop rows whose patient has an open future appointment (show "Booked Tue 10:00" greyed), and close the rec on booking. |
| **High** | **A server error looks like "Nobody to call here"** (`:90`; `q.isError` is ignored). | Calls are silently skipped for the day. | Error state with retry. |
| **Critical** | Export is ungated (same as 1.19) and includes the **Reason**, which for reviews is the **diagnosis** (`followups.ts:31`, `dxOf`), plus phones. Coordinators and receptionists see that diagnosis in the "Reason" column. | Private data to non-clinical roles and out the door. | Gate export; for non-clinical roles show "Review (Dr Rao, 3 Oct)" instead of the diagnosis. |
| Medium | Bulk "No answer, send a message" (`:95-97`) messages N patients **with no confirmation**. It posts sequentially (`:44`); on a mid-way failure some are logged and some aren't, and the toast shows only the error. Families on one phone get one message each. | Mass message to the wrong selection; unclear partial state. | Use `ask()` with the count and a recipient preview, one server batch endpoint, and dedupe by phone. |
| Medium | Clicking a patient name (`:54`) navigates away and loses the filter/scroll (the URL keeps the tab; scroll is lost). | | Open the patient in a side drawer. |
| Low | Tab names: "Advised, not agreed", "Procedures to schedule", "Reviews due" (`:11`). | | See the microcopy table. |

**Redesign:**
```
Follow-ups   [Come-back visits 12] [Missed 4] [Procedures: need a date 3] [Doctor advised, undecided 6]
Due: Overdue & today ▾   Last call: Any ▾                               
┌──────────────────────────────────────────────────────────────────────────────────┐
│ Priya Sharma F34   Review (Dr Rao 3 Oct)   2 days late   98765 43210  Not called │
│    [Book]  [No answer]  [Call back ▾ Tomorrow | 3 days | Next week]  [Not coming]│
│ Ravi Kumar M40     Missed visit 8 Nov      today         98xxxxxxx   No answer×1 │
│    [Book]  [No answer]  [Call back ▾]  [Not coming]                               │
│ (greyed) Anu S F8  Review   → already booked Wed 12 Nov 10:00                     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

#### 1.31 Log call dialog: `CallDialog`, `Followups.tsx:105-126`
| Sev | Issue | Fix |
|---|---|---|
| Medium | The default outcome is **"Call later" with an empty date** (`:106-107`), so **Save is disabled with no reason given** (`:113`). The most common real outcome is "No answer". | Have no default selection; the Save button says what is missing ("Pick a date"). Better still, use row buttons (1.30). |
| Medium | "Not interested" needs 3+ characters (`:113`), and the only hint is the label "Why (required)". | Reason chips: "Feeling better", "Went elsewhere", "Cost", "Other". |
| Low | The Sunday check uses native `confirm()` (`:111`) and is hard-coded to Sunday on the server (`followups.ts:76`), not the clinic's closed days. | Use `ask()` and the clinic's closed days from the routine/holidays. |
| Low | "Send a short message with the clinic number" is ticked by default (`:107`). On a shared phone this tells the family the patient is being chased by a clinic. | Default off for "Handle carefully" patients; show the message text. |

#### 1.32 Follow-ups bulk bar: `Followups.tsx:95-98`
Covered in 1.30.

#### 1.33 Closed-day `confirm()`: `Followups.tsx:111`
A native browser dialog, inconsistent with `ask()`. Low.

#### 1.34 Message patients, step 1 "Who": `BroadcastDialog`, `Broadcast.tsx:20-63`
Roles: owner, admin. Reached from + → Message patients (on `/patients` only, `palette.tsx:28`).

| Sev | Issue | Why it costs | Fix |
|---|---|---|---|
| **High** (Critical once WhatsApp is live) | **Defaults to "Everyone" with everyone pre-ticked** (`:22, :28`). Three clicks plus a confirmation message the whole database. There is **no messaging consent or opt-out**: `patient.consents` only covers photos (`documents.ts:25`), and the audience query never checks consent (`broadcasts.ts:19-30`). **ASSUMPTION:** promotional WhatsApp needs opt-in (WhatsApp Business policy, DPDP Act 2023). | Mass message to the wrong list; legal exposure; family members on a shared phone learn of clinic visits. | No default audience; require a pick. Add a "WhatsApp messages: yes/no" consent captured at registration and exclude non-consenting patients ("12 left out: no consent"). Separate "Clinic notice" (closure) from "Promotion" (camp/offer). |
| **High** | **The silent 1000 cap.** The preview returns at most 1000 recipients (`broadcasts.ts:38`), and the UI ticks only those (`:28`), so the count reads "1000 patients will get this" even when 4,000 match. **"Pick patients" can't reach anyone past the first 1000 alphabetically**: the search is client-side over that 1000 (`:30`). The server also caps `ids` at 2000. | A clinic-closed notice silently misses people whose names come later in the alphabet. | Send the audience definition rather than ids for group sends, show the total, and search server-side for "Pick". |
| Medium | **No dedupe by phone** (`broadcasts.ts:44-50`): a family of four on one number gets four messages. | Annoying; reveals family members' records to each other. | One message per phone ("Dear Sharma family") or the main contact only. |
| Low | "Tick all shown / Untick all shown" next to the search is ambiguous. | | "Tick these 23". |

#### 1.35 Step 2 "Message" + test send: `Broadcast.tsx:65-77`
| Sev | Issue | Fix |
|---|---|---|
| Medium | Templates contain `[date]`/`[time]` (`:13-14`), and nothing stops sending with the literal brackets. | Block Next while `[`…`]` remains: "Fill in [date]". |
| Medium | English only; no Hindi or regional templates, and no per-patient language. | Language field plus template variants. |
| Low | The test send needs your number typed every time (`:73`). | Remember it per user. |

#### 1.36 Step 3 "Send" + confirmation: `Broadcast.tsx:79-86, :37`
**Low:** double confirmation (step 3 and then `ask()`). Once the count and audience are on step 3, the extra dialog only trains people to click through. **Fix:** keep one confirmation that shows the count, a sample and the excluded counts.

#### 1.37 Sent messages list: `SentMessages`, `Broadcast.tsx:96-121`
Reached by Patients → "Sent messages" (only for message.broadcast). **Low:** there is no failure count per broadcast. **Fix:** add "38 sent · 2 failed".

#### 1.38 Sent message detail modal: `Broadcast.tsx:113-118`
Fine. **Low:** recipients are shown as plain rows; add "failed only".

#### 1.39 Toasts (collected)

| Where | Current text | Problem | Proposal |
|---|---|---|---|
| `Calendar.tsx:60` | "X moved to 10:00. The patient is told." | False when WhatsApp is off or there is no phone; no undo | "Moved to Tue 10:00 · Undo" + "WhatsApp off: call 98…" |
| `Calendar.tsx:334` | "X booked Tue 11 Nov 10:00. Confirmation sent." | Same | "Booked Tue 10:00. WhatsApp sent / not sent (no phone)" |
| `Booking.tsx:91` | "Booked 10:00–11:00 · arrive by 09:25 · 3 repeats booked, 1 skipped (12-22)" | Cryptic date | Result panel (see 1.21) |
| `apptDrawer.tsx:32` | "Reminder queued" | Jargon | "Reminder will go on WhatsApp" |
| `Patients.tsx:168` | "Registered P00123" | OK | add name |
| `Followups.tsx:110` | "Logged. A short message is on its way" | May be false in demo | "Saved. Message: not sent (WhatsApp off)" |
| `Broadcast.tsx:36` | "Recorded for N patients (demo, not sent)" | Honest. Good | – |
| `Patients.tsx:76` | (none on error) | Silent failure | add error toast |

---

### 2. Server checks summary

| Check | Where | Status |
|---|---|---|
| Window capacity / double-booking a slot | `scheduling.ts:333-342`, row lock `:358` | Good: effective capacity and `FOR UPDATE`. |
| Same patient twice in the same window | `:362-365` | Only when `patientId` is given; a new-caller path skips it. |
| Same patient in two windows, same day or doctor | none | **Missing.** Warn "Already booked today at 10:00 with Dr Rao". |
| Booking into a past day/time | `POST /appointments` has none; `PATCH` checks the day only (`:415`) | **Missing** time check. |
| Overbook permission | `:338` uses `appointment.overbook`, which is not in the catalogue | Effectively everyone with `appointment.*`; can't be tuned. |
| Duplicate patient on register | `patients.ts:86-89` | Exact name + phone only. |
| Duplicate patient on booking a new caller | `scheduling.ts:367-372` | **None.** |
| Phone validation | `^\d{10}$` (`patients.ts:13`, `scheduling.ts:328`, `broadcasts.ts:14`) | Accepts `0000000000`; no `+91` normalisation. |
| Phone masking | `app.ts:92-95` by `phoneRoles` | Good (pharmacist and junior doctor masked by default). |
| Diagnosis visibility | `patients.ts:60-61` (list), `:143` (timeline), `followups.ts:31` | **Not role-gated.** |
| Export privacy (`canExport`) | `audit.ts:22` | **Not enforced** in `DataTable`. |
| Broadcast consent / opt-out | `broadcasts.ts` | **None.** |
| Broadcast audience size | `broadcasts.ts:38` | Silently truncated to 1000. |
| Follow-up "Booked" closes the row | `followups.ts:50` | Without verifying a booking. |
| Routine edit | `scheduling.ts:124` | Owner/config or own doctor; UI shows it to reception (mismatch). |

---

### 3. Core flows: click counts

Counts are clicks or taps; typing is not counted, picking a date from a native picker counts as 2.

**(a) Book an existing patient who phones in**
- Today, via "+": + (1) → New booking (2) → type the mobile → pick the right family member (3) → doctor chip if not the default (4) → Evening if needed (5) → slot (6) → visit type if not the first (7) → Book (8). **Typical 4-6, worst 8.** Risks: typing a name and pressing Book creates a duplicate; a pasted +91 number fails.
- Today, via a calendar window: Calendar (1) → Show filter → doctor (2-3) → date arrows to the day (1-n) → "N free" (+1) → type → pick (+1) → Book (+1). **≈7.**
- Proposed: one sheet. + Book (1) → type the mobile, pick the person (2) → slot chip with their last doctor and visit type pre-selected (3) → Book (4). **4**; or from the patient record: Book (1) → slot (2) → Book (3). **3.**

**(b) Reschedule**
- Today, from Calendar: type the name in the header search → pick the patient (1) → pick the booking (2) → Move (3) → date picker (4-5) → tile commits immediately (6). **≈6, with no confirmation step.** Drag-and-drop is 1, but only same day, mouse only, no undo.
- Today, from Bookings: search → row (1) → Move (2) → date (3-4) → tile (5). **5.**
- Proposed: search → booking (1) → Move (2) → 7-day slot chips → pick (3) → "Move here" (4), with an undo toast. **4, with a safety net**; from the patient record "Next" strip: Move (1) → pick (2) → confirm (3). **3.**

**(c) Work the follow-up call list (per patient)**
- No answer today: Log call (1) → No answer (2) → Save (3). **3.**
- Call later today: Log call (1) → Call later (default) → date picker (2-3) → Save (4). **4.**
- Booked today: Log call (1) → Booked (2) → Save (3) → leave the page → + (4) → New booking (5) → retype and pick the patient (6) → slot (7) → Book (8). **≈8 plus retyping**, and if staff skip the booking the patient is lost from the list.
- Proposed: row buttons. No answer **1** (undo toast); Call back → "Tomorrow" chip **2**; Book → slot → Book **3** (the row closes itself); Not coming → reason chip **2**.

---

### 4. Jargon and microcopy (current → plain)

| File:line | Current | Proposed |
|---|---|---|
| `Booking.tsx:39` | "Doctor, day and window, then the patient" | "Pick a time, then the patient" |
| `Booking.tsx:51` | "No windows left this day" | "No time free this day" |
| `Booking.tsx:110-111` | "New caller: name" | "New patient: name" |
| `Booking.tsx:124` / `Calendar.tsx:63` | "Overbook anyway" / "Overbook" | "Add anyway (over the limit)" |
| `Calendar.tsx:380` | "Pick a free place." | "Pick a time." |
| `Calendar.tsx:369` | "3 left" | "3 places left" |
| `Calendar.tsx:374` | "3 · For" | "3 · Visit type" |
| `Calendar.tsx:175` | "3 / 7" | "3 of 7 booked" |
| `Calendar.tsx:149` | "Change this day" | "Doctor late / away / leaving early" |
| `Calendar.tsx:179` | "…(move, call, cancel)" | "…(move, remind, cancel)" |
| `Calendar.tsx:287` | "See" | "Call list (4)" |
| `apptDrawer.tsx:14` | "ready (WhatsApp not connected)" | "Not sent: WhatsApp not connected" |
| `Bookings.tsx:14` | "Confirmation ready" | "Confirmation not sent (WhatsApp off)" |
| `apptDrawer.tsx:32` | "Reminder queued" | "Reminder will go on WhatsApp" |
| `apptDrawer.tsx:44` | "Booked online" | remove |
| `apptDrawer.tsx:10` / `Bookings` | "no-show" | "Did not come" |
| `Followups.tsx:11` | "Reviews due" | "Come-back visits due" |
| `Followups.tsx:11` | "Procedures to schedule" | "Procedure agreed, needs a date" |
| `Followups.tsx:11` | "Advised, not agreed" | "Doctor advised, patient undecided" |
| `Followups.tsx:13` | "Price agreed" | "Agreed" |
| `Followups.tsx:94` | "Show waiting for call-back" | "Show people to call on a later day" |
| `Patients.tsx:105,180` | "RMP/PMP referral card" | "Referred by a local doctor (RMP/PMP card)" |
| `Patients.tsx:141` | raw "open / contacted / scheduled" | "Not called yet / Called / Booked" |
| `Patients.tsx:177` | "M F O" | "Male Female Other" |
| `Broadcast.tsx:54` | "Tick all shown" | "Tick these 23" |
| `Broadcast.tsx:105` | "Use “Message patients”…" | "Use + → Message patients" |
| `routine.tsx:61` | raw `FORBIDDEN:routine` | `errText(e)` |

---

### 5. Inconsistent patterns

1. **Three booking forms** (BookPanel, NewBooking, BookForm modal): different order, labels, options and arrive-early defaults (30 vs 35).
2. **Two places for bookings** (Calendar search and the Bookings table) with the same drawer.
3. **Error handling:** Bookings shows errors; Calendar, Followups, the Patients list, BookPanel search and the profile show skeletons or empty states on error; patient edit shows nothing.
4. **Confirmation patterns:** Cancel uses an inline two-step; Block room has an undo toast; Move commits on one click with no undo; No-show has undo; follow-up bulk messaging has no confirmation; Broadcast confirms twice; Followups uses native `confirm()`, everything else `ask()`.
5. **Message status vocabulary:** "ready", "ready (WhatsApp not connected)", "demo", "logged", "due", "queued".
6. **Row click:** Bookings and Patients rows are clickable; Follow-ups rows aren't (only the name).
7. **Identity line for a patient:** it differs on every screen (search: name/no/phone; BookPanel results: + age/sex; BookForm: name/phone/no; drawer: no/phone/age+sex; followups: no/age sex). It should be one component, `PatientLine`: name · sex age · P-no · phone · "shares phone with N".
8. **Phone input:** BookForm and BookPanel strip and slice; profile edit is a raw text field; Broadcast test strips only.

---

### 6. Not inspected or assumed

- Never run in a browser; there are no screenshots. Rendering, Tailwind classes, glass tokens and mobile layout are judged from the code only.
- Not opened: `dayChange.tsx` (Change my day), `routine.tsx` (apart from line 61), `procDrawer.tsx`, `photos.tsx` (photo visibility per role), `skinmap.tsx`, `flags.tsx`, `Privacy.tsx` (SeenBy), `ui.tsx` `Modal` (focus trap and Esc behaviour unknown), the message worker (whether `pending` messages are actually sent when WhatsApp is connected), and the public patient link page.
- **ASSUMPTION:** check-in fees depend on the visit type, so a silently defaulted visit type can mis-bill.
- **ASSUMPTION:** the tenant sees sensitive dermatology/venereology diagnoses, which makes diagnosis exposure Critical.
- **ASSUMPTION:** WhatsApp is not connected in the current deployment (the Broadcast copy says "Demo mode"; the drawer maps `logged` to "not connected").


---

<a id="appendix-E"></a>
# Appendix E — Procedures, courses, packages, test reports

## UX audit: Procedures, courses, packages, test reports (Cubott OPD)

Scope: `web/src/pages/Worklist.tsx`, `pages/ProcSchedule.tsx`, `procBoard.tsx`, `procDrawer.tsx` (uncommitted), `courses.tsx`, `packages.tsx`, `pages/TestReports.tsx`, `labs.tsx`; server guards in `src/modules/procedures.ts`, `courses.ts`, `plans.ts`, `orders.ts`, `followups.ts`, plus `documents.ts` / `rxpad.ts` where report upload and lab values land. Files read as on disk on 10 Nov 2026. Nothing was run in a browser. Anything inferred is marked **ASSUMPTION**.

Roles (from `src/lib/auth.ts:318-327`):
- **coordinator**: `worklist.*`, `appointment.*`, `payment.record`, `fees.see`, `document.*`. Has no `discount.give` and no `refund.course`. Lands on `/worklist` (`App.tsx:43`).
- **receptionist**: same worklist, payment and document rights, plus `visit.*`. Lands on `/queue`, because `visit.write` is checked first.
- **doctor**: `worklist.read`, `encounter.*`, `document.*`, `fees.see`. Lands on `/today`.
- **owner**: `*`.

Nav (`App.tsx:25-27`):
- "Procedures" `/worklist` shows when the user has `worklist.read`.
- "Test reports" `/tests` shows when the user has `worklist.read` or `encounter.complete`.

---

### 0. The five problems that matter most

| # | Severity | Problem | Where |
|---|---|---|---|
| 1 | **Critical** | **A procedure scheduled from "Plans to schedule" is never billed.** "Schedule" opens `ScheduleModal` directly, with no course or price step. When the sitting is marked done, `drawSitting` finds no course and does nothing (`courses.ts:247` → `if (!c) return;`). No charge and no due: the patient leaves without paying. `CourseDialog` also has "Book first sitting" *before* "Patient agrees" (`courses.tsx:86`), which leads to the same leak. | Worklist.tsx:98, 54; courses.tsx:86; courses.ts:244-258 |
| 2 | **Critical** | **The doctor can sign off an abnormal lab report without seeing the abnormal value.** `ReviewDialog` shows only file thumbnails, never the typed values or their red flags. The outcome is **pre-selected as "Normal · explain to the patient"** (`useState('normal')`, TestReports.tsx:93), so one click on "Reviewed" closes it as normal. Nothing alerts on an abnormal value: no event on flag, no sort priority, no count on the doctor's Today tile (Today.tsx:182 counts all ready orders). | TestReports.tsx:92-117; rxpad.ts:69-78; orders.ts:146 |
| 3 | **Critical** | **No procedure consent exists anywhere.** Only *photo* consent exists (`documents.ts:24-25`). "Start" / "Start sitting" (ProcSchedule.tsx:99, procDrawer.tsx:53) start a laser or peel sitting with no consent check, no consent capture and no record. | procedures.ts:189-213; procDrawer.tsx:53 |
| 4 | **High** | **Procedure day is buried and payment is disconnected.** The coordinator lands on *Tomorrow* (`ProcSchedule.tsx:24`). Start and Mark done sit inside a "⋯" menu, with no confirmation and no undo. No row says whether the sitting is prepaid or due. Payment means leaving for the patient record (ASSUMPTION: `TakePayment` on `Patients.tsx`). Done → charge is silent. | ProcSchedule.tsx:24, 94-103 |
| 5 | **High** | **A network error looks like an empty day.** The Schedule tab, Plans list and Test reports never check `isError`. A failed request shows "No procedures planned for today · Every room is free" or "No reports to collect". The Board shows a skeleton forever (`if (!q.data) return <Skeleton/>`). With patchy internet, staff will believe the day is empty. | ProcSchedule.tsx:78; Worklist.tsx:53; TestReports.tsx:188; procBoard.tsx:15 |

Other High items:
- The course refund is always recorded as **cash** (courses.tsx:66), whatever way the patient paid.
- Report upload uses `capture="environment"`, which blocks picking a WhatsApp PDF on many Android phones (TestReports.tsx:63).
- A sitting is charged in full even when part of the advance is still unused (courses.ts:255).
- Sitting numbers repeat when two sittings are booked ahead (procedures.ts:73).

---

### 1. Screen-by-screen

#### 1.1 Procedures page header and view switch
- **Where:** Worklist.tsx:42-45.
- **Who sees it:** anyone with `worklist.read` (coordinator, receptionist, doctor, owner). Reached from the "Procedures" nav item; it is the coordinator's landing page.
- **Purpose:** switch between Schedule, Board and "Plans to schedule".

| Sev | Issue | Why it costs attention | Fix |
|---|---|---|---|
| Medium | The page is titled "Procedures", but under Plans it also holds **Follow-ups** (Tabs, line 44). Follow-ups also has its own nav page `/followups`, with a *different* call log (see 1.8). | Two places to do one job; staff don't know which counts. | Remove the Follow-ups tab from `/worklist` and keep Procedures procedure-only. |
| Low | The "· N new" badge counts new **procedure + follow-up + investigation** plans (line 36). The segment count counts unscheduled procedures only. | Two numbers on one button that don't agree. | Count only unscheduled procedures created today. |
| Low | The subtitle changes meaning by tab: "What is planned, any date", "N overdue", "Everything the doctor recommended, nothing re-typed". | Marketing copy, not information. | Use "Sittings for {day}" and "{n} plans not booked yet ({k} overdue)". |
| Low | Three worklists poll every 15 s and sessions every 30 s, **even on the Schedule tab**. The investigation list is fetched but cannot be shown (line 24, see 1.10). | Wasted data on shared low-end devices with patchy internet. | Enable queries per visible tab and drop the investigation query. |

#### 1.2 Schedule tab (date strip, filters, sittings table)
- **Where:** ProcSchedule.tsx:18-112.
- **Who sees it:** everyone with `worklist.read`; actions need `worklist.write`. It is the default tab.
- **Purpose:** the sittings for one day, by room and doctor, and what needs fixing.

| Sev | Issue | Why it costs attention | Fix |
|---|---|---|---|
| **High** | The default day is **Tomorrow** for every non-doctor (`isDoctor ? t : add(t,1)`, line 24). On procedure morning the coordinator or receptionist opens the page and sees the wrong day. | The first thing on screen is not what's happening now. | Default to Today until the last sitting today is done or after about 4 pm, then Tomorrow. Or always Today, with Tomorrow one tap away. |
| **High** | The day's main actions, **Start** and **Mark done** (lines 99-100), are hidden in the "⋯" `MoreMenu`, next to Cancel. That is 2 clicks each, and the danger item sits beside them. | Routine work should be a visible button; menus are for exceptions. | Give each row one primary button for its next step: "Start" → "Done" → "Paid ✓/Take ₹X". Keep the menu for Reschedule, Doctor, Cancel and Missed. |
| **High** | "Mark done" has no confirmation and no undo. The menu hides every action once a sitting is `completed`. Marking done **creates the charge** (`drawSitting`, procedures.ts:210). A wrong-row tap charges the wrong patient's advance. | Irreversible billing hidden behind an unguarded menu item. | Give Done a 5-second undo toast. Show "Charged from advance ₹X" or "₹X due now" in the confirmation. Allow owner undo. |
| **High** | Rows show no payment state: prepaid, due, or no price agreed. | The desk cannot see who must pay before the patient leaves. | Add a money chip per row: "Prepaid" (sage), "₹2,500 due" (amber), "No price agreed" (rose; blocks Start for the desk). |
| **High** | `q.isError` is never handled. A failed fetch shows "No procedures planned for tomorrow · Every room is free" (line 79). | False empty state. | Show "Could not load. Showing last saved list at hh:mm · Retry". |
| Medium | **Past sittings never closed** show the neutral "scheduled" sky chip (line 54: `day >= t ? … : 'scheduled'`). A sitting left in `confirmed` yesterday was never done or charged, but nothing warns about it. | An unfinished day looks fine. | For past days with state confirmed or in_progress, show a rose "Not closed: mark done or missed". Add it to Needs attention. |
| Medium | "Mark as missed" has no confirmation (line 101). It frees the room and moves the plan to `contacted`. | Accidental tap with side effects. | Ask for a confirmation with a reason, as Cancel does. |
| Medium | Status words mix three vocabularies. Server `confirmed` means "scheduled". The UI shows "patient confirmed", "not confirmed" (amber for *every* future sitting), "scheduled", "in progress", "done" and "missed". The drawer maps `confirmed` → "scheduled". | "Confirmed" means two things. | Use one ladder: Booked → Patient said yes → In room → Done / Missed / Cancelled. Rename the DB-facing label everywhere. |
| Medium | The date strip *and* a date input sit side by side (lines 59-60). | Two controls for one choice. | Keep the strip and add a "📅 Other date" chip at its end that opens the native picker. |
| Medium | The row name goes to the patient record (line 88). The sitting drawer (allergies, plan, earlier sittings) is reachable **only from the Calendar**. | The safety summary is not where the procedure is run. | Make the row open `ProcedureDrawer`, and keep "Open record" inside it. |
| Medium | No "Handle carefully" flags or allergy marker in rows. Board and drawer show `FlagChips`; this list does not. | Risk of a privacy slip when calling names aloud. | Add `FlagChips` next to the name. |
| Low | The header row is `hidden md:flex`. Below md the room and doctor fold into the subtitle. That is acceptable, but the fixed `w-44` status column wraps badly at 360 px. | Cramped on phones. | Stack the status under the name below md. |
| Low | The footnote "Plans the doctor made that are not scheduled yet are under “Plans to schedule”." repeats the tab label. | Noise. | Remove it; the empty-state button already covers this. |

**Ideal redesign (Schedule = "Today's procedures")**
```
Procedures · Today, Tue 10 Nov          [Yesterday][Today•6][Tomorrow•4][Thu][Fri][📅]
! 2 need attention: 1 no doctor · 1 not closed from yesterday
──────────────────────────────────────────────────────────────────────────────
10:00  Priya S. 32F  ⚑careful   Laser hair · 3 of 6   Laser room · Dr A
       Prepaid ✓   Consent ✓                                  [ Start ]  ⋯
10:30  Ravi K. 41M              Chemical peel · 1 of 4  Room 2 · —
       ₹2,500 due  Consent ✗                       [ Take consent ]  ⋯
11:15  Asha M. 28F              Peel · 2 of 4 · IN ROOM 12 min
       ₹2,500 due                                   [ Done → take ₹2,500 ] ⋯
```

#### 1.3 "Cancel this sitting?" confirmation
- **Where:** ProcSchedule.tsx:102, with its twin at Worklist.tsx:54.
- **Who sees it:** coordinator, receptionist, owner. Reached from ⋯ → Cancel this sitting.
- **Assessment:** good. It names the patient, procedure and time, shows "Keep it" vs "Cancel sitting" and asks for a reason. Two issues:

| Sev | Issue | Fix |
|---|---|---|
| Low | The reason is optional (no `required`), so cancellations carry no reason. | Make the reason required, or offer reason chips: "Patient asked", "Doctor away", "Machine down". |
| Low | The copy "the plan goes back to open" is internal jargon. | Use "It goes back to *Plans to schedule*." |

#### 1.4 AssignDoctor modal
- **Where:** ProcSchedule.tsx:116-135.
- **Who sees it:** worklist.write users. Reached from ⋯ → Assign doctor / Change doctor.

| Sev | Issue | Fix |
|---|---|---|
| Medium | The default doctor is `docs[0]` when the sitting has none (line 117), so pressing Assign immediately puts the first doctor on it. | Start empty and require a choice. |
| Medium | The clash panel's button is "Assign anyway", and the override reason is not recorded. | Ask "Why double-book?" and log it. |
| Low | "Blocks this doctor's OP capacity for the slot." and "OP" are jargon. | Use "Dr A will have no OPD bookings 10:00–10:45." |
| Low | "Supervised by (optional)" is fine, but its default is "Nobody". | Keep it. |

#### 1.5 ScheduleModal: schedule and reschedule
- **Where:** Worklist.tsx:117-163.
- **Who sees it:** worklist.write users. Reached from Plans row "Schedule" / "Schedule next" / "Reschedule", ⋯ → Reschedule on the Schedule tab, and `CourseDialog` "Book sitting n".
- **Purpose:** pick a day, duration, doctor and room slot.

| Sev | Issue | Why it costs attention | Fix |
|---|---|---|---|
| **Critical** | This modal lets a sitting be booked **with no agreed price or course** (see top issue 1). | Revenue leak, and "paid on procedure day" never happens. | If the plan has no course, show the price step inline at the top: package chips plus "Patient agrees ₹X". Server: refuse `POST /procedure-sessions` (or `completed`) for a procedure with a catalog price and no course, or create a list-price course automatically. |
| **High** | "Schedule anyway" (line 158) double-books a laser room or doctor with one click and **no reason**. The server only records `forced: true`. | Clash override is too easy. | Require a reason and show it on both clashing rows. |
| Medium | Slots are hard-coded from 9:00 to 20:00 every 30 min (procedures.ts:51). They ignore clinic hours and closed days (Sunday), and on **today** they offer times that have already passed. | Staff can book impossible times. | Filter slots by clinic hours, holidays and the current time. |
| Medium | Duration chips are 15/30/45/60/90/120. A procedure with `typicalMinutes` 20 or 40 shows **no chip selected**, yet that value is sent. | The state is invisible. | Include the procedure's typical minutes as the first chip, labelled "usual". |
| Medium | Doctor "Other staff / none" can be chosen when `requiresMainDoctor` is set (only a small "required" tag). The server returns `DOCTOR_REQUIRED`, which errText shows as a generic error. | Avoidable error. | Hide the none option when the procedure needs a doctor. |
| Medium | The manual room `<select>` lists **every** room, including ones without the needed capability. That gives `ROOM_LACKS_CAPABILITY` after Confirm. | Avoidable error. | Filter manual rooms by capability, or disable the others with "(no laser)". |
| Medium | `grid grid-cols-3` (line 141) has no responsive breakpoint. On a phone the day, duration chips and doctor are squeezed into thirds. | Unusable at 360 px. | Use `grid-cols-1 sm:grid-cols-3`. |
| Medium | The slots endpoint runs `conflicts()` for every room × 22 slots, each doing 2-4 queries (procedures.ts:51-54). That means hundreds of queries per day change, which is slow on weak links (ASSUMPTION: noticeable latency at 4+ rooms). | Spinner each time the day, duration or doctor changes. | Load the day's sessions and blocks once and compute the slots in memory. |
| Medium | No WhatsApp confirmation or reminder is sent when a sitting is booked (no `message` insert in procedures.ts). "Mark patient confirmed" is manual. | More calls for the desk. | Send a template with the date, time and a "Reply YES" link that sets `patientConfirmedAt`. |
| Medium | The next due date ignores the plan interval. Package `intervalDays` is stored but only becomes free-text notes (Encounter.tsx:369). | The coordinator works the date out by hand. | Default the day to last done sitting + interval. |
| Low | The Confirm button reads "Confirm 10:30" with no date. The toast says "Scheduled 2026-11-11 10:30" (ISO). | ISO dates are hard for staff to read. | Use "Book Wed 11 Nov, 10:30" and toast "Booked Wed 11 Nov 10:30 · Laser room". |
| Low | Clash lines print raw kinds: "• room_blocked: …", "• break: …". | Jargon. | Map them: "Room closed", "Doctor on break", "Room in use by …". |
| Low | "Previous sittings" chips show raw state: "confirmed", "in_progress". | Jargon. | Reuse the status ladder. |
| Low | The "Set time and room manually" `<details>` sits below the slots, and a manual time silently replaces a picked slot. | Hidden state change. | Show which time will be used next to the Confirm button. |

#### 1.6 Board tab (ProcedureBoard)
- **Where:** procBoard.tsx:12-38.
- **Who sees it:** `worklist.read` users. Reached from Procedures → Board.
- **Purpose:** every plan in Advised / Agreed / Paid, with a sittings ledger per plan.

| Sev | Issue | Fix |
|---|---|---|
| **High** | `if (!q.data) return <Skeleton/>`: on error the skeleton stays forever. | Add an error state with Retry. |
| Medium | A plan with **no course but booked sittings** is put in "Agreed", whose hint is "Price agreed; sittings not all paid" (plans.ts:89). That is false; no price was agreed. | Add a fourth state, "Booked, no price", in rose. It is the leak from issue 1. |
| Medium | The board is read-only, with no action other than "Open record". It is a dead end. | Give each card one next-step button: Advised → "Agree price", Agreed → "Book next / Take advance". |
| Medium | Up to 300 plans in three unpaginated columns, with no search. | Add a search box and per-column "show 20 more". |
| Low | Ledger "Paid" column values "from advance" / "paid" / "due" / "–". | Use "Prepaid" / "Paid" / "₹X due" / "—". |
| Low | Hints like "Told the plan; has not said yes". | Fine; keep them. |

#### 1.7 Plans to schedule tab (list, "Today in the rooms" strip, rows)
- **Where:** Worklist.tsx:46-64 and Row at 74-114.
- **Who sees it:** `worklist.read`; actions need `worklist.write`.

| Sev | Issue | Fix |
|---|---|---|
| **Critical** | The row's primary "Schedule" goes straight to ScheduleModal with no price or course step (line 98). See issue 1. | Make the primary button "Plan & book", which opens a combined price-and-slot sheet. |
| **High** | `list.isError` is not handled, so the screen shows "Nothing pending". | Add an error state. |
| Medium | Raw status chip `{r.status}` shows "open", "contacted", "scheduled", "cancelled" (line 89). | Use "Not called", "Called", "Booked", "Declined". |
| Medium | ⋯ "Mark done" (line 100) closes the whole plan instantly, with no confirmation and no reason. Remaining sittings disappear from every list. | Ask "Close plan with 3 sittings not done?" and require a reason. |
| Medium | The row actions take a lot of reading: primary + "Schedule another sitting" + "Cancel the booked sitting" + "Log a call" + "Mark as booked (already done elsewhere)" + "Mark done". | Keep 3 menu items at most. |
| Medium | The "Today in the rooms" strip (line 47) lists sittings as chips, with a "spark" icon button labelled only by tooltip "Photos", and an `<a href="/calendar">` that causes a full page reload. | Use a camera icon labelled "Photos", and `nav('/calendar')`. |
| Low | The empty-state hint "New recommendations appear here the moment the doctor completes an encounter." uses "recommendations" and "encounter", which are jargon. | Use "When the doctor plans a procedure, it shows here." |
| Low | Phone numbers are shown as text. That is good: the memory says desktops cannot dial. | Keep it. |

#### 1.8 "Log a call" inline panel
- **Where:** Worklist.tsx:104-111.
- **Who sees it:** worklist.write users. Reached from ⋯ → Log a call.

| Sev | Issue | Fix |
|---|---|---|
| **High** | It is a **second, inconsistent call log**. Outcomes here are 'Will come', 'Wants another date', 'No answer', 'Wrong number', 'Declined', 'Done elsewhere', written to `recommendation.contactLog`. The Follow-ups page (`followups.ts:271-300`) uses booked/call_later/no_answer/not_interested in the `callback` table and hides a row only on *its own* log (followups.ts:252-254). A call logged here **does not clear** the Follow-ups row, so the same patient is called twice. | Remove this panel and send "Log a call" to the Follow-ups row. |
| Medium | "Declined" sets the plan to `cancelled` with no reason. Follow-ups requires one (`REASON_NEEDED`). | Require a reason. |
| Low | The placeholder "note" is lowercase, the date input has no label, and the date's meaning is unclear: it silently changes `dueOn`. | Label it "Call again on". |

#### 1.9 "Cancel the booked sitting?" confirmation
- **Where:** Worklist.tsx:54. Same as 1.3. Same notes, and the copy "the plan goes back to open" again.

#### 1.10 ResultDialog and "Recent results" (unreachable)
- **Where:** Worklist.tsx:56-65 and 169-214.
- **Who sees it:** nobody. The `kind` state can only become `'procedure'` or `'followup'` (Tabs at line 44 offer only those two), so `kind === 'investigation'` never happens.

| Sev | Issue | Fix |
|---|---|---|
| Medium | Dead code. It would also **bypass the order flow**: with no file, it PATCHes the status to `done` without setting `receivedAt` (line 190), so the doctor would never see it in To review. | Delete `ResultDialog`, the "Recent results" section and the investigation query. Test reports owns this now. |

#### 1.11 ProcedureDrawer (sitting drawer, uncommitted)
- **Where:** procDrawer.tsx:19-93.
- **Who sees it:** anyone who can open the Calendar. Actions are shown when the user has `worklist.write` or `encounter.complete` (Calendar.tsx:115). Reached by clicking a procedure block on the Calendar.
- **Purpose:** what the doctor needs before starting: who, allergies, conditions, the plan and earlier sittings.

| Sev | Issue | Fix |
|---|---|---|
| **Critical** | "Start sitting" does not check or capture **procedure consent**. Only photo consent exists in the system. | Add a "Consent" line under "Before you start": ✓ signed date, or "Take consent" (tick + signature/photo of the form, stored as a `document` of kind `consent` linked to the plan). The server should refuse `in_progress` without consent for procedures flagged as needing it. |
| **High** | "Mark done" (line 54) has no confirmation, no undo and **no outcome capture**. `outcomeText` displays `s.outcome` (fluence, spot size), but nothing in the UI ever sends `outcome`. So the next sitting has no record of the settings used. | On Done, show a 3-field sheet with the procedure's parameters, prefilled from the last sitting, then "Save & done". Show the resulting charge. |
| **High** | No payment information: prepaid or ₹ due. | Add a money line under the time, e.g. "Prepaid (3 of 6 paid)" or "₹2,500 due today". |
| Medium | Allergies show "None recorded" whether the patient was never asked or said none. Conditions handle this correctly ("Not asked yet"). | Mirror the conditions logic: "Not asked yet" vs "None". |
| Medium | Not reachable from the Procedures Schedule rows, only from the Calendar. | Open it from schedule rows too. |
| Medium | No "Photos" button here, though before/after photos are core for derm procedures. The Worklist strip has one. | Add "Photos (before)" and "Photos (after)". |
| Low | Focus does not move into the drawer and is not trapped. Esc works. `role="dialog"` has no `aria-modal`. | Focus the close button on open and trap Tab. |
| Low | The error state shows only `errText`, with no Retry. | Add Retry. |
| Low | "Procedure sitting · patient confirmed" is in muted xs text. | Make it a chip. |

**Ideal drawer**
```
┌ Laser hair · sitting 3 of 6 ───────── [x]
│ Priya S · P-0412 · 32F · ⚑ careful
│ Tue 10 Nov · 10:00–10:45 · Laser room · Dr A
│ Money: Prepaid ✓ (3 of 6 paid)
├ Before you start
│ Allergies   Not asked yet  [Ask]
│ Conditions  PCOS
│ Consent     ✗ not taken    [Take consent]
│ Last time   fluence 18 · spot 10 (27 Oct)
├ [ Start sitting ]  (disabled until consent ✓)
└ Earlier sittings …           [Open full record]
```

#### 1.12 CourseDialog: price agreement, quote, advance, refund
- **Where:** courses.tsx:43-105.
- **Who sees it:** worklist users. "Pay for sittings now" needs `payment.record`; Refund needs `refund.course` (owner by default). Reached from the Front desk "Plan" action on a visit's procedure (FrontDesk.tsx:646) and from the patient record's Courses card "Open". **Not reachable from Procedures.**
- **Purpose:** agree a price, send a quote, take an advance, refund unused sittings.

Not-agreed state:

| Sev | Issue | Fix |
|---|---|---|
| **Critical** | "Book first sitting" (line 86) sits on the left of the footer, *before* "Patient agrees", and books with no course, so the sitting is never charged. | Remove it, or make it agree at list price first. |
| **High** | "Patient agrees" is disabled with **no message** when the price is above list (line 86). A lower price typed by someone without `discount.give` (coordinator, receptionist) fails on the server with the generic "You don't have permission to do that." The helper text says "You do not give discounts; the price stays at the list price." but the field stays editable. | For users without discount rights, make the price field read-only. For others, show a live "−12% · above your 10% cap: owner must agree" under the field and disable the button with that reason. |
| **High** | Package chips (line 78) set a price that may be below list. Packages are not checked against the cap or list when they are created (packages.tsx:14-19). A coordinator tapping a package therefore hits 403. Packages only match when `k.sittings === rec.sittings` exactly. | Treat a package as pre-approved: the server accepts a package id and skips the discount check. Validate the package against the cap in Settings. |
| Medium | The quote block (Valid for 7/15/30, WhatsApp, Print) sits inside the agreement form. Making a new quote silently declines the previous one (plans.ts:34). | Say "Replaces Q-0012" on the button. |
| Medium | An expired quote silently reverts the agreement to the **list** price (courses.ts:274), after the patient was told a discount. The UI shows "This quote has run out." but not the price that will be used. | Show "Patient agrees at ₹X (list; quote expired)". |
| Low | "Loading…" text, and no error state. Without `fees.see` the server returns `[]`, and the dialog shows the *agree* form even when a course exists. | Show "Cannot see prices" for users without fees. |

Agreed state:

| Sev | Issue | Fix |
|---|---|---|
| Medium | `Standing` crams six numbers into 2 lines: "6 sittings at ₹X = ₹Y (list ₹Z) [price locked] · 3 of 6 done · 2 paid ahead (₹…) · ₹… still to pay, on each procedure day". | Show 3 tiles: Done 3/6 · Paid ahead 2 · Still to pay ₹. |
| Medium | Pay-now stepper: when the amount is capped by `stillToPay`, "n sittings = ₹X" can show less than n × per with no explanation. | Show "₹X (balance)". |
| Low | UPI is the default mode, which is right for India. Reference is optional for UPI and card, which is acceptable. | Keep it. |
| Low | "The price is locked from this payment." is an internal concept. | Use "After this payment the price can't change." |

Refund prompts (two chained `ask()` dialogs, lines 62-67):

| Sev | Issue | Fix |
|---|---|---|
| **High** | The method is hard-coded to `'cash'` (line 66), so a UPI or card advance refunded by bank shows as cash out. **Cash drawer and day-close will not reconcile.** | Add mode chips (UPI / Cash / Card / Bank), defaulting to the original payment's method. |
| Medium | "Only the owner approves this." shows only to people who already have `refund.course`, so the desk never sees a refund path. There is no request/approve flow: the owner must be at the desk. | Let the desk click "Ask owner to refund", which creates a pending item for the owner to approve with one tap. |
| Medium | No idempotency key and no `assertDayOpen` on refund (courses.ts:316-326). A double tap can record two partial refunds, and a refund can land in a closed day. | Add both, matching the advance route. |
| Low | Free-text rupees with `replace(/[^\d.]/g,'')`, so "1,500" becomes 1500 (fine) but "15OO" becomes 15. | Use `MoneyInput`. |

Print quote window (courses.tsx:28-40): a pop-up is needed and the toast covers blocking. The footer "GST included where it applies" is vague. The **GST number and HSN/SAC are missing** (ASSUMPTION: not needed on a quote, but an invoice will need them).

#### 1.13 CoursesCard on the patient record
- **Where:** courses.tsx:108-120.
- **Who sees it:** users with `fees.see`. Shown on the patient record.

| Sev | Issue | Fix |
|---|---|---|
| Low | Hidden when the list is empty, which is fine. The row text repeats `Standing` jargon ("paid ahead"). The button "Open" is generic. | Label the button "Manage". |

#### 1.14 PackagesCard (Settings → Procedures)
- **Where:** packages.tsx:9-37.
- **Who sees it:** config users (owner, admin). Reached from Settings → Procedures tab.

| Sev | Issue | Fix |
|---|---|---|
| **High** | No check against the procedure list price or the discount cap, which leads to the 403 at the desk (1.12). | Show "List ₹X · this is −Y%" while typing, and warn above the cap. |
| Medium | Remove (×) saves instantly with no confirmation (line 26). | Confirm, or give an undo toast. |
| Medium | There is no edit. Changing a price means delete and re-add. | Tap a row to edit it. |
| Low | `intervalDays` ("Every (days)") is not used when booking. | Use it (1.5). |
| Low | The whole list is PATCHed from local state, so two admins editing at once overwrite each other. | Save per item, or re-read before saving. |

#### 1.15 Test reports page (tabs, grouped orders, OrderCard)
- **Where:** TestReports.tsx:171-201 and OrderCard at 125-168.
- **Who sees it:** users with `worklist.read` or `encounter.complete`. Data needs `document.read` (orders.ts:121). Doctors default to "To review"; everyone else to "To collect".
- **Purpose:** each test order from ordered → received → doctor reviewed → patient told.

| Sev | Issue | Fix |
|---|---|---|
| **Critical** | Nothing distinguishes an order with **abnormal values** from one with only normal values, in any tab or in the doctor's Today tile. The order sort is late first, then due date (orders.ts:146). | Compute `abnormal = count(flag in low/high/abnormal)` per order on the server. Sort abnormal first in To review, show a rose "2 out of range" chip on the card, and show "Reports 5 · 2 abnormal" in rose on Today. |
| **High** | `data.isError` is not handled: "No reports to collect" shows on network failure. | Add an error state. |
| Medium | In To review, partial orders also show for the doctor under "Nothing is complete yet. These are waiting for reports:" (line 190) only when nothing is ready. Otherwise they are mixed into the same patient groups. | Put partial orders in a separate "Waiting" sub-list. |
| Medium | The "Informed ▾" button uses a rotated chevron icon, then How? → In person / Phone / WhatsApp. Choosing WhatsApp **sends nothing**; it only records the choice. | Rename it "Patient told". For WhatsApp, offer "Send the doctor's note on WhatsApp" through the message queue. |
| Medium | Outcome "Needs a visit" has no "Book visit" action on the Explain card, and "Change medicines" has no link to the new Rx (ASSUMPTION: the Rx is changed on the pad). | Add "Book visit" (opens `?book=1&patient=`) next to Patient told. |
| Medium | "Called lab" logs a call but shows no lab name or phone. | Show the lab's number as text (no dial). |
| Low | The step crumb "Pending › Partly received › Ready for doctor › Reviewed › Informed" is fine, but it is 11.5 px muted text. | Increase the contrast. |
| Low | "Review what is in" (split, doctor only) is unclear. | Use "Review these now, wait for the rest separately". |
| Low | No search or filter by patient, and the list is unbounded. | Add a search box. |

#### 1.16 ReportDialog (desk adds a report and values)
- **Where:** TestReports.tsx:33-89.
- **Who sees it:** users with `document.write` (receptionist, coordinator, doctor). Reached from "Add report" on a pending test.
- **Purpose:** attach the pages, tick which tests they cover, and type the values.

| Sev | Issue | Fix |
|---|---|---|
| **High** | `capture="environment"` together with `multiple` (line 63): on many Android browsers this opens the camera directly with no file-picker option, so a **PDF from WhatsApp cannot be attached**. Indian labs mostly send PDFs on WhatsApp. | Use two buttons, "Take photo" (with capture) and "Choose file / PDF" (without). |
| **High** | **A file is mandatory** (`blocker = 'Add at least one page'`, line 53). Values read over the phone or from a WhatsApp text cannot be saved, and the test cannot be marked received. | Allow saving values alone; mark the test received when values or a file exist. |
| Medium | Not atomic. Files upload first, and each upload marks tests `done/received` (documents.ts:89). Values save afterwards in a separate call. If the values call fails on a weak link, the order is already "Ready for doctor" **without values**, and Save again **re-uploads the files** (duplicates). | Save in one server call (files + values), or keep uploaded doc ids in state and skip them on retry. |
| Medium | A decimal comma is misread: "11,2" becomes 112 (`replace(/,/g,'')`, labs.tsx:28), which flags **high** wrongly. (ASSUMPTION: the server `numOf` behaves the same.) | Treat a single comma followed by 1-2 digits as a decimal point, or reject it with "use a dot". |
| Medium | "Another value" rows with a name not in the clinic list get **no unit, no range and no flag**. An abnormal custom value is invisible. | Let the desk type the range printed on the report (low–high), or mark it "unchecked" in amber so the doctor looks. |
| Medium | The client flags with `cfg.labParams`; the server flags with its own `findParam` (rxpad.ts:73). (ASSUMPTION: same list.) If they differ, the red the desk saw is not what is stored. | Return the stored flags in the toast: "Saved · 2 out of range". |
| Low | `URL.createObjectURL` is never revoked, which leaks memory on low-end devices. More than 12 files are silently dropped (`slice(0,12)`). | Revoke the URLs on remove and close; tell the user about the cap. |
| Low | The footer status is good ("This completes the order: it goes to the doctor’s Today under Reports"). | Keep it. |

**Ideal ReportDialog**
```
Report for Priya S · Order 2 · CBC, TSH
[📷 Take photo] [📄 Choose PDF/file]   page1.jpg ×  lab.pdf ×
Tests: [✓CBC] [✓TSH]
CBC  Haemoglobin [ 9.1 ] g/dL 12–15   LOW
     WBC         [ 7400] /µL 4000–11000
TSH  TSH         [ 8.2 ] mIU/L 0.4–4.5 HIGH
⚠ 2 values out of range: the doctor will see them first
                                   [Cancel] [Save report]
```

#### 1.17 ReviewDialog (doctor reviews an order)
- **Where:** TestReports.tsx:92-117.
- **Who sees it:** users with `encounter.complete` (doctor, owner). Reached from "Review" on a ready order, or the Today "Reports" tile → `/tests?tab=review`.

| Sev | Issue | Fix |
|---|---|---|
| **Critical** | The typed values and their flags are **not shown**; only thumbnails (lines 103-110). The outcome **defaults to "Normal"** (line 93), and "Reviewed" is enabled immediately. A doctor in a 6-minute rhythm can close an abnormal TSH as normal without opening the PDF. | Show the values table (the `LabResultsCard` rows for these rec ids) above the files, out-of-range first in rose. Have **no default outcome**. If any value is out of range, the "Normal" choice should ask "2 values out of range. Still normal?". |
| Medium | Opening a file opens the viewer on top, and returning shows the dialog again. That is fine, but there is no side-by-side view. | Show the first page inline. |
| Low | "What now" outcomes are good, plain words. The note placeholder is good. | Keep them. |

**Ideal ReviewDialog**
```
Priya S · CBC, TSH · ordered by Dr A
OUT OF RANGE (2)
 Haemoglobin  9.1 g/dL  (12–15)  LOW   prev 11.0 (Aug)
 TSH          8.2       (0.4–4.5) HIGH  first time
In range (6) ▸
[page1.jpg] [lab.pdf]
What now: ( ) Normal  ( ) Change medicines  ( ) Needs a visit  ( ) I'll call
Note for desk [_____________]                  [Reviewed] (disabled until a choice)
```

#### 1.18 LabResultsCard on the doctor pad, with "Add lab values" modal and History pop-over
- **Where:** labs.tsx:79-119; editor at 40-57.
- **Who sees it:** the doctor, on the Encounter (Rxpad) "Lab results" card (Encounter.tsx:616).

| Sev | Issue | Fix |
|---|---|---|
| **High** | Inline edit (line 103) saves **on blur**. Clicking elsewhere after an accidental edit silently changes a clinical value, with no confirmation and no audit shown. The PATCH route has no `emit` (rxpad.ts:80-89), so there is no audit trail of who changed a lab value. | Save only on Enter or a ✓ button, and Esc/blur cancels. Emit `lab_result.corrected` with old → new. |
| Medium | Sorting puts out-of-range first, which is good. But "Latest values on record" mixes old values from different dates without showing the date per row (the date is only in "Earlier"). | Add the date to each row. |
| Medium | `LabValuesEditor` duplicates the flag logic inline (line 47) instead of calling `flagFor`. They can drift apart. | Use `flagFor`. |
| Low | The 7-column grid has no responsive fallback, so it is cramped on tablets. | Collapse Unit and Range under the value below md. |
| Low | The column header says "Investigation" in the pad and "Values" in ReportDialog; the button says "Add values" while the modal title says "Add lab values". | Use one word, "Test". |
| Low | The History pop-over is fine. | Keep it. |

#### 1.19 Toasts in this area (exact strings)
- "Updated" (Worklist:27, ProcSchedule:34) is vague. Say what changed: "Marked done · ₹2,500 due" or "Moved to missed".
- "Sitting marked done" / "Sitting started" (procDrawer:24) should include the charge outcome.
- `Scheduled ${day} ${time}` / `Moved to …` use an ISO date. Format it.
- "Marked as confirmed by the patient" is fine. "Confirmation removed" is fine.
- `Taken ₹X. Receipt R-0012` is good.
- "Refund recorded" should name the amount and the mode.
- "Price agreed" should say "₹X agreed for 6 sittings".
- `That is 12% off. Above 10% only the owner can agree` is good, but it appears only after submit.
- "Reviewed · the front desk can explain it" is fine.
- "Done · report closed" should be "Patient told · closed".
- "Noted: lab called" is fine.
- "Reviewing what is in · the rest is its own order" is jargon. Use "The rest will come as a separate report".

---

### 2. Server guards (what is enforced and what is not)

| Guard | Status | Evidence |
|---|---|---|
| Discount cap | **Enforced** on quote and course: `discount.give` is needed below list, and the owner above `discountCapPct` (default 10). Above list is refused. | plans.ts:25-30; courses.ts:277-282 |
| Discount cap gap | When a procedure has **no catalog price**, `list = totalPaise`, so any price passes. Packages are never checked. | courses.ts:271; packages.tsx:17 |
| Double charge of a sitting | **Guarded**: one charge per `sessionId` (courses.ts:248). | |
| Charge left on a cancelled session | **Gap**: the desk may PATCH *any* state, including `completed → cancelled` (procedures.ts:189-200 has no transition table for `worklist.write`). The charge stays (paid from advance). Rebooking and completing draws again, so **the sitting is effectively charged twice**. | procedures.ts:192-200 |
| Sitting charged at all | **Gap**: no course means no charge (courses.ts:247). | |
| Partial advance | **Gap**: `prepaid = unusedPaise >= amount`. With ₹1,000 unused and a ₹2,500 sitting, a full ₹2,500 is marked *due* and the ₹1,000 stays parked. **Over-collection** at the desk until the end-of-course refund. (ASSUMPTION: `TakePayment` does not net the advance.) | courses.ts:255 |
| Extra sittings beyond the course | They charge ₹0 silently (`amount <= 0 → return`). | courses.ts:252-253 |
| Sitting numbering | `sittingNo = completed + 1` at booking time, so booking 2 sittings ahead gives both the same number. The Board ledger matches by `sittingNo` and hides one. | procedures.ts:73; plans.ts:90 |
| Consent | **None** for procedures. Photo consent is enforced on photo upload only. | documents.ts:24-25, 67 |
| Refund approval | Enforced as a *permission* (`refund.course`, owner by default), not an approval workflow. No idempotency, no day-open check, and the client sends mode=cash. | courses.ts:316-326; courses.tsx:66 |
| Advance | Idempotency key, day-open check, EMI lender and code check, and no overpay: **all good.** | courses.ts:297-313 |
| Doctor's state changes | Restricted to confirmed→in_progress→completed: **good.** | procedures.ts:192-199 |
| Report review | All tests must be received before review, and review before inform. "Will call" blocks the desk: **good.** | orders.ts:160-176 |
| Abnormal alert | **None.** `lab_result.added` is emitted without flags; nothing notifies the doctor. | rxpad.ts:77 |
| Lab value edits | No audit event on PATCH or DELETE. | rxpad.ts:80-93 |
| Cancel, missed, postpone | The doctor's calendar block is freed and the plan status updated: **good.** | procedures.ts:202-208 |

---

### 3. Core flows: clicks today vs proposed

**(a) Coordinator schedules a planned procedure** (starts on `/worklist`, which opens Schedule · Tomorrow)

Today, through Procedures:
1. "Plans to schedule".
2. "Schedule" on the row.
3. (Change the day if needed.)
4. Pick a slot.
5. "Confirm 10:30".

That is **4-5 clicks, but no price is ever agreed, so the sitting is not billed.** Doing it properly means going through the Front desk or the patient record: Courses → Open → (package) → Patient agrees → Book sitting 1 → slot → Confirm, which is about **7 clicks across 2 pages**, plus 3 more to take an advance.

Proposed (one "Plan & book" sheet):
1. Row "Plan & book".
2. The price is prefilled (package or list); tap the slot. The day defaults to the due date or last + interval.
3. "Agree ₹X & book Wed 11 Nov 10:30".

That is **3 clicks**, with optional "+ take advance" in the same sheet (+2).

**(b) Procedure day: run a sitting and take payment** (coordinator on `/worklist`)

Today:
1. "Today" in the strip (the page opens on Tomorrow).
2. ⋯
3. Start.
4. ⋯
5. Mark done.
6. Click the patient name, which opens the record.
7. Find the due charge and Take payment (ASSUMPTION: Patients.tsx `TakePayment`).
8. Mode.
9. Confirm.

That is **about 9 clicks and 2 page loads**, with no consent step, no outcome capture, and no sign beforehand of whether it is prepaid. Through the Calendar drawer it is about 8.

Proposed:
1. "Start" on the row. Consent shows inline if missing (+1 once per course).
2. "Done", which opens a sheet with the last settings prefilled and the charge line ("Prepaid ✓", or "₹2,500 due · [UPI][Cash][Card]").
3. "Save & take ₹2,500 UPI".

That is **3 clicks** (2 when prepaid).

**(c) Desk enters a lab report; the doctor sees it**

Desk today:
1. Nav "Test reports" (it defaults to To collect).
2. "Add report".
3. "Photo or file".
4. OS picker or camera.
5. Type the N values.
6. "Save report".

That is **5 clicks + N fields**, and a PDF may be impossible on Android. Values-only entry is impossible.

Doctor today:
1. Today "Reports" tile.
2. "Review".
3. Open a file thumbnail.
4. Close the viewer.
5. (Outcome; "Normal" is pre-picked.)
6. "Reviewed".

That is **4-5 clicks, and the abnormal value is never shown in the dialog.**

Desk afterwards:
1. "To explain".
2. "Informed".
3. How.

That is **3 clicks**.

Proposed:
- Desk: **4 clicks + N fields**, with a separate "Choose PDF", values allowed without a file, and a summary of out-of-range values before Save.
- Doctor: **3 clicks**: Today tile ("Reports 5 · 2 abnormal") → Review (values table with abnormal on top; files inline) → pick an outcome (no default) → Reviewed.
- Desk: "Patient told" + how = **2 clicks**, with WhatsApp actually sending the doctor's note.

---

### 4. Jargon and microcopy (current → proposed)

| Where | Current | Proposed |
|---|---|---|
| Worklist.tsx:42 | "Everything the doctor recommended, nothing re-typed" | "Plans not booked yet" |
| Worklist.tsx:42 | "What is planned, any date" | "Sittings for {day}" |
| Worklist.tsx:89 | `open` / `contacted` / `scheduled` | "Not called" / "Called" / "Booked" |
| Worklist.tsx:53 | "New recommendations appear here the moment the doctor completes an encounter." | "When the doctor plans a procedure, it shows here." |
| Worklist.tsx:100 | "Mark as booked (already done elsewhere)" | "Done at another clinic" |
| Worklist.tsx:54, ProcSchedule.tsx:102 | "the plan goes back to open" | "it goes back to Plans to schedule" |
| Worklist.tsx:145, ProcSchedule.tsx:127 | "Blocks this doctor's OP capacity for the slot." | "Dr {name} gets no OPD bookings {from}–{to}." |
| Worklist.tsx:158 | "• room_blocked: …" / "• break: …" | "Room closed …" / "Doctor on break …" |
| Worklist.tsx:159 | "Confirm 10:30" | "Book Wed 11 Nov, 10:30" |
| ProcSchedule.tsx:54 | "not confirmed" (amber on every future row) | "Patient not called yet" |
| ProcSchedule.tsx:97 | "Mark patient confirmed" | "Patient said yes" |
| procDrawer.tsx:10 | `confirmed → "scheduled"` | "Booked" (one ladder app-wide) |
| procBoard.tsx:32 | "from advance" | "Prepaid" |
| courses.tsx:21 | "paid ahead … still to pay, on each procedure day" | Tiles: "Prepaid 2 sittings · ₹5,000 to pay over next visits" |
| courses.tsx:20 | "price locked" | "Price fixed" |
| courses.tsx:63 | "Only the owner approves this." | "Refund to patient (owner only)" |
| courses.tsx:97 | "The price is locked from this payment." | "After this payment the price can't change." |
| TestReports.tsx:161 | "Informed" | "Patient told" |
| TestReports.tsx:152 | "Review what is in" | "Review these now" |
| TestReports.tsx:131 | "Reviewing what is in · the rest is its own order" | "The rest will come as a separate report" |
| labs.tsx:46, 99 | "Investigation" | "Test" |
| labs.tsx:36 | flag chip "ok" | "normal" (the desk sees "normal" in ReportDialog) |

---

### 5. Inconsistent patterns

1. **Two call logs.** Worklist's Log a call (contactLog, 6 outcomes) and Follow-ups (`callback` table, 4 outcomes). They do not see each other (1.8).
2. **Two places to agree price and book.** `CourseDialog` (Front desk, patient record) vs `ScheduleModal` (Procedures). Only one bills (issue 1).
3. **Sitting status words differ** across ProcSchedule, procDrawer, procBoard (`SIT` map) and ScheduleModal (raw), e.g. "scheduled", "Booked", "confirmed" and "not confirmed" for the same state.
4. **Destructive confirmations are uneven.** Cancel asks; Missed, Mark done (sitting), Mark done (plan), Remove package and inline lab-value edits do not.
5. **Error states:** `procDrawer` shows an error, while ProcSchedule, Worklist, Board and TestReports do not.
6. **Navigation:** most links use `nav()`. "Open calendar" uses `<a href>`, which reloads the page (Worklist.tsx:50).
7. **The flag logic is written three times**: `flagFor`, inline in `LabValuesEditor`, and the server `flagOf`.
8. **Two upload dialogs with different rules.** The dead `ResultDialog` allows note-only; `ReportDialog` requires a file. One file input uses `capture` and the other does not.
9. **Doctor detection** is `!!me.practitionerId` in ProcSchedule.tsx:23 and `can('encounter.complete')` in TestReports.tsx:173. An owner who is also a practitioner behaves differently on each page.

---

### 6. Could not inspect / assumptions
- **Where a "due" sitting charge is actually collected.** I assumed `TakePayment` on `Patients.tsx` and did not read it. Nor did I check whether it nets an unused course advance.
- **The Follow-ups page UI** (`/followups`); only the server was read.
- **`PhotoCapture`** (photos.tsx) beyond its consent step. **The Calendar block rendering** that opens the drawer.
- **The server lab parameter list** (`src/lib/labs.ts` `findParam`/`numOf`) compared with `cfg.labParams`. I assumed they are the same list and that `numOf` strips commas the same way.
- **The `ui.tsx` primitives** (`ask`, `MoreMenu`, `Modal`): focus trapping, keyboard support and touch-target sizes were not verified.
- **Real-device behaviour** of `capture="environment"` + `multiple`. It is inferred from common Android Chrome behaviour, not tested.
- **The Today page "Reports" tile** beyond lines 124 and 182.
- **Nothing was run in a browser**: no screenshots, and no timing of the slots endpoint.


---

<a id="appendix-F"></a>
# Appendix F — Pharmacy and inventory

## Pharmacy and Inventory: UX and safety audit (code-read only)

Scope: `web/src/pages/Pharmacy.tsx` (Counter, Bills, the receipt print, `InventoryPage`), `web/src/pages/pharmacyStock.tsx` (Inventory: Stock, Batches, Orders, Receive, Counts, Vendors), `web/src/pages/pharmacyRegister.tsx` (Schedule register), and the server in `src/modules/pharmacy.ts` and `src/modules/stock.ts`.
Method: I read the code only. Nothing was run in a browser and no file in the repo was changed. Anything marked **ASSUMPTION** is inferred, not read.

Who sees what (from `src/lib/auth.ts:16-24` and `web/src/App.tsx:28-29,45`):
- **Pharmacist**: `pharmacy.*` (read, bill, return), `stock.read`, `stock.write`, `payment.record`. Lands on `/pharmacy`.
- **Owner**: `*`. Only the owner has `stock.approve`, which covers delivery decisions, write-offs, adjustments, count gaps, discounts above the cap, cancelling a whole bill, and voiding someone else's bill.
- Admin, doctor, reception and coordinator have neither `pharmacy.read` nor `stock.read`, so they see no Pharmacy or Inventory nav item.

---

### 0. Top findings (read this first)

| # | Sev | Finding | Where |
|---|---|---|---|
| 1 | **Critical** | **Schedule H/H1/X drugs can be sold with no prescription.** Nothing in the UI or on the server stops it. The register flags it afterwards ("NO PRESCRIPTION"). Worse, any extra item added to a prescription bill is written into the register under that doctor's name and registration number, as if the doctor had prescribed it. | `pharmacy.ts:243-313` (no schedule check); `pharmacy.ts:140-145` (`noRx: !s.encounterId` is per bill, not per line) |
| 2 | **Critical** | **A sale can be billed twice.** `POST /pharmacy/sale` has no idempotency key. On patchy internet the request can succeed while the browser times out; the pharmacist sees an error toast and taps Save again. That makes two bills and takes stock twice. The server also never checks `issuedQty + got <= prescribed`, so two counters can fill the same prescription. | `Pharmacy.tsx:368-380`; `pharmacy.ts:301-306` |
| 3 | **Critical** | **Refunds are easy to abuse.** (a) **Void** on the receipt fires with one tap: no confirmation and no reason. It records a refund to the original method, and for UPI it uses the original UTR as the "refund reference". (b) **Return** defaults the refund to *Cash* even when the bill was paid by UPI, has no age limit and needs no approval. Together these allow "patient paid by UPI, staff refunds cash to themselves". | `Pharmacy.tsx:316,330`; `Pharmacy.tsx:461,489`; `pharmacy.ts:192-202, 316-338` |
| 4 | **Critical** | **Returned items go straight back onto the sellable shelf.** That includes opened tubes and cold-chain items, which can then be sold to the next patient. The hint says to "take them back with an adjustment in Inventory", but the pharmacist cannot adjust stock (that needs `stock.approve`). | `pharmacy.ts:330`; `Pharmacy.tsx:492`; `stock.ts:205` |
| 5 | **Critical** | **The counter's quantity can disagree with the doctor's.** The counter ignores the doctor's saved `prescription_item.qty` and works the quantity out again with a different parser. A dose typed as a strength (for example "20 mg") multiplies the count. The pre-fill is capped only by stock on hand, so it can pre-fill the whole shelf. Quantities above the prescription get no warning (`step` caps at `onHand`, not at `left`). | `pharmacy.ts:16-26` vs `schema.ts:262` / `rxLine.ts:31-36`; `Pharmacy.tsx:64,130,266` |
| 6 | High | **Walk-in items join the wrong patient's bill.** Medicines tapped before a prescription is picked are silently merged into that patient's bill with no confirmation. They then appear in the register under that patient and doctor. | `Pharmacy.tsx:105,111-112` |
| 7 | High | **UPI needs a 12-digit UTR typed by hand.** There is no QR code with the amount and no "last 4 digits" shortcut. This is the slowest and most error-prone step of every sale. | `Pharmacy.tsx:366,387` |
| 8 | High | **Receiving is blocked when the bill does not match within ₹5.** There is no field for round-off, freight, cash discount or a bill-level discount, and Indian distributor bills almost always carry one of these. | `stock.ts:114`; `pharmacyStock.tsx:501` |
| 9 | High | **Near-expiry stock is sold silently,** even when it expires before the end of the course. Prescription lines do not show the batch or expiry at all. | `Pharmacy.tsx:263,272-273` |
| 10 | High | **The printed bill shows CGST/SGST even when the clinic has no GSTIN.** It has no rate-wise tax summary and is titled "Bill", not "Tax Invoice". | `Pharmacy.tsx:507-517` |

---

### 1. Screen inventory and issues

#### S1. Pharmacy page shell: tabs Counter / Bills / Register
`Pharmacy.tsx:29-49`. Seen by pharmacist and owner (`pharmacy.read`). Reached from the nav "Pharmacy", or as the pharmacist's landing page. Purpose: switch between selling, past bills and the legal register.
- **Low**: `?tab=stock|batches|orders|vendors` redirects to `/inventory` (`:37`). This is fine, but the pharmacist now has two nav items (Pharmacy and Inventory) for one job. *Load:* two places to remember. *Fix:* keep both, but show a small "Low stock: 4" link on the Counter that goes to Inventory.
- **Low**: the Register is a peer tab of Counter. It is used monthly, Counter is used every minute. *Fix:* move it into Bills as a "Schedule register" button, or keep it and order the tabs by frequency.

#### S2. Counter header stats ("prescriptions to fill today", "on this bill")
`Pharmacy.tsx:175-178`. Seen by pharmacist and owner. Purpose: show the queue size and the running bill total.
- **Medium**: the "on this bill" total is shown twice: here and as "To pay" in the bill panel (`:286`). Below the `xl` width the bill panel sits under the medicine grid, so this header number is the only total visible. *Load:* two totals, and you have to work out which one is real. *Fix:* on narrow screens make this a sticky bottom bar ("₹540 · 3 items · Take payment"). On wide screens drop it.

#### S3. Today's prescriptions (list, search, "Earlier prescriptions")
`Pharmacy.tsx:182-199`, cards at `:159-170`. Purpose: pick the doctor's prescription to fill.
- **High (wrong patient)**: a card shows only initials, name, OP number and doctor (`:166-167`). There is no age, sex or phone. Two "Lakshmi"s on the same day can only be told apart by OP number. *Load:* the pharmacist has to cross-check the OP number against the slip. *Fix:* show age/sex and the last 4 digits of the phone on the card. When the bill opens, show a one-line check: "Ask: name + last 4 of phone".
- **Medium**: the list is sorted newest first (`pharmacy.ts:47`, `desc(completedAt)`). The patient who has waited longest is at the bottom. *Fix:* oldest unfilled first, filled ones greyed at the end. Show the token number if the queue has one.
- **Medium**: status words are vague: "Add", "Partly here", "Not from us" (`:168`). *Fix:* "To fill", "Part given", "Bought elsewhere".
- **Medium**: drag-and-drop onto the bill (`:162-164`, `:232-234`) does not work with touch (HTML5 drag-and-drop) and doubles the one action, tapping. *Load:* the hint offers two ways to do the same thing. *Fix:* remove drag and keep tap.
- **Low**: search only covers the last 30 days (`pharmacy.ts:42`). A repeat prescription or refill older than that cannot be found. *Fix:* "Search older" link, or 90 days.
- **Low**: "Earlier prescriptions … Nothing is owed: the rest may have been bought outside" (`:195`) is a paragraph of policy. *Fix:* "Came back for the rest? Tap their prescription."
- States: loading uses Skeleton (good); empty is "No prescriptions yet today." (good); search empty is "No prescription in the last 30 days matches." (good). There is **no error state**: if `/pharmacy/counter` fails, the list just shows empty. **Medium**. *Fix:* "Could not load. Retry", plus a "last updated 10:42" stamp, because the list refreshes every 15 s.

#### S4. Medicines grid (search, Form filter, tiles)
`Pharmacy.tsx:201-227`. Purpose: add an over-the-counter or extra item by tap or by typing.
- **High (wrong drug)**: pressing Enter in the search adds `shown[0]`, the first alphabetical match (`:206`). "clob" + Enter can add the wrong clobetasol combination (a look-alike, sound-alike drug). *Fix:* Enter adds only when exactly one result matches. Otherwise use arrow keys to move a highlighted row, and show strength and form in the row.
- **High (schedule)**: the tile shows "Sch H" in 12 px grey (`:221`) and a tap adds it to a walk-in bill with no check. *Fix:* see Redesign A. An H/H1/X item on a bill with no prescription asks for the prescribing doctor and registration number, and the server refuses H1/X without one.
- **Medium**: the tile price is `m.mrpPaise` (the medicine master), but the bill charges the **batch** MRP (`:55`, `pharmacy.ts:269`). The price on the tile can differ from the price on the bill. *Fix:* show the FEFO batch's MRP on the tile.
- **Medium**: every tap adds one pack. A double tap adds 2, and the only feedback is a badge and an animation. *Fix:* the first tap adds 1 and focuses that bill line's quantity box.
- **Medium**: selling loose tablets is impossible. Quantity is always whole strips (`packLabel`, `prescribedQty`). Indian counters often sell 5 tablets. **ASSUMPTION**: batches are counted in packs. *Fix:* a per-medicine "sell loose" setting, with stock in units.
- **Low**: the `days < 0 ? 'expired'` branch (`:219`) can never fire, because the server drops expired batches (`pharmacy.ts:86`). This is dead code.
- **Low**: the 148 px tall tiles and the animated "fly" capsule (`:70-83`) are slow on low-end shared PCs and fit about 8 items per screen. *Fix:* a dense list (name · strength · MRP · stock · expiry) with tiles as an option.
- **Low**: "Nothing by that name. Add it under Settings → Medicines." The pharmacist cannot open Settings (`config.*` is owner/admin only). *Fix:* "Not in the list. Ask the owner to add it."
- **Medium**: there is no barcode support. A scanner types into whatever field has focus, and the search input does not focus when the page opens. *Fix:* autofocus the search; on Enter, match the scanned text to a barcode/HSN field (this needs a medicine barcode field; **ASSUMPTION**: none exists).

#### S5. "This bill" panel (lines, batch select, reason select, totals, discount, Take payment)
`Pharmacy.tsx:231-295`. Purpose: what is being sold, to whom, and for how much.
- **Critical**: over-issue. The quantity "+" is capped by stock (`:130,267`), not by `left`. Typing 10 against a 1-strip prescription gives no warning, and for H drugs (isotretinoin, steroids) this harms the patient. *Fix:* when qty > prescribed left, turn the line amber: "3 more than prescribed. Reason?". Require a reason for H/H1 items. Add a server check.
- **Critical**: the pre-filled quantity comes from `prescribedQty`, which differs from the doctor's `qty` (see top finding 5). *Fix:* use `prescription_item.qty` (converted to packs) as the only source of the quantity. Show "Doctor: 30 tabs = 3 strips".
- **High**: the walk-in to prescription merge (`:105`). Lines added before tapping a prescription are kept and moved onto the patient. `choose` only confirms when a *prescription* bill is already open (`:112`). *Fix:* if a walk-in bill has lines, ask "Add these 2 items to Lakshmi's bill, or keep them as a separate sale?".
- **High**: batch and expiry are hidden on prescription lines. The sub-line shows "2 strips prescribed · dose…" (`:263`), and the batch select only appears when there is more than one batch (`:273`). *Fix:* always show "B1234 · exp 03/27". Turn it red when expiry < today + course days, and require confirmation.
- **High**: allergy. The banner (`:246`) appears only for a prescription patient. A walk-in "Our patient" (S6) never shows allergies, and nothing matches allergy text against the medicine names. *Fix:* show the allergy line for any known patient, and highlight a line whose name contains an allergy word.
- **Medium**: a mismatch between the displayed and charged total. `lineAmount` = qty × the **selected** batch's MRP. The server splits a large quantity across batches, each at its own MRP (`stock.ts:47-55`, `pharmacy.ts:268-271`). If the MRPs differ, the payments do not add up and the sale fails with "PAYMENTS_DO_NOT_ADD_UP". *Fix:* compute the split on the client the same way (or price from a server preview call) and show two lines when it spills.
- **Medium**: discount is rupees only, with no reason and no owner-approve flow. Above the cap the button is just disabled with "Discounts above 10% need the owner." (`:151`). The owner has to log in on this PC. *Fix:* a ₹/% toggle, a reason chip (Staff, Senior citizen, Regular), and an "Ask owner" PIN or approval.
- **Medium**: below 1280 px (`xl:`) the bill panel comes **after** the full medicine grid (`:180`), so Take payment is a long scroll away on 1024/1280 counters and tablets. *Fix:* a sticky bottom bill bar on narrow screens.
- **Medium**: the problem text appears only when `issuing.length > 0` (`:289`). With a patient picked and 0 lines, the disabled button says nothing. *Fix:* always show why the button is disabled.
- **Low**: the per-line "Reason (optional)" select appears on every short prescription line (`:275`). That is fine, but "not from us" and "3 not taken" are cryptic. *Fix:* "Not given · reason (optional)".
- **Low**: the 28 px +/− buttons and 32 px quantity box (`:265-267`) are below the 44 px touch target. The "Rx" chip is 10.5 px.
- **Low**: "Rounding": no round-off to the nearest rupee. Cash totals like ₹1,234.56 are awkward. *Fix:* round the cash total to ₹1 and print the round-off.
- Empty state "Tap or drag to start" (good, minus the drag). Loading: Skeleton (good).

#### S6. Walk-in customer picker ("Our patient" / "New customer")
`Pharmacy.tsx:336-355`. Purpose: name the buyer of a sale with no prescription.
- **High (flow + data)**: a name of 2+ characters is required for every over-the-counter sale (`:340`), and the default mode is "Our patient" search (`:337`). Selling a sunscreen means switching tabs and typing a name, and every sale **creates a patient record** (`pharmacy.ts:250`), filling the patient list with "Cash" and "abc". *Fix:* the default customer is "Walk-in" with no record. Ask for name and phone only when the bill holds an H/H1 item (required by law) or the customer wants a WhatsApp bill.
- **Medium**: search results show name, patient number and phone, with no age. That is the same wrong-patient risk as S3.
- **Low**: there is no "no results" or loading feedback in the search (`:347`).
- **Low**: the age box is 76 px wide and its placeholder is just "Age".

#### S7. Allergy alert
`Pharmacy.tsx:246`. A good red `role="alert"`. **High**: only on prescription bills (see S5). **Low**: "Check anything you add before you sell it" puts the work on the user. *Fix:* match automatically.

#### S8. Confirm dialogs on the Counter
- "Start {name}'s bill?" (`:113`): good wording.
- "Clear this bill?" (`:133`): good, danger tone.
- "Buying elsewhere?" (`:292`) and "Rest bought outside?" (`:293`): **Low**. Two near-identical buttons whose label depends on status, and "Not buying here" vs "Rest bought outside" need thought. *Fix:* one button, "Patient won't buy the rest here", with reason chips (Has at home / Too costly / Will buy outside).
- **Medium**: "Not buying here" is a full-width ghost button right under "Take payment" (`:290-292`). A slip of the thumb marks the whole prescription as not bought. It is undoable only by billing it (**ASSUMPTION**: there is no undo endpoint). *Fix:* put it in an overflow menu.

#### S9. Take payment dialog
`Pharmacy.tsx:358-405`. Purpose: record cash, UPI, card or split, plus print and WhatsApp.
- **Critical**: double billing on retry (top finding 2). `disabled={save.isPending}` only guards double taps, not timeouts. *Fix:* the client generates a `saleKey` (uuid) when the dialog opens. The server uses a unique index on (tenant, saleKey) and returns the existing sale on repeat.
- **High**: UPI needs a 12-digit UTR typed by hand (`:366,387`). *Fix:* show the clinic's UPI QR code with the amount filled in (upi://pay?am=…). Then either type the last 4 digits of the UTR or tick "Seen on patient's phone" (owner can require the full UTR). See Redesign B.
- **Medium**: Cash is always the default (`:359`). It does not remember the last method or the patient's usual one.
- **Medium**: the mode toggles lack `type="button"` and `aria-pressed` (`:384`, `:402`), so screen readers do not announce the selected mode.
- **Medium**: the checkbox "WhatsApp to 98xxxxxxx" defaults on (`:361`). The message lists every medicine (`pharmacy.ts:310`). On a shared family phone this discloses, for example, isotretinoin. **Medium (privacy)**. *Fix:* the message carries only the bill number, total and a link.
- **Low**: "Save bill" → "Paid ₹540 · Save". "Back to items" is fine.
- **Low**: the problem message appears only after the first click (`tried`). That is fine, but the Save button looks enabled even when there is a problem.

#### S10. "Payment taken" receipt modal (+ Void)
`Pharmacy.tsx:315-333`. Purpose: confirmation, reprint, next sale.
- **Critical**: **Void** has no confirmation and no reason (`:330`). The tooltip is the only explanation, and it is a ghost button next to Print. *Fix:* confirm with a red dialog: "Undo PH-00123? ₹540 refunded by UPI. Reason: [Wrong patient][Wrong item][Other]". For UPI/card require a *new* refund reference instead of reusing the UTR (`pharmacy.ts:200`).
- **Medium**: two modals stack. With Print ticked, `printSale` opens the print-preview modal (`printPreview.tsx:13-30`) on top of this one, and the preview needs another "Print" click, then the browser dialog, then two closes. *Fix:* send the print straight to a hidden iframe, so the bill prints and the receipt modal is the only modal.
- **Low**: clicking outside or pressing Esc (`onClose={onNew}`) starts a new sale. That is fine, but it is not announced.
- **Low**: "Rx · " prefix on lines. *Fix:* use a "Prescribed" tag.

#### S11. Printed pharmacy bill (print view)
`Pharmacy.tsx:504-520`. Opened from Save (Print ticked), Print, and Reprint.
- **High (GST)**: CGST and SGST are always printed as `floor(gst/2)` (`:507,513`), even when `clinic.gstin` is null (an unregistered clinic must not collect GST and issues a "Bill of Supply"). There is no rate-wise summary (5%/12%/18% lines in one bill), no "Tax Invoice" title, and no inter-state IGST. *Fix:* if there is no GSTIN, print "Bill of Supply" with no tax lines. Otherwise print "Tax Invoice" with a table of taxable value, CGST and SGST for each rate.
- **Medium (H1)**: there is no prescriber registration number on the bill. Indian practice for H/H1 sales expects the prescriber's name and registration number. The doctor's name is printed, but not `regNo`. *Fix:* add it.
- **Medium**: the page is `max-width:420px` with no `@page` size. On A4 it prints a narrow strip; on an 80 mm thermal printer it overflows. *Fix:* a setting for "80 mm thermal" or "A5", with `@page` set to match.
- **Medium**: no round-off line, and there is no amount in words.
- **Low**: the drug licence is read from `settings.drugLicence` (`pharmacy.ts:122`), but the Register reads `settings.print.drugLicence ?? settings.drugLicence` (`Pharmacy.tsx:46`). A licence set only under print settings is missing from bills.
- Good: batch, expiry and HSN on each line; payments; "Not taken today".

#### S12. Bills tab (totals tiles, table, filters, custom dates)
`Pharmacy.tsx:414-451`. Purpose: today's bills, the cash drawer figure, and finding a bill to reprint or return.
- **Medium**: the "Bills" tile shows `total - refunds`, labelled just "Bills" (`:434`). *Fix:* "Net sales".
- **Medium**: the "Bought elsewhere or not at all" tile carries the sub-label "prescriptions **today** · not a task, for the doctor to know" (`:435`). It is wrong when the range is a week, and it is not for the pharmacist. *Fix:* remove it from this role; it belongs on the doctor's report.
- **Medium**: "Cash in drawer should be" ignores opening float (**ASSUMPTION**: no float field). There is no "Close drawer / count cash" step.
- **Low**: the "Paid by" column is an uppercase method; a split shows "UPI + CASH". That is fine.
- States: DataTable loading and empty states are good. A bad date range gives "Check the dates". Fetch errors are not shown (**ASSUMPTION**, based on DataTable).

#### S13. Bill detail: Reprint, Issue the rest, Return items, Cancel whole bill
`Pharmacy.tsx:453-501`. Seen by pharmacist and owner. Return needs `pharmacy.return`; Cancel is owner only.
- **Critical**: the refund method defaults to Cash whatever the original payment (`:461`). There is no time limit, no approval and no limit on the refund amount (`pharmacy.ts:187-190`). *Fix:* default to the original method. Refunding to a different method, or a bill older than N days, needs the owner. See Redesign C.
- **Critical**: stock goes back to the same batch automatically (`pharmacy.ts:330`), and opened items cannot be quarantined by the pharmacist. *Fix:* each line gets "Back on shelf? ( ) Yes, sealed  ( ) No, discard". "No" posts a write-off to a pending-approval list.
- **Medium**: there is no credit note print. The toast "Credit note CN-0003 · refund ₹120" is the only record handed over. *Fix:* auto-print a credit note.
- **Medium**: "Cancel whole bill" (owner) uses the Refund-by select from the return form above it, which defaults to Cash (`:465,495`). The owner may not notice. *Fix:* put the method inside the cancel dialog.
- **Low**: "Reason" is a datalist, so free text is allowed. That is fine.
- **Low**: on mobile the close button is an "x" icon labelled "Back to bills" (`:473`). Use "← Bills".
- **Low**: an empty Return quantity shows "0" as a placeholder, while the refund column shows "—". That is fine.

#### S14. Schedule H / H1 / X register (+ print, CSV)
`pharmacyRegister.tsx:25-61`; server `pharmacy.ts:129-151`. Seen by pharmacist and owner. Purpose: the legal register for an inspector.
- **Critical**: lines that were not prescribed are attributed to the prescriber. `noRx` is per bill (`pharmacy.ts:144`), so any H drug added to a prescription bill shows the doctor and registration number. *Fix:* `noRx = !l.prescriptionItemId`, plus the Rx-time block in S5.
- **High**: the after-the-fact banner, "{n} entries were sold with no prescription on file… check those bills" (`:50`), cannot be acted on. There is no link to the bills and no way to attach a prescription. *Fix:* block at sale time (S5). For past entries, make each a link to its bill.
- **Medium**: medicines with no schedule class set are silently absent. The empty-state hint mentions Settings → Medicines, which the pharmacist cannot open. *Fix:* show "12 medicines have no schedule set" to the owner.
- **Medium**: H1 and X need their own registers kept separately (**ASSUMPTION**, based on Indian rules). The default is "All schedules" mixed. *Fix:* default to H1 and print one register per class.
- **Low**: the "Address" column uses `patient.locality` (`pharmacy.ts:136`), often blank. H1 entries need the patient's address. *Fix:* require locality when billing H1.
- **Low**: "Reg. no." and "Class" are jargon-light and fine. The legally required "prescriber address" is missing (**ASSUMPTION**).

#### S15. Inventory shell: stat chips and tabs
`pharmacyStock.tsx:40-64`. Seen by pharmacist and owner (`stock.read`). Purpose: what needs attention.
- **Medium**: the chips read "Lines at or under reorder", "Expired or within 90 days, at cost", "Orders on the way" and "Deliveries waiting for a decision" (`:49-52`). "Lines" and "at cost" are jargon. *Fix:* "4 medicines running low", "₹3,200 expiring in 90 days", "2 orders due", "1 delivery for owner".
- **Low**: "Deliveries waiting for a decision" (`:52`) goes to `tab:'stock'`, the page you are already on. It should scroll to the review table.

#### S16. Stock tab: "Deliveries waiting for a decision" table and the medicine table
`pharmacyStock.tsx:66-109`.
- **Medium**: status precedence `out > expiring > low` (`stock.ts:167`). A medicine that is low **and** expiring shows only "expiring", so the "Running low" filter misses it. *Fix:* keep separate flags and use two chips.
- **Medium**: the Count button shows for anyone with `stock.read` (`:88`), but the server needs `stock.write`. It is fine for current roles but wrong for custom roles.
- **Low**: "Next out" → "Expires first". "Cost value" → "Stock value at cost".
- **Low**: the review table header "What differs from the order" chips can be long. That is fine for the owner.

#### S17. Delivery decision dialog
`pharmacyStock.tsx:171-200`. Owner decides; pharmacist sees "Waiting for the owner to decide." Reached from Review in S16, a delivery row in Orders, or Vendor account.
- **Medium**: the three options are long sentences of procurement jargon ("vendor owes the free units", "debit note"). *Fix:* "Pay as billed, chase free goods later" / "Pay agreed rate, ask ₹120 back" / "Accept as is". Show the ₹ effect first.
- **Low**: defaults to "owe" with no explanation. That is fine.

#### S18. Batches & expiry: "Expiry runway" chart and "Expired on the shelf"
`pharmacyStock.tsx:112-168`.
- **Medium**: the runway Gantt (`:141-153`) is a lot to read: bars, ticks, a today line and numbered badges to answer "what expires next?". *Load:* more than 5 s. *Fix:* lead with a plain list, "Expiring this month / next 3 months" (medicine, batch, qty, date, action), and keep the chart optional.
- **Medium**: the pharmacist can only "Return" expired stock. "Take off" is owner only (`:161`). Expired stock with no vendor (opening stock) is stuck on the shelf, though it is excluded from sale. *Fix:* the pharmacist marks it "Moved to expired bin" (quarantine) and the owner approves the write-off.
- **Low**: the empty hint "Switch to Everything to see every batch." does not match the option label "Every batch" (`:138,141`).
- **Low**: there is no near-expiry policy setting, such as "do not sell within 30 days of expiry".

#### S19. Medicine detail (ItemView): tiles, batches, movements, Adjust
`pharmacyStock.tsx:202-251`.
- **Medium**: "Margin at MRP" = (MRP − cost)/MRP, where MRP includes GST and cost excludes it (`:210`, `stock.ts:103`). The margin is overstated by the GST rate. *Fix:* compare like with like.
- **Medium**: Adjust is two chained text prompts. The first takes free-text "Change (+ or -)" (`:215-219`), so a typed "−" (Unicode minus) or "-1 strip" fails. *Fix:* one dialog with a ± stepper and reason chips.
- **Low**: "Order more" does not pre-fill this medicine (`:226`), while "Reorder" in the list does (`:89`). This is inconsistent.
- **Low**: "Real cost per pack · Average, free units included" → "Cost per pack after free goods".

#### S20. Return to vendor dialog
`pharmacyStock.tsx:253-275`.
- **Medium**: opened from a Vendor account, the medicine list comes from `/pharmacy/medicines`, which drops expired batches (`pharmacy.ts:86`). Expired stock, the main reason for vendor returns, cannot be picked there. *Fix:* use `/stock` batches, including expired ones.
- **Medium**: no vendor is pre-filled from ItemView, though each batch knows its vendor (`:248`). Nothing checks that the batch came from the selected vendor.
- **Low**: no debit-note print.

#### S21. Stock count (CountView) and gap cards
`pharmacyStock.tsx:277-339`; server `stock.ts:357-410`.
- **High (stock accuracy)**: the system figure is taken at **submit** time (`stock.ts:378`), and the correction applied at approval is `counted − system` from that snapshot (`stock.ts:404`). Sales between counting the shelf and submitting, or between submitting and owner approval, create false gaps and wrong corrections, and the counter stays open throughout. *Fix:* snapshot per line when that line is typed, and at approval apply `counted − (system at count) + sales since`, or use a "freeze while counting" banner.
- **Medium**: the UI can only start a count for one medicine (`:71,88`), and only one count can be open (`stock.ts:359`). There is no "count everything" or "count a shelf". *Fix:* a "Start full count" button for the owner.
- **Low**: "Who sold from this batch" (`:333`) suggests blame. That is fine for the owner but sensitive; hide it from the pharmacist.

#### S22. Orders tab: order cards, deliveries and returns tables
`pharmacyStock.tsx:343-394`.
- **Medium**: there is no on-page "Receive delivery" entry for a delivery with no order. It is only in the "+" menu (`palette.tsx:20`). In India most distributor deliveries arrive without a formal PO. This respects the "no duplicate page actions" rule; the "+" menu already lists it first on `/inventory`. *Fix:* keep it in "+", but put a one-line empty or help hint in this tab: "Delivery without an order? Use + → Receive a delivery".
- **Low**: the filter "Purchase orders / Deliveries / Returns to vendors" sits under a tab called "Orders". It is a three-in-one view, and its labels mix PO jargon.
- **Low**: Cancel only shows while the order is `open`, not `part`, and nothing says why.

#### S23. Order or return detail (DocDialog)
`pharmacyStock.tsx:396-405`. Read-only. **Low**: the "Free" and "Batch" column swap by kind is confusing. There is no print or resend to WhatsApp.

#### S24. New purchase order (OrderEditor)
`pharmacyStock.tsx:409-472`.
- **Medium**: the "Order qty" unit is unclear (strips? boxes?), and vendors quote by box. **ASSUMPTION**: there is no unit field. *Fix:* show "strips of 10" next to the quantity.
- **Medium**: a scheme text the parser does not understand gives "Free 0" silently (`:418`). *Fix:* flag "Could not read this offer. Write it as 10+1".
- **Low**: the table is 940 px wide, so it scrolls sideways on small screens. "Save and send on WhatsApp" is primary even when the vendor has no phone. The hint below says so, but the button should change to "Save".
- Good: last-paid comparison, amber "above last time", the vendor message preview.

#### S25. Receive stock (ReceiveView), against an order or not
`pharmacyStock.tsx:476-567`; server `stock.ts:76-152`.
- **High**: the ₹5 bill-total tolerance blocks saving (`:501`, `stock.ts:114`), and there is no line for round-off, freight, cash discount or bill-level scheme. *Fix:* add "Bill adjustments (round-off / CD / freight) ₹ ±". Above ₹5 it warns and the receipt goes to owner review instead of being blocked.
- **High (MRP)**: MRP is pre-filled from the medicine master (`:489,544`). A new batch with a revised MRP printed on the box gets the old MRP unless someone notices. That breaks the law if it is higher and loses money if it is lower. *Fix:* MRP starts **empty** for a new batch ("type the MRP printed on the box"), or turns amber when it differs from the last batch.
- **Medium**: 11 columns at a minimum of 1060 px. A low-end screen scrolls sideways while typing batch numbers. *Fix:* one card per line on narrow screens, keyboard order Batch → Expiry → Qty → Free → MRP, with rate/discount collapsed when they match the order.
- **Medium**: Expiry uses `<input type="month">` (`:538`). Firefox and older Safari fall back to a plain text box that expects "YYYY-MM", but boxes print "MM/YY". *Fix:* a text input with an MM/YY mask.
- **Medium**: the bill photo is mandatory and uploaded as base64 JSON up to 10 MB (`:507-508`, `stock.ts:121-123`). On patchy internet this fails often and has no progress indicator. *Fix:* shrink images on the client to about 300 KB, show upload progress, and allow saving with the photo attached later (owner notified).
- **Low**: `calc.some((c) => c.rate < 0)` (`:501`) can never be true, so a missing (0) rate passes, and for opening stock the cost is ₹0, which skews the margin.
- **Low**: a WhatsApp message is always sent to the vendor on receipt (`stock.ts:150`), with no opt-out.
- **Low**: there is no barcode or QR scan of the vendor's e-invoice.
- Good: "Save receipt · stock goes on the shelf", the amber "under 6 months" warning, the duplicate bill-number guard (`stock.ts:88-89`), and blocking expired batches (`stock.ts:99`).

#### S26. Vendors: list, account, add/edit dialog, write-off
`pharmacyStock.tsx:571-652`.
- **Medium**: account tiles use jargon: "Paid above promise, 6 months" and "Free received on the day, 6 months". *Fix:* "Overcharged vs agreed (6 mo)" and "Free goods received on time".
- **Low**: the empty state "Add your first vendor" has no action, so the user must know about "+" (`:586`). *Fix:* the hint reads "Use + → Add a vendor".
- **Low**: Edit is `btn-sm` while Return and New order are full size (`:625`).
- **Low**: GSTIN is checked for length only, not format.

#### Toasts (all surfaces)
Toasts are short and plain. "Saved PH-00012 · ₹540 · give change ₹60" (`Pharmacy.tsx:374`) is good, but **Medium**: the change amount disappears with the toast. Show it large in the receipt modal. "Noted: not buying here" is fine. Errors go through `errText`, which has good plain mappings (`api.ts:57-81`).

---

### 2. Redesign sketches (Critical/High screens)

#### A. Counter: one column of truth, verification and the schedule gate
```
+-- Prescriptions to fill (oldest first) ------+ +-- BILL: Lakshmi R, 34F, ..4521 ------+
| [Lakshmi R 34F ..4521  OP-112  Dr A  3 to fill]| | ! Allergic to sulfa                  |
| [Ravi K    52M ..9033  OP-109  Dr A  1 to fill]| | Isotretinoin 20mg  Rx 3 strips  [3]  |
|  search: name / phone / OP   [scan]            | |   B2231 exp 02/27  ok      ₹960      |
+------------------------------------------------+ | Mometasone cream   Rx 1      [1]     |
| Add item: [type or scan______________]  Enter  | |   B771 exp 12/26 ! ends before course|
|  Cetirizine 10mg  tab  ₹30  42 left  exp 08/27 | | + Sunscreen (not prescribed)  [1]    |
|  Clobetasol 0.05% crm ₹85 9 left  Sch H  ...   | | ------------------------------------ |
+------------------------------------------------+ | Total ₹1,450   Discount [ ₹ | % ]   |
                                                    | [ UPI ₹1,450 ] [ Cash ] [ Card ] [..]|
                                                    +--------------------------------------+
Walk-in + Sch H item -> inline: "Prescribed by? [Dr ____] Reg no [____]" (H1/X: required)
```

#### B. Payment: UPI with a QR code, no 12-digit typing
```
+-- Lakshmi R · ₹1,450 -------------------------------+
| [UPI]  Cash   Card   Split                          |
|  +--------+  Scan to pay ₹1,450 (amount pre-filled) |
|  |  QR    |  UTR last 4 digits [____] (optional*)   |
|  +--------+                                         |
|  [x] Print   [x] WhatsApp bill link (..4521)        |
|                         [ Paid · Save bill ]        |
+-----------------------------------------------------+
* owner setting: full UTR required / last 4 / none
```

#### C. Return or undo a bill (anti-abuse)
```
+-- Return from PH-00123 (paid UPI ₹1,450, 2 days ago) ------+
| Item              Sold  Return  Back on shelf?    Refund   |
| Mometasone cream   1     [1]    (o) Sealed ( ) Discard ₹110 |
| Reason: [Wrong item] [Doctor changed] [Other..]            |
| Refund to: UPI (as paid)  ref [________]                   |
|   Different method or > 7 days -> "Needs owner" (PIN)      |
|                 [ Return ₹110 · print credit note ]        |
+------------------------------------------------------------+
Void (<=10 min) uses the same dialog, all lines pre-filled.
```

#### D. Receive delivery: fast row entry with adjustments
```
Vendor [Sri Pharma v]  Bill no [____]  Date [10/11/26]  Bill total [₹____]  Photo [cam]
+ Medicine        Batch   Exp(MM/YY) Paid Free  MRP on box  Rate   Check +
| Doxy 100 (PO)  [____]  [__/__]    [20] [2]  [____]       42.00  ok    |
| Iso 20 (PO)    [____]  [__/__]    [10] [0]  [____]      310.00  -1 free
+---------------------------------------------------------------------+
Lines ₹9,812   Round-off/CD/freight [± ₹____]   = ₹9,810  matches bill
                                         [ Save · stock on shelf ]
(mismatch > ₹5 -> saves, goes to owner review; never blocks)
```

---

### 3. Core flows: clicks today and proposed

Counting taps, clicks and typing steps from landing on `/pharmacy`.

**(a) Dispense a doctor's prescription and take UPI.**
Today: tap the prescription card (1) → [check the lines] → Take payment (2) → UPI (3) → focus the UTR box (4) + type 12 digits → Save bill (5) → print preview opens: Print (6) → browser print OK (7) → close preview (8) → New sale (9).
**That is 9 actions plus 12 digits.** If the prescription is not in today's list, add a search (2 more).
Proposed (Redesign A+B): tap the prescription (1) → "UPI ₹1,450" on the bill (2) → patient scans → "Paid · Save" (3), which prints silently and sends the WhatsApp link. **3 actions; the last-4 UTR is optional.**

**(b) Over-the-counter sale (sunscreen, cash).**
Today: type the name + Enter (1) → "New customer" (2) → type a name (3) [required; creates a patient] → Take payment (4) → Save bill (5) → Print (6) → print OK (7) → close preview (8) → New sale (9).
**9 actions, and every sale creates a junk patient record.**
Proposed: scan or type + Enter (1) → "Cash" (2) → "Paid" (3). The customer defaults to Walk-in, and a name is asked only for H/H1 items or a WhatsApp bill. **3 actions.**

**(c) Receive a delivery against an order (5 lines).**
Today: Inventory (1) → Orders tab (2) → Receive on the card (3) → bill number (4) → bill total (5) → photo (6–7, picker) → for each line: batch (1) + expiry month picker (2–3) + check MRP (1) = about 5 × 5 = 25 → Save (1).
**About 33 actions.** It can be **blocked outright** by a round-off difference over ₹5.
Proposed (Redesign D): Inventory → the "1 order due" chip (2) → bill number, total and photo (3) → for each line: batch, MM/YY and MRP typed in one Tab run (3 × 5 = 15) → Save (1). **About 21 actions, never blocked.**

---

### 4. Jargon and microcopy (current text → plain proposal)

| Where | Current | Proposed |
|---|---|---|
| Inventory chip `pharmacyStock.tsx:49` | "Lines at or under reorder" | "Medicines running low" |
| `:50` | "Expired or within 90 days, at cost" | "Expiring in 90 days (₹ at cost)" |
| `:52` | "Deliveries waiting for a decision" | "Deliveries for the owner to check" |
| Stock col `:85` | "Next out" | "Expires first" |
| `:86` | "Cost value" | "Stock value (cost)" |
| Item tile `:230` | "Real cost per pack" | "Cost per pack after free goods" |
| Doc numbers `stock.ts:119,282,343,364` | "GRN-0001", "PO-0001", "RT-0001", "CNT-0001" | "Delivery 1", "Order 1", "Vendor return 1", "Count 1" (keep codes small) |
| Credit note `pharmacy.ts:327` | "CN-0001" / "Credit note" | "Refund slip 1" |
| Order editor `:441` | "Scheme promised" | "Free offer (e.g. 10+1)" |
| Receive `:528` | "Billed qty" / "Free got" / "Rate on bill" | "Paid qty" / "Free qty" / "Price per pack (before GST)" |
| Decision `:190` | "Pay the promised rate, vendor owes the free units" / "debit note" | "Pay agreed rate; ask vendor to return ₹X" |
| Vendor tiles `:628-629` | "Paid above promise, 6 months" / "Free received on the day" | "Overcharged vs agreed (6 mo)" / "Free goods received with the bill" |
| Batches `:137` | "Expiry runway" | "When each batch expires" |
| Batches hint `:141` | "Switch to Everything…" | "Switch to Every batch…" |
| Counter card `Pharmacy.tsx:168` | "Add" / "Partly here" / "Not from us" | "To fill" / "Part given" / "Bought elsewhere" |
| Bill line `:262` | "Rx" chip | "Prescribed" |
| `:274` | "not from us" / "3 not taken" | "Not given" / "3 not given" |
| Tile `:221` | "Sch H" | "Rx needed (H)" |
| Pay `:387` | "UPI reference (UTR)" / "12-digit UTR" | "UPI transaction no. (on the patient's phone)" |
| Pay `:390` | "Card approval code" | "Approval code on the card slip" |
| Pay `:402` | "Save bill" | "Paid · Save bill" |
| Receipt `:330` | "Void" | "Undo this bill" |
| Bill detail `:489` | "Card reversal" | "Back to the card" |
| Bills tile `:434` | "Bills" | "Net sales" |
| Bills tile `:435` | "Bought elsewhere or not at all … not a task, for the doctor to know" | remove for pharmacist |
| Medicines empty `:210` | "Add it under Settings → Medicines." | "Not in the list. Ask the owner to add it." |
| FEFO | "Each sells from the batch that expires first" (`:202`) | good, keep (never show "FEFO") |

---

### 5. Inconsistent patterns
- **Confirmations**: Void and Return have **none**, while Cancel bill, Take off, Cancel order and Write-off use `ask()`. Money-out actions are the ones without one.
- **Expiry format**: "MM/YY" (`exp()`), "exp 15 Nov" (tile, `shortDay`), and `fmtDate` "15 Nov" (Batches) all appear in one flow.
- **`rupees2`** includes "₹" in `pharmacyStock.tsx:11` but not in `Pharmacy.tsx:16`.
- **Validation reveal**: live (Counter `:289`), after the first submit (PayDialog `tried`), on typing (ReturnDialog `:270`), and only when lines exist (BillDetail `:493`).
- **Reorder vs Order more**: one pre-fills the medicine and the other does not (`:89` vs `:226`).
- **Back navigation**: "← Stock" / "← Orders" text links vs an "x" icon in Bill detail.
- **Drug licence setting** path differs between the bill and the register.
- **Quantity rule**: the doctor's pad (`rxLine.ts:qtyFor`) and the counter (`pharmacy.ts:prescribedQty`) use two different parsers.
- **Section switchers**: Pharmacy uses Segmented pills and Inventory uses underline Tabs (`ui.tsx` says this is deliberate), but the Orders tab nests a third switcher (`Filter`) and the Vendor account a fourth.

### 6. Server guard checklist

| Guard | Status |
|---|---|
| Right Rx to right patient | **Yes**: `RX_NOT_FOR_PATIENT` (`pharmacy.ts:257`), `NOT_ON_THIS_RX` (`:259`). It does not check that the medicine matches the prescription line's medicine (API only; Low). |
| Expired batch blocked | **Yes**: `allocate` and the lists filter `expiry >= today` (`stock.ts:48`); expiry is stored as the month end. |
| Near-expiry warning | **No.** |
| FEFO | **Yes**: ordered by expiry then createdAt; a chosen batch goes first and spills into the next (`stock.ts:47-55`). |
| Negative stock | **Yes**: row lock and check in `moveStock` (`stock.ts:34-36`). |
| Over-dispense vs Rx | **No**: there is no `issuedQty + got <= prescribed` check (`pharmacy.ts:301-306`). |
| Schedule H/H1/X needs Rx | **No.** |
| Idempotent sale | **No.** |
| GST | Tax-inclusive MRP, with discount reducing tax proportionally (`pharmacy.ts:279-280`). Good. The print side is wrong (S11). |
| Discount cap | **Yes**: 10% default, with the owner exempt (`pharmacy.ts:109,276`). There is no reason or approval flow. |
| Returns | Cannot exceed what was sold (`:323`). Refund method is free, there is no age limit and no restock choice. |
| Void | Own bill only, within 10 minutes, no returns, not split (`:195-199`). There is no reason and no new refund reference. |
| Count correction | Applied from a stale snapshot (`stock.ts:378,404`). |
| Duplicate vendor bill | **Yes** (`stock.ts:88-89`). |
| Audit | Every POST goes through `route()` → `writeAudit` (`route.ts:14-21`); the register export is audited (`audit.ts:107`). |

### 7. Could not inspect
- I could not see the running UI, actual rendering, the low-end device experience, print output on a real thermal or A4 printer, or the WhatsApp outbox delivery.
- I did not read `DataTable` (`web/src/table.tsx`) internals: error states, paging, and the touch behaviour of filters.
- I did not read the `ask()` and `Modal` implementations (focus trap, Esc, keyboard Enter).
- I did not read Settings → Medicines: whether barcode, generic name, strength, unit and schedule fields exist.
- I did not check whether `/patients?q=` returns allergies (this affects S6).
- I did not read the Rx pad's dose field UI, so I could not confirm whether doctors can type "20 mg" into dose (top finding 5 is partly an **ASSUMPTION**).
- I did not read the legal text of the Drugs and Cosmetics Rules for the exact H1/X register columns; those points are marked **ASSUMPTION**.


---

<a id="appendix-G"></a>
# Appendix G — Owner / admin

## UX audit: owner / admin area (Cubott OPD)

Scope: `web/src/pages/{Dashboard,Reports,Expenses,Settings,SettingsPad,SettingsScheduling,SettingsTemplates,Roles,Privacy}.tsx`, `web/src/settings.css`, with server checks in `src/modules/{admin,security,overview,dayclose,identity,billing,sample}.ts`, `src/lib/{auth,audit,route}.ts`, `src/app.ts`. I read the code only and did not run the app. Anything I inferred is marked **ASSUMPTION**.

Roles that matter here (src/lib/auth.ts:17-26):
- **owner** has `*`.
- **admin** has `config.*, user.*, report.*, finance.*, expense.*, patient.*, appointment.*, visit.*, payment.*, fees.*, day.close, message.broadcast, document.read`.
- **receptionist** has `report.daily, expense.read/write`, plus the desk permissions.
- **doctor** has `report.read, fees.see`.
- **assistant** (junior doctor) does NOT have `fees.see`.

Landing (App.tsx:38-47): an owner has `*`, so `encounter.complete` is true and the owner lands on **/today**, not the Dashboard. An admin has `visit.write`, so an admin lands on **/queue**. Neither money role lands on a money screen.

---

### 0. Top findings (read this first)

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| 1 | **Critical** | **An admin can make themselves (or anyone) Owner.** `PATCH /admin/users/:id` and `POST /admin/users` only check that the role key exists (`checkRoles`, admin.ts:75-78). `mayGrant` guards role *permission* edits only (admin.ts:86), never role *assignment*. The UI offers the "Owner" chip to admins (Settings.tsx:224). Owner = `*` = privacy settings, test-data wipe, IP lock. | admin.ts:56-72, Settings.tsx:224 |
| 2 | **Critical** | **The owner can be locked out.** (a) An admin can edit the owner's account: change their email or password, untick Active, or remove the Owner role. Only *self*-deactivation is blocked (admin.ts:66). (b) An owner can remove their own Owner role in the user modal. Nothing stops "last owner loses owner". (c) There is no "forgot password" and no self-service password change anywhere (grep finds no route). The Roles tab text "you can never lock yourself out" (Roles.tsx:62) is false. | admin.ts:64-72, Roles.tsx:62 |
| 3 | **Critical** | **"Test data" can wipe a real clinic.** It is owner-only, but it is shown to every owner on every clinic: there is no tenant-kind or env guard (sample.ts:32-35). Typing RESET deletes every patient, visit, bill, payment and photo (sample.ts:12-26). The group header "Only on a test clinic." (Settings.tsx:45) is only a label. | Settings.tsx:45-47, 478-501; sample.ts:32 |
| 4 | **Critical** | **Two different "Collected" totals for the same day on the same page.** Daily report → Collected = the `payment` table only (billing.ts:206-207), which excludes pharmacy counter sales. End of day → `dayFigures` includes pharmacy sales and returns (dayclose.ts:30-36). An owner reconciling cash/UPI sees two numbers with no explanation. | Reports.tsx:30, billing.ts:204-224, dayclose.ts:25-45 |
| 5 | **Critical** | **Prices leak to roles without `fees.see`.** `GET /config` returns every fee category amount, medicine MRP and procedure price to every signed-in role (identity.ts:55-73). The junior-doctor role is documented as "prices, amounts due and revenue are hidden" (auth.ts:59). It also returns `tenant.settings.display.token`, the waiting-room screen secret, to every role (identity.ts:69-70 strips only `security`). | identity.ts:55-73 |
| 6 | **High** | **Deactivating a doctor, fee, procedure or room cannot be undone from the UI.** `/config` returns only `active = true` rows (identity.ts:60-66), and the Settings lists are built from `cfg`. Untick "Active", Save, and the row vanishes from Settings for good. | Settings.tsx:215, 332, 429, 461 |
| 7 | **High** | **The consult fee lives in two places, and one is fake.** Visit types have a "Fee (₹)" (SettingsScheduling.tsx:99), but check-in charges `feeCategory.amountPaise` (visits.ts:108). Changing the visit-type fee changes nothing that is billed (**ASSUMPTION**: no other code reads `service.pricePaise` for billing; grep found none). | SettingsScheduling.tsx:99, Settings.tsx:337 |
| 8 | **High** | **Fee change has no confirmation, no "from when", and the audit shows paise.** Save applies the change immediately for everyone, mid-day (Settings.tsx:341). The audit row reads "Changed a fee" with no name or amount (audit.ts:131-133). The detail modal shows raw `amountPaise 50000` (Privacy.tsx:282-293), which an owner reads as ₹50,000. | Settings.tsx:325-347, Privacy.tsx:282-293 |
| 9 | **High** | **Medicine GST defaults to 12%** (Settings.tsx:353, 371: options 0/5/12/18, default 1200 bp). After GST 2.0 (Sept 2025) most medicines moved from 12% to 5%, and 12% is no longer a slab (**ASSUMPTION** to verify with the clinic's CA). With MRP GST-inclusive, every pharmacy bill's tax split is wrong. | Settings.tsx:353, 371 |
| 10 | **High** | **Settings sprawl: 18 topics, and money is split across 5 of them.** Consult fee is under Money, visit-type fee under Bookings, medicine price/GST and procedure price/GST under Consultations, and the discount cap is inside "What each role can do". An owner asking "what do we charge?" has to visit 5 screens. | Settings.tsx:19-48 |

---

### 1. Screen-by-screen

#### 1.1 Dashboard (/dashboard)
- **File:** Dashboard.tsx:17-55. Server: dayclose.ts:86-116 (`/dashboard`, `report.read`).
- **Who sees it:** NAV shows it for `report.read || finance.read` (App.tsx:19): owner, admin, **doctor**. Reach it from the sidebar under "Clinic". Nobody lands here.
- **Purpose:** per-doctor patients and revenue, daily trend, wait times against the previous period.

| Sev | Issue | Cognitive-load reason | Fix |
|---|---|---|---|
| High | **Every doctor sees every other doctor's revenue.** The doctor role has `fees.see` and `report.read`, so `moneyHidden` is false (dayclose.ts:87, 100). Consultants see each other's ₹ tiles. | Private business data, not needed for a 6-min consult. | Show money only with `finance.read`. A plain doctor sees only their own tile. |
| High | The tile shows a big ₹ number with **no label** (Dashboard.tsx:31). It is paid + pending charges (dayclose.ts:97-100), so it excludes pharmacy and is not money collected. | "₹42,000": collected? billed? It takes more than 5 s to decode. | Label it "Billed ₹X · Collected ₹Y · Due ₹Z". Add a clinic total tile first. |
| High | **No clinic total and no "by mode" (cash/UPI/card)** anywhere on the Dashboard. The owner's #1 question, yesterday's takings, isn't here. | The owner has to know the answer lives on Reports → End of day. | First row: "Yesterday: ₹X — Cash ₹a · UPI ₹b · Card ₹c · Pharmacy ₹d", linked to Reports. |
| Medium | The range filter has Today / This week / This month, but "This week" is actually the last 7 days and "This month" is the last 30 days (Dashboard.tsx:8). | The label lies. | Rename to "Last 7 days" / "Last 30 days", or compute calendar week/month. |
| Medium | "Visits by type" shows only diary buckets (`General`, `Review`, …) mapped by fee code heuristics (dayclose.ts:17-22: `REN`, `FREE`, regex on name). A new fee category silently counts as "General". | Numbers that don't match the clinic's own categories. | Use the real fee category names. |
| Medium | Bar chart: no axis and no values, only a `title` tooltip (Dashboard.tsx:41). No keyboard or touch access to per-day values. | Hover-only data. | Show values on tap, and add a min/max axis label. |
| Low | Loading shows "Loading…" as the subtitle plus a skeleton. **No error state:** if `/dashboard` 403s or fails, it shows the skeleton forever (Dashboard.tsx:22). | Infinite spinner. | Add an error card with a Retry button. |
| Low | `delta()` always treats lower as better (Dashboard.tsx:9). That is fine for waits and no-shows, but the helper invites misuse. | — | Keep as is. |

#### 1.2 Reports → Daily report (/reports)
- **File:** Reports.tsx:11-58. Server: billing.ts:204-224 (`report.daily`). No `fees.see` check on the server.
- **Who sees it:** NAV shows it for `report.daily || finance.read` (App.tsx:30): owner, admin, receptionist.
- **Purpose:** the day's visits, collections by method, expenses, net, and the payment list.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| Critical | "Collected" here excludes pharmacy, while "End of day" includes it (see top #4). The page title "Daily report" doesn't say "consultations and procedures only". | Two truths for one day. | Use one source: build Daily from `dayFigures`. Show "Consult ₹ · Procedures ₹ · Pharmacy ₹ · Total ₹" × mode. |
| High | **By-mode breakdown is a single grey sub-line**: `CASH ₹1,200 · UPI ₹3,400` (Reports.tsx:30) made with `m.method.toUpperCase()`. It's the owner's key reconciliation figure. | Tiny secondary text for the primary question. | Give it a 3-column mode strip (Cash / UPI / Card), large, with a "Cash in drawer should be ₹X" line. |
| High | "Net for the day" = collected − all expenses (billing.ts:222), mixing UPI income with cash expenses. Not useful for a drawer count. | Misleading total. | Use "Cash in hand = cash collected − cash expenses". Drop "Net" or label it "Income minus expenses". |
| Medium | Defaults to **today**. Owners check **yesterday** first thing. | Extra click every morning. | Before noon, default to yesterday if today has no payments. |
| Medium | "Outstanding overall ₹X across N" in a sub-line (Reports.tsx:32). It is all-time dues, unrelated to the selected day. | Mixed time scopes on one card. | Move it to its own card, "Patients owe ₹X (all time)", with a link to the list. |
| Medium | The Payments table shows patient names to the receptionist. That is fine for the desk, but **Print** depends on `canExport` (default owner-only, audit.ts:12). Admin can't print the daily report by default. | Admin surprised by a missing Print button. | Default `listRoles` to include admin. Explain why Print is hidden: "Owner has turned off printing lists for your role". |
| Medium | The segmented control "Daily report / End of day" appears only with `fees.see && report.daily` (Reports.tsx:25). The two views duplicate data. | Two screens for one question. | Merge into one daily view with a "Close the day" action at the bottom. |
| Low | Empty states: "No visits recorded", "No expenses entered.", "No payments yet today". The last one says "today" even when viewing a past day (Reports.tsx:47). | Wrong word. | Use "No payments on this day". |
| Low | Next-day arrow is not disabled on today, so the user can browse into the future (Reports.tsx:22). | Pointless empty days. | Disable next on today. |
| Low | `prevDay`/`nextDay` come from the server, so the arrows do nothing until the data loads (`d && …`). | Dead click. | Compute them on the client. |
| Low | No loading error state. The skeleton shows forever on error. | — | Add an error card. |

**End of day view** (`EndOfDay`, endOfDay.tsx, 58 lines). **Not inspected in detail** (outside the file list). `dayFigures` buckets mode as cash/upi/card/other (dayclose.ts:12-14). `bank` (used by Expenses) and `emi` fall into "other".

#### 1.3 Expenses (/expenses)
- **File:** Expenses.tsx:17-124. Server: billing.ts:172-201.
- **Who sees it:** `expense.read`: owner, admin, receptionist. A role with only expense permissions **lands** here (App.tsx:44).
- **Purpose:** record and review money going out.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | **No visible "Add expense" button.** Adding relies on the header "+" (Expenses.tsx:27). The empty-state hint says "Add one with **New** at the top." (line 74), but since commit b237a2d "New" is a bare "+" icon with no word. | A receptionist with a receipt in hand can't find where to add. | Keep the no-duplicate rule, but change the copy to "Press **+** at the top right to add one". Better: put a large inline quick-add row above the table on this page, since this page *is* that action. |
| Medium | **Expenses on a closed day can still be edited or removed** (billing.ts:185-201: no `assertDayOpen`). The daily report then disagrees with the closed-day snapshot. | Books silently drift. | Block edits for closed days, or require a reason and flag it "changed after close". |
| Medium | The removal reason is optional ("Reason (optional)", line 118). The audit then shows "Voided an expense" with no why. | Weak audit trail. | Make the reason required (at least 3 characters), like the day-close notes. |
| Medium | Paid-by is Cash / UPI / Bank (line 12). There is no **Card**, and "Bank" doesn't map to the EOD buckets (falls into "other"). | Mismatched vocabulary across money screens. | Use one method list app-wide: Cash, UPI, Card, Bank transfer. |
| Medium | The stat tiles "Paid by cash/upi" use the raw lowercase method: `'Paid by ' + m.method` gives "Paid by upi" (line 68). | Unpolished, inconsistent with Reports' "UPI". | Map through METHODS labels. |
| Low | Range filter defaults to "Last 30 days", but the subtitle shows dates only. | Fine. | — |
| Low | Category list is fixed by the server (`categoriesOf`). There's no way to add a category here, or **anywhere in Settings** (no expense-categories tab). | A dead end when "Electricity" isn't in the list. | Add "Expense categories" to Settings → Money, or allow adding inline. |
| Low | The "Add an expense" modal "Stays open after each one". Good. But the validation hint shows only after typing (line 57), and the Add button is just disabled. | Disabled button with no reason. | Always show the blocker next to the disabled button. |
| Low | CSV export (DataTable) is not audited or gated. It holds no patient data, so this is acceptable. | — | — |

Popups:
- **Add an expense** modal (45-62).
- **Edit expense** modal (100-113). There is no "why changed" field, and the amount can be changed silently.
- **Remove this expense?** (114-121). The button is styled primary + rose. Good: "Keep it" is the safe option.
- Toasts: "Added ₹X · Category", "Expense updated", "Expense removed (kept in the audit trail)". All clear.

#### 1.4 Settings home (/settings)
- **File:** Settings.tsx:57-92, settings.css.
- **Who sees it:** NAV shows it for `config.write`: owner, admin. Privacy and Test data are owner-only (line 49).
- **Purpose:** a list of 18 topics in 5 groups, with search in the header.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | **18 topics** (Clinic, Day at desk, Staff, Roles, Rooms, Privacy, Weekly hours, Visit types, Booking rules, WhatsApp, Rx pad, Form fields, Templates, Medicines, Procedures, Photo areas, Fees, Test data). The "Money" group has 1 item while prices are in 4 other groups. | A doctor-owner can't hold 18 nouns in mind. Money is scattered. | Regroup into 5: **Clinic & people** (details, staff+roles, rooms, privacy) · **Prices & tax** (consult fees, procedures & packages, medicines MRP/GST, discount cap, expense categories) · **Doctor's pad** (pad, form fields, templates, photo areas) · **Day & bookings** (desk, hours, visit types, rules) · **Patient messages**. Move Test data out of production. |
| Medium | "Roles" and "Privacy" both use the `lock` icon (lines 24, 26). | Identical icons for different things. | Use a distinct icon (shield vs key). |
| Medium | Neighbour tabs inside a topic show only the same group (line 96). To go from Fees to Medicines you must go back to home. | Price changes need many hops. | Fixed by regrouping above. |
| Low | Search matches label + hint + group text only. Searching "GST" finds nothing (no hint mentions GST). Searching "password" finds nothing. | Search misses common words. | Add keywords per topic (GST, tax, password, WhatsApp, Telugu, printer). |
| Low | Subtitle "A change applies straight away, for everyone." is good, but true only after Save. Privacy applies on click (inconsistent, see 1.10). | — | — |
| Low | `TONES` / animation delays are fine. On mobile the 18 rows are one long column. | — | — |

#### 1.5 Settings topic shell
- **File:** Settings.tsx:94-123.
- The sticky "Save" bar shows "Changes apply for everyone once saved." (settings.css:31).

| Sev | Issue | Fix |
|---|---|---|
| High | **There is no unsaved-changes guard.** Switching neighbour tab, Back, or clicking the modal backdrop (ui.tsx:323 `onClick={onClose}`) silently discards edits. This affects Clinic, Day, Booking rules, Messages, Form fields, Pad, and every edit modal. | Disable the backdrop close when dirty, and prompt "Discard changes?". Clinic and Day have no dirty tracking at all, so Save is always enabled. |
| Medium | Save patterns are inconsistent: a sticky bar (Clinic, Day, Pad, Forms, Rules, Messages, Photos), per-card Save (Vitals, Discount cap), inline Save (Availability), save-on-click (Privacy), and modal Save (Fees, Medicines, Procedures, Rooms, Users). | Pick one: sticky bar for forms, modal Save for list items, and **no** instant-apply for security. |
| Medium | Several mutations have **no `onError`**: `saveDoc` (line 201), medicine `save` (353), procedure `save` (425), room `save` (458). A failure gives no toast, and the modal just stays. | Add `onError: toast(errText(e),'err')` everywhere. |

#### 1.6 Clinic details (`?tab=clinic`)
- **File:** Settings.tsx:131-152.
- **Who sees it:** owner, admin.
- **Purpose:** the prescription header and token numbering.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | **No GSTIN, PAN, or clinic registration / HFR (ABHA facility) ID fields.** Pharmacy bills carry GST (medicine `gstBp`), but the clinic's GSTIN has no home. | An Indian tax invoice needs the GSTIN. | Add GSTIN (with checksum validation), state code, PAN, HFR ID, and a logo. |
| Medium | **Changing token numbering mid-day** (`day+category` vs `day`) is applied instantly with no warning (line 146). The "Numbers start again every morning" line helps, but today's queue could get duplicate or odd numbers (**ASSUMPTION**). | Desk confusion. | Use "Applies from tomorrow", or warn if visits exist today. |
| Low | The Phone field has no validation or format. "Line at the bottom" is vague. | — | Use "Footer line (e.g. Get well soon)". Validate a 10-digit phone. |
| Low | There is no print preview of the header. | The owner can't see the result. | Add a live mini-preview of the prescription header. |

#### 1.7 The day at the desk (`?tab=day`)
- **File:** Settings.tsx:155-191.
- **Purpose:** junior screening mode, free review window, waiting-room screen link.

| Sev | Issue | Fix |
|---|---|---|
| Medium | The screening options' explanations are in a `title` tooltip (line 163) plus a dynamic sentence below. The options "When a junior is on" / "Every patient" are fine. Changing to "Every patient" mid-day blocks reception immediately (line 164: "Reception cannot send a patient to the doctor until the junior has screened them."). | Confirm when switching to Required while patients are waiting. |
| Medium | **"New link" regenerates the TV token with no confirm** (line 188). The waiting-room screen goes blank, and toast "New link made. The old screen stops showing." comes after the fact. | Ask "Make a new link? The TV in the waiting room will stop until you open the new link on it." |
| Medium | The display link is an unguessable token, but the token is also exposed via `/config` to every role (top #5). | Strip `display` from `/config` for non-config roles. |
| Low | "Free within [30] days of the tests" mixes a form field into the sentence. Fine. Clamped 0-365 silently (line 158). | Show a validation message instead of a silent clamp. |
| Low | Save has no dirty tracking, so it is always enabled. | — |

#### 1.8 Staff and doctors (`?tab=people`)
- **File:** Settings.tsx:194-244.
- **Who sees it:** owner, admin (`user.write` server-side for users, `config.write` for practitioners).
- **Purpose:** sign-in accounts and the doctors who sign prescriptions.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| Critical | **The Roles chips include "Owner" for an admin**, and the server accepts it (top #1). | Privilege escalation. | Server: only an owner may grant or remove `owner`, and only an owner may edit an owner's account. UI: hide the Owner chip for non-owners. |
| Critical | **No last-owner protection.** An owner can untick their own Owner chip, and an admin can deactivate the owner (top #2). | Clinic lockout. | Server: refuse any change that leaves zero active owners. Refuse an admin editing an owner. |
| High | **Password: min 6 characters on the server** (admin.ts:56). There are no strength rules, no confirm, no show/generate, and the client never states the rule (the server error surfaces as `errText`). An admin types the user's password and must tell them verbally. There is no forced change on first sign-in and no self-service change. | A weak, shared password culture. | Generate a password, show it once, share it via WhatsApp to the staff phone, force a change on first login, and require min 8 characters. Add "Change my password" in the user menu and "Reset password" in this list. |
| High | **Deactivated doctors disappear** (top #6). The doctor's "Active" checkbox (line 237) is a one-way trap. There is also no check for future bookings or open procedure courses when deactivating. | Lost data, orphaned bookings. | List inactive rows (greyed) from an admin endpoint. Before deactivating, show "Dr X has 14 future bookings and 3 courses — move them first". |
| Medium | Sign-in needs an **email**. Many front-desk staff in India don't use email. | Mixed digital literacy. | Allow a mobile number or username as the login ID. |
| Medium | Two lists (Staff accounts / Doctors (practitioners)) with a linking concept explained in jargon: "A doctor who also signs in needs a user account linked to their practitioner record (People → user → "Signs prescriptions as")." (line 216). | "Practitioner record" is developer language. | Add one person = one row: "Dr Sahitya — Owner, Doctor — signs prescriptions". Adding a doctor asks "Will they sign in? [email/phone]" in the same form. |
| Medium | **No visible Add buttons.** Adding goes only through the header "+" → "Add a user" / "Add a doctor" (palette.tsx:24). | Hidden primary action on a list page. | Keep "+" but add an inline "+ Add staff" row at the end of each list (it's the list's own affordance, not a page action). |
| Medium | The `saveDoc` mutation has no `onError` (line 201). | A silent failure. | Add a toast. |
| Low | Users can't be sorted or filtered. Inactive users show at 50% opacity mixed in. | — | Put inactive users last, behind "Show former staff". |
| Low | Doctor registration number is not validated. The "Qualification" free text is fine. | — | — |

**New/Edit user modal** (lines 218-230):
- Title "New user", subtitle "One person can hold several roles; permissions add up". That is jargon-ish.
- The default role is preselected as receptionist (line 199). Good.
- The Save button is disabled with no reason given.
- **Proposal:** subtitle "Pick what they do. Someone can be Doctor and Owner at once."

**New/Edit doctor modal** (lines 231-241): includes the full weekly RoutineEditor. That's heavy, but it's routine-once, so acceptable.

#### 1.9 What each role can do (`?tab=roles`)
- **File:** Roles.tsx:18-110. Server: admin.ts:79-125.
- **Who sees it:** owner, admin.
- **Purpose:** permission matrix per role, custom roles, and the discount cap.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | The **Admin role is editable by an admin**, including removing their own `user.write` or `config.write` (mayGrant only blocks *adding*, admin.ts:103). An admin can lock out every admin. The owner remains, so this is High, not Critical. | Self-lockout. | Block removing `config.write` / `user.write` from a role the editor holds, or confirm "You will lose access to this page". |
| High | **The discount cap is hidden inside "What each role can do"** (Settings.tsx:111, Roles.tsx:97-110). It's a money rule. | Nobody looks for a price rule under Roles. | Move it to Prices & tax. |
| Medium | **~33 checkboxes** in 8 groups, all visible at once (auth.ts:42-77). The "Pages they will see" chips are a great summary (Roles.tsx:63). | Too much at once. | Collapse groups to a one-line summary ("Money: collect, waive") and expand on tap. Pin the risky ones (refund, waive, user.write, config.write) with a warning tag. |
| Medium | **Risky grants have no warning.** Ticking "Manage staff accounts and roles" or "Change clinic settings" for Reception gives silent super-powers. Combined with top #1, `user.write` alone lets them create an Owner. | Role grants too much. | Add a red "Powerful" tag and a confirm on save when such permissions are added. |
| Medium | "Reset to standard" (line 59) has **no confirm** and runs immediately. | One mis-click reverts a tuned role for everyone. | Confirm: "Reception goes back to the standard permissions. 3 people affected." |
| Medium | `NEEDS` references `pharmacy.dispense`, which is not in the catalogue (Roles.tsx:15). That's dead code. `payment.waive` has no dependency on `payment.record`. | Minor logic gaps. | Clean up. |
| Low | The custom role name is edited inline in the header (line 58), and it isn't obvious that it's editable. | — | Add a pencil icon. |
| Low | The selection highlight uses `bg-white` (line 50), which may break in dark mode (**ASSUMPTION**: not checked). | — | Use a token. |
| Low | The toast "Saved. People with this role get it on their next click." is good. | — | — |

**New role modal** (Roles.tsx:84-91): "Start from: Reception's permissions". Good.

**Audit:** role create/update/delete is audited (admin.ts:93, 108, 123; route.ts auto-audit). But `PATCH /admin/roles` doesn't set `auditBefore`, so the audit shows only the new list, not the diff.

#### 1.10 Privacy and security (`?tab=privacy`, owner only)
- **File:** Privacy.tsx:122-216. Server: security.ts:20-51 (owner-checked).
- **Purpose:** IP allow-list, idle sign-out, phone masking, list export, link to the audit log.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | **Every click saves instantly**, including the IP-lock switch (line 140) and removing an allowed address (line 151). There is no confirm. Removing the clinic's own address while the lock is on stops every staff member at once. The server only guards "enabled with zero addresses" (security.ts:43). | One slip and the front desk is locked out mid-OPD. | Confirm destructive changes: "Remove 'Clinic internet'? 6 staff currently on it will be signed out." Show how many staff are on each address. |
| High | **Custom roles can't be given phone visibility or list export.** The role list is hard-coded `ROLES = ['owner','admin','doctor','receptionist','assistant','coordinator','pharmacist']` (security.ts:11). | Custom roles are silently masked. | Use `rolesFor(settings)`. |
| Medium | **Phone masking is a regex on the JSON response**, only for keys `phone`/`toPhone` and exactly 10 digits (app.ts:94). A number stored as `+91…` or under another key (e.g. alt/guardian phone) is not masked (**ASSUMPTION**: storage format not checked). | Privacy promise may not hold. | Mask at query/serialisation level for all phone-like fields, and test with +91 formats. |
| Medium | Jargon: "internet address", "A range", "IP" in placeholders `49.205.12.34`. The text is good overall, but a doctor-owner doesn't know their IP changes on Jio/Airtel. "Stopped sign-ins" with "Allow this address" helps. | — | Lead with "Add this computer" as the main path (already a primary button). Hide ranges behind "Advanced". |
| Medium | Idle sign-out is **client-side only** (App.tsx:172-185). The server cookie lives 14 h (identity.ts:45). Closing the browser leaves the session valid. | The security promise is weaker than stated. | Add a server-side idle expiry. |
| Low | "Lists of patients" — "Who may download or print lists (front desk list, history, daily report)." Admin is not fixed-on here (line 192), so the default is owner only. Admin can't print the daily report. | Surprise. | Default admin on. |
| Low | `role="checkbox"` on toggle buttons. Good. The switch has `aria-label`. Good. | — | — |

**Add an internet address modal** (Privacy.tsx:202-213): validation messages are plain ("That does not look like an internet address."). Good.

#### 1.11 Audit log (/audit)
- **File:** Privacy.tsx:222-293. Server: security.ts:54-65.
- **Who sees it:** NAV shows it for `user.write` (App.tsx:33), but the server requires role name owner/admin (security.ts:10).
- **Purpose:** every action, filterable.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | **Before/After shows raw field keys and paise:** `amountPaise 50000`, `gstBp 1200`, `taxRateBp`, `settings {"print":{…}}` (Privacy.tsx:282-293, uses `JSON.stringify`). | The owner reads ₹50,000 instead of ₹500. Misread money in the evidence trail. | Add a field-label map + money formatter (`*Paise` → ₹, `*Bp` → %). Summaries should name the thing: "Changed fee GEN: ₹500 → ₹600". |
| High | Summaries for settings are generic: "Changed a fee", "Changed clinic settings", "Changed a team member" (audit.ts:126-133). | You must open each row to learn anything. | Include the entity name and the key change in the summary. |
| Medium | A custom role with `user.write` sees the nav item, but the server returns 403. The page then shows **"Nothing in this period"** (line 255) because `q.data` is undefined and no error is handled. | False reassurance. | Align the rule: NAV should use the same check as the server, and show an error state on 403. |
| Medium | Patient filter uses the header page-search ("Find a patient's actions: name, phone or OP no."), with results in a dropdown under an empty `relative` div (lines 246-250). It's hard to discover. | — | Make it an explicit "Patient" filter chip next to "All staff". |
| Medium | Limit 200 with "Narrow the filters to see older ones." (line 267). There's no paging, though the server supports `before`. | — | Add "Load older". |
| Low | "kept a year. Nobody can edit or delete it." Retention isn't verified in code I read (**ASSUMPTION**). Test-data reset does keep `audit_log` (sample.ts:12). | — | — |
| Low | Unusual-row explanation in the modal is good plain language (line 272). | — | — |

#### 1.12 Doctors' weekly hours (`?tab=availability`)
- **File:** SettingsScheduling.tsx:34-54.
- **Who sees it:** owner, admin.

| Sev | Issue | Fix |
|---|---|---|
| Medium | Changing a routine says "future days follow it" (toast). There is no warning about existing bookings that fall outside the new hours. | Show "12 bookings fall outside the new hours", with a list. |
| Low | The same editor appears in the Doctor modal (Settings.tsx:236): two places to edit one thing. | Keep one place (here). The doctor modal links to it. |

#### 1.13 Visit types (`?tab=services`)
- **File:** SettingsScheduling.tsx:57-118.

| Sev | Issue | Fix |
|---|---|---|
| High | The "Fee (₹)" isn't what's charged (top #7). "Fee at check-in: Decide at check-in" is a second fee concept on the same card. | Remove the price field. Show the linked fee category's amount read-only: "Charged: GEN ₹500 (change under Prices)". |
| Medium | The hint says "“online” ones appear on your booking page" (line 76), but online booking was removed (memory note 9 Nov 2026). `onlineBookable` stays in the payload. | Delete the stale copy. |
| Medium | "Places used" — jargon for capacity units. | Use "Takes how many slots (usually 1)". |
| Low | Archive happens via the button and then a separate Save (line 112, 115: "Press Save to apply."). That's a two-step trap. | Archive immediately, with confirm and undo toast. |
| Low | The colour swatches' `aria-label` is a hex code (`#D4421A`). | Use colour names. |

#### 1.14 Booking rules (`?tab=rules`)
- **File:** SettingsScheduling.tsx:121-154, plus `CalendarLookCard` (packages.tsx, **not inspected**).

| Sev | Issue | Fix |
|---|---|---|
| Medium | "Places per window (new doctors)" vs each doctor's own places is confusing. The help text admits it (line 139). | Remove the default here. Set it in each doctor's hours. |
| Medium | "Patients can pick a new time from their link" — still relevant (patient link stays). OK. "Warn after this many no-shows" — warns whom? | Use "Warn reception when a patient has missed N visits". |
| Low | The validation summary is good and plain (line 150). | — |

#### 1.15 WhatsApp reminders (`?tab=messages`)
- **File:** SettingsScheduling.tsx:157-226.

| Sev | Issue | Fix |
|---|---|---|
| High | The "not connected" banner is pure jargon: "WhatsApp Business account (Meta Cloud API); your administrator adds its token to the server. Meta also has to approve a template for each message type" (line 184). An owner can't act on it. | "WhatsApp isn't set up yet. Messages are kept ready below. Call Cubott support to connect your clinic's WhatsApp number." |
| High | **"Meta template name"** field plus "WhatsApp sends your approved template with these values in order: patient, date, time, doctor, link" (lines 208-209). Editing the text above does nothing if a template is set, and nothing tells the owner that. | Hide it under "Advanced (support only)". When a template is set, lock the textarea with "This message is fixed by WhatsApp approval." |
| Medium | Placeholder chips `{visitType}`, `{arriveBy}` are camelCase code (line 19, 206). | Show them as plain chips ("Visit type", "Arrive by") that insert tokens. |
| Medium | Language is English or **Telugu only** (line 198). It's multi-tenant SaaS, so Hindi and other regional languages are missing. | Use per-tenant language options from a list (hi, ta, kn, mr, bn, …). |
| Medium | Clicking a variable chip appends it to the **end** of the text (line 206), not at the cursor. | Insert at the caret. |
| Low | The Outbox statuses are renamed "logged→ready", "pending→due". Fine. There is no retry for failed messages. | Add Retry. |
| Low | No SMS fallback setting. | Add later if needed. |

#### 1.16 Prescription pad (`?tab=pad`)
- **File:** SettingsPad.tsx:15-110.

| Sev | Issue | Fix |
|---|---|---|
| Medium | **Telugu is hard-coded**: the language toggle 'Telugu + English' / 'English only' / 'Telugu only', and the "Telugu phrases" table (lines 51, 90). That's fine for tenant #1, but wrong for a SaaS. | "Second language: [Telugu ▾]", phrase table per language. |
| Medium | The `⋮⋮` drag handle (line 39) is decoration only. There's no drag. Order uses arrow buttons. | Remove the handle or implement drag. |
| Medium | Long cross-reference help: "Examination fields and custom sections are edited under Consultation form. Print here decides whether a section is on the paper at all; what prints inside it is the Print settings on the right." (line 46). | Merge Pad and Form fields into one "Doctor's pad" topic so no cross-reference is needed. |
| Low | The Telugu table is a 420px scroll box with hundreds of rows. Reset all has **no confirm** (line 91). | Confirm "Reset all N changed phrases?". |
| Low | "History chips" — "chips" is UI jargon. | Use "History choices". |

#### 1.17 Consultation form fields (`?tab=forms`)
- **File:** Settings.tsx:247-322.

| Sev | Issue | Fix |
|---|---|---|
| Medium | The developer surface shows `font-mono` keys (`s.key`, "key: {field.key}"), types like "Diagnoses with severity", and "Publish new version" (lines 294, 312, 319). | Hide keys. Use "Save form" with "past notes keep their old form" as help. |
| Medium | **Remove field has no confirm** (line 313), while remove section does (295). Either way it applies only on publish, but the inconsistency is there. | Add an undo toast for both. |
| Medium | The error toast is always "Check keys: lowercase letters, numbers, underscores" (line 282) whatever the real error is. A Hindi or Telugu label gives an empty `slug` → key "" → that error, with no way to fix it in the UI. | Generate a fallback key (`f_1`) and show the real error. |
| Low | Vitals card: "The dark ones are asked for at check-in" (line 271). That copy depends on colour. | Use "Ticked ones are asked for…", with a tick icon. |

#### 1.18 Templates (`?tab=templates`)
- **File:** SettingsTemplates.tsx:133-280.

| Sev | Issue | Fix |
|---|---|---|
| Medium | 8+ tabs ("Whole Rxpad" plus KINDS) and two linking concepts ("Suggest when the complaint is", "or the diagnosis is", "Show as a chip" / "Add for the doctor"). | Fine for a doctor-owner with time. Default most users to the "Waiting for you" approvals view. |
| Medium | The "Whole Rxpad" Link uses an `ask()` prompt with a mini-syntax: "Acne vulgaris, Rosacea; Acne" (line 247). | Reuse the `Words` chip inputs. |
| Low | The copy uses "She taps Yes or No" / "She can remove any line" (lines 190, 220), which assumes a gender. | Use "The junior doctor taps…", "The doctor can remove…". |
| Low | The delete confirm is good ("Retire it instead if you may want it back."). The Approve button has no confirm. That's fine. | — |

#### 1.19 Medicines (`?tab=medicines`)
- **File:** Settings.tsx:350-418.

| Sev | Issue | Fix |
|---|---|---|
| High | GST default 12% (top #9). Options 0/5/12/18 (line 371). | Use 0 / 5 / 18 (verify with the CA). Default 5%. Bulk "set GST for all" action. |
| High | **Delete has no confirm** (line 388). One click fires `DELETE`. If the medicine is referenced the DB FK rejects it (schema.ts:257, 488), but the toast always says "In use by a prescription; cannot delete" even when the cause is stock batches or a network error (line 354). There is **no Retire option**, so a used medicine can never be removed from the list. | Confirm, add an "Active" flag (retire), and show the real reason. |
| Medium | Section title "Favourites · N" (line 357), but the tab is "Medicines". It's also the pharmacy price master. | Title it "Medicines · N". |
| Medium | Schedule chips `OTC / H / H1 / X` have no explanation. | Add tooltip and help: "H1 needs a register entry". |
| Medium | Price label "Price per unit (MRP, GST included)" vs "Tablets per strip (price is per strip)" (lines 370, 375). That contradicts itself: per unit or per strip? | Use "MRP per strip (GST included)". |
| Low | Leaflet upload is only possible after save ("Save the medicine first to upload a file"). | — |
| Low | Filter input with placeholder "Filter" and no label. | Add `aria-label`. |

#### 1.20 Procedures and packages (`?tab=procedures`)
- **File:** Settings.tsx:421-451, `PackagesCard` (packages.tsx, **not inspected**).

| Sev | Issue | Fix |
|---|---|---|
| Medium | GST options "Exempt (medical)" / "18% (cosmetic)" (line 441) are good plain language. A price change has no "from when". Existing courses keep their price (**ASSUMPTION**). | Show "Existing packages keep their price". |
| Medium | "Needs room with" chips show raw capability tags like `minor_ot` (line 440). | Show human labels. |
| Low | No `onError` on save (line 425). | Add a toast. |

#### 1.21 Rooms (`?tab=rooms`)
- **File:** Settings.tsx:454-476.

| Sev | Issue | Fix |
|---|---|---|
| Medium | Copy: "A capability is a tag such as "laser" or "minor_ot". Procedures declare which tag they need; scheduling only offers rooms that have it. Rooms cannot be treated as interchangeable." (line 462). Jargon-heavy. | "Tick what each room has (laser, cryo…). A procedure is only booked into a room that has what it needs." |
| Medium | Deactivating a room loses it forever (top #6), and procedures already booked there aren't checked. | Same fix as doctors. |
| Low | The new capability input converts to snake_case live (`phototherapy`). | — |

#### 1.22 Photo areas (`?tab=photos`)
- **File:** SettingsScheduling.tsx:230-260. Clean. "Use the standard list" overwrites the list without a confirm (line 257). That only takes effect on Save. Low.

#### 1.23 Consultation fees (`?tab=fees`) — Critical/High screen
- **File:** Settings.tsx:325-347. Server: admin.ts:142-144.
- **Who sees it:** owner, admin.

| Sev | Issue | Reason | Fix |
|---|---|---|---|
| High | **No confirmation and no effective time.** It saves instantly for the whole clinic, mid-day. | Two patients in the same hour pay different fees, and reception isn't told. | Confirm: "GEN ₹500 → ₹600. Applies to check-ins from now / from tomorrow." Default to tomorrow. |
| High | Audit shows "Changed a fee" + paise (top #8). | — | See 1.11. |
| Medium | Table columns: Code / Name / Fee / Rule / Queue. "Rule" shows `auto-suggested by rule` / `manual`, but **the rule (JSONLogic `eligibility`) can't be edited in the UI**. | Unexplained, uneditable concept. | Show the plain-language rule ("Free if within 15 days of last paid visit"), editable via presets. |
| Medium | "Queue priority (0 = normal, up to 99)" and "Counts against window capacity" are jargon. | — | Use "Jumps the queue? [No / Yes, ahead of others]" and "Uses a booking slot? [Yes/No]". |
| Medium | **No GST field for consult fees** (server supports `taxRateBp`, admin.ts:142, but the UI omits it). Cosmetic consults may be taxable (**ASSUMPTION**). | — | Add "GST: Exempt / 18%". |
| Medium | The Code is uppercase, max 8, and frozen after create. Reception sees "GEN-1" tokens. That's fine, but there's no hint that the code becomes the token prefix. | — | Help text: "Shown on tokens, e.g. GEN-12". |
| Low | No `onError` difference. The toast is "Fee saved". There is no visible Add button (header "+" only). | — | — |

**Ideal redesign (Prices & tax → Consultation):**
```
Prices & tax ›  Consultation | Procedures | Medicines | Discounts
┌───────────────────────────────────────────────────────────────┐
│ Visit type        Fee      GST      Token   Jumps queue        │
│ General           ₹ [500]  Exempt   GEN-    –                  │
│ Review (≤15 days) ₹ [  0]  Exempt   REN-    –                  │
│ Emergency         ₹ [800]  Exempt   EMG-    ● Yes              │
│ + Add a visit type                                             │
├───────────────────────────────────────────────────────────────┤
│ 2 changes  ·  Apply: (•) from tomorrow  ( ) right now          │
│                                   [Undo]   [Save prices]       │
└───────────────────────────────────────────────────────────────┘
Confirm: "General ₹500 → ₹600 from tomorrow 11 Nov. Reception will see the new fee at check-in."
```
Inline-edit amounts. One Save for the table. There is one fee concept (visit type = fee category), and the Bookings "Visit types" screen links to it read-only.

#### 1.24 Test data (`?tab=testdata`, owner only) — Critical
- **File:** Settings.tsx:478-501. Server: sample.ts:32-39.
- Confirm: `ask()` with "Type RESET to confirm" (lines 483-490). The copy is clear and honest ("It cannot be undone.").

| Sev | Issue | Fix |
|---|---|---|
| Critical | It's available on a production clinic with real patients (top #3). The server checks only owner + the word. The `/dev/sample-data`, `/dev/sample-collections` and `/dev/sample-bookings` routes need only `config.*`, so **an admin can inject sample patients into a live clinic** (sample.ts:40-46). | Gate on `tenant.kind === 'test'` or an env flag, on the server for all `/dev/*` routes. Hide the topic otherwise. |
| Medium | RESET is case-insensitive on the client (`toUpperCase`) but exact on the server. That's consistent, since the client sends literal 'RESET'. | — |

#### 1.25 Shared states
- **NoAccess** (App.tsx:235). It appears when typing a URL for a blocked page. Good.
- **PageError** boundary (App.tsx:127-135): "Something went wrong on this page. Nothing you saved is lost." Good.
- **Skeletons** on every page. There are **no error states** on Dashboard, Reports, Expenses, Settings (`if (!cfg) skeleton` forever), or Audit (shows a fake empty state).
- **Toasts** are short and plain. Generic `errText(e)` passes server codes through: the user may see `CANNOT_GRANT`, `UNKNOWN_ROLE`, `ROLE_IN_USE`, `ADD_AN_ADDRESS`, `BAD_RULE`. Whether `errText` maps them is **ASSUMPTION** (not inspected).

---

### 2. Core flows: click counts

| Flow | Today | Proposed |
|---|---|---|
| **(a) Owner checks yesterday's takings by mode** | The owner lands on /today. Then: Reports (1) → ◀ previous day (2) → read the grey sub-line "CASH ₹… · UPI ₹…", which **excludes pharmacy**. For the full figure: End of day (3). That's **3 clicks**, and the answer conflicts between views. | **0 clicks**: a "Yesterday" card on the owner's home (or the Dashboard as owner landing) with Cash / UPI / Card / Total, pharmacy included. **1 click** to drill into Reports, which defaults to yesterday before noon. |
| **(b) Add a new receptionist** | Settings (1) → Staff and doctors (2) → header "+" (3) → "Add a user" (4) → type Name, Email, Password (3 fields; Reception is preselected) → Save (5). That's **5 clicks + 3 fields**, and the password has to be told aloud. | Settings (1) → Staff (2) → "+ Add staff" (3) → Name, Mobile, role "Reception" preselected → "Create and send invite on WhatsApp" (4). That's **4 clicks + 2 fields**, with a generated password and a forced change at first sign-in. |
| **(c) Change a consult fee** | Settings (1) → Consultation fees (2) → ✎ on row (3) → edit amount → Save (4). That's **4 clicks**, and the change is live instantly with no confirm. If the clinic also set a visit-type "Fee (₹)", it needs another **4 clicks** (Settings → Visit types → row → Save) or the two disagree. | Settings (1) → Prices & tax (2) → type in the amount cell → Save prices (3) → confirm "from tomorrow" (4). That's **4 clicks, one place, with a safe default**. |

---

### 3. Jargon and microcopy (exact current text → plain proposal)

| Where | Current | Proposed |
|---|---|---|
| Settings.tsx:216 | "A doctor who also signs in needs a user account linked to their practitioner record (People → user → "Signs prescriptions as")." | "If a doctor signs in, open their staff account and pick their name under 'Signs prescriptions as'." |
| Settings.tsx:214 | "Doctors (practitioners)" | "Doctors" |
| Settings.tsx:219 | "One person can hold several roles; permissions add up" | "Someone can be Doctor and Owner at once." |
| Settings.tsx:337 | "Queue priority (0 = normal, up to 99)" | "Jumps the queue?" (No / Yes) |
| Settings.tsx:339 | "Counts against window capacity" | "Uses a booking slot" |
| Settings.tsx:332 | "auto-suggested by rule" / "manual" | the rule in words, e.g. "Free within 15 days of a paid visit" |
| Settings.tsx:357 | "Favourites" | "Medicines" |
| Settings.tsx:370 | "Price per unit (MRP, GST included)" | "MRP per strip / pack (GST included)" |
| Settings.tsx:462 | "A capability is a tag … Rooms cannot be treated as interchangeable." | "Tick what each room has. A procedure is only booked into a room that has it." |
| Settings.tsx:289/319 | "Version N. Saving publishes a new version…" / "Publish new version" | "Save form" + "Past notes keep the form they were written on." |
| Settings.tsx:271 | "The dark ones are asked for at check-in" | "Ticked ones are asked for at check-in" |
| Settings.tsx:282 | "Check keys: lowercase letters, numbers, underscores" | the real error, e.g. "Two fields have the same name" |
| Settings.tsx:142 | "Line at the bottom" | "Footer line" |
| SettingsScheduling.tsx:184 | "…WhatsApp Business account (Meta Cloud API); your administrator adds its token to the server…" | "WhatsApp isn't connected yet. Messages are kept ready. Call support to connect your clinic number." |
| SettingsScheduling.tsx:208 | "Meta template name" | hide under "Advanced (support)" |
| SettingsScheduling.tsx:19 | `{visitType}`, `{arriveBy}` chips | "Visit type", "Arrive by" |
| SettingsScheduling.tsx:76 | "“online” ones appear on your booking page." | delete (online booking removed) |
| SettingsScheduling.tsx:100 | "Places used" | "Slots it takes" |
| SettingsScheduling.tsx:136 | "Places per window (new doctors)" | delete; set per doctor |
| SettingsPad.tsx:70 | "History chips" | "History choices" |
| SettingsTemplates.tsx:190, 220 | "She taps Yes or No" / "She can remove any line." | "The junior doctor taps Yes or No" / "The doctor can remove any line." |
| Expenses.tsx:74 | "Add one with New at the top." | "Press + at the top right to add one." |
| Expenses.tsx:68 | "Paid by upi" | "Paid by UPI" |
| Reports.tsx:47 | "No payments yet today" (on any date) | "No payments on this day" |
| Reports.tsx:32 | "Net for the day" | "Cash in hand" (cash in − cash out), with "Income − all expenses" separately |
| Dashboard.tsx:27 | "This week" / "This month" (actually 7/30 days) | "Last 7 days" / "Last 30 days" |
| Roles.tsx:62 | "…so you can never lock yourself out." | keep only after last-owner protection exists |
| Privacy.tsx:147 | "Allowed internet addresses" | "Clinic internet connections" |
| Settings.tsx:45 | Group "Testing — Only on a test clinic." | remove from production |

---

### 4. Inconsistent patterns

1. **Save model:** sticky bar, per-card Save, inline Save, instant-apply (Privacy), and modal Save all exist. Security, the riskiest area, is the one with instant apply.
2. **Delete/retire:**
   - Templates use Retire + Delete with confirm.
   - Visit types use Archive + Save.
   - Medicines use hard Delete with no confirm.
   - Doctors, fees, procedures and rooms use an Active checkbox that makes the row vanish.
   - Expenses use void with an optional reason.
3. **Confirmations:** remove form section confirms, but remove form field doesn't. Template delete confirms, but medicine delete doesn't. Reset role, regenerate TV link and reset Telugu phrases don't confirm.
4. **Payment-method vocabularies:** Expenses use cash/upi/bank, day close uses cash/upi/card/other, and check-in uses cash/upi/card/bank (visits.ts:50).
5. **Role name maps are duplicated** in App.tsx:66, Privacy.tsx:117 and auth.ts:87. Privacy's map and the server's `ROLES` ignore custom roles.
6. **Permission checks by role name vs by permission:** `/audit` and `/security` check role *names*, while NAV checks `user.write`. Dashboard money checks `fees.see`, while `/config` checks nothing.
7. **Add affordance:** most lists rely on the header "+" (no-duplicate rule). Expenses/Settings empty-state copy still says "New".
8. **Error handling:** some mutations toast `errText`, some have no `onError`, and Forms shows a fixed wrong message.

### 5. Accessibility / responsiveness notes
- Many `toggle-opt` buttons work as radios or checkboxes **without** `aria-pressed` or `role` (fees, medicine form/schedule/GST, room capabilities, user roles: Settings.tsx:224, 365-371, 467). Privacy and vitals do this right.
- Fee table, medicine table and procedure table have no `overflow-x-auto` wrapper (Settings.tsx:331, 358, 428). On a phone the 8-column procedure table will overflow (**ASSUMPTION**: `.table` CSS not checked).
- `grid-cols-4` for the medicine defaults and procedure numbers (Settings.tsx:379, 434) doesn't collapse on mobile.
- Dashboard bars are hover-only (`title`).
- Several labels aren't tied to inputs (`<label className="label">` without `htmlFor`): Clinic, People, Fees name/code, Medicines.

### 6. Data and permission leaks (summary)
- `/config` → prices, MRP, procedure prices and the display token go to all roles, including junior doctor and pharmacist (identity.ts:55-73).
- `/dashboard` → per-doctor revenue goes to every doctor (dayclose.ts:87).
- `/reports/daily` → no `fees.see` check (billing.ts:204). Only roles with `report.daily` reach it, but a custom role given "See the daily report" without "See fees" still gets all money.
- Phone masking → regex on 10-digit `phone`/`toPhone` only (app.ts:94). Custom roles can't be whitelisted (security.ts:11).
- Admin → owner escalation (admin.ts:56-72).

### 7. Audit coverage (who changes fees/GST/roles; is it audited)
- Fees, GST (medicine `gstBp`, procedure `taxRateBp`), and medicine/procedure prices need `config.write` (owner, admin). They're audited by `route()` with `auditBefore` via `upd()` (admin.ts:217-224). Summaries are generic and values are raw.
- Clinic settings are audited with the before-snapshot of the touched keys (admin.ts:36).
- Roles are audited, but with **no before** on PATCH (admin.ts:96-110).
- Users are audited. Passwords and tokens are replaced with `***` by `clean()` (audit.ts:60). OK.
- Medicine delete is audited as "Removed a medicine" with no name.
- Security is audited (security.ts:45 `auditBefore`).
- Test-data reset is audited only as a generic POST (**ASSUMPTION**: it matches the fallback describe).

### 8. Could not inspect
- `web/src/endOfDay.tsx` (End of day view), `takePayment.tsx` EmiAwaiting, `packages.tsx` (PackagesCard, CalendarLookCard), `routine.tsx` (RoutineEditor), `templates.ts` KINDS, `api.ts` `errText` mapping, audit retention job, `.table`/`.toggle-opt` CSS, dark-mode rendering.
- I didn't run the app, so there are no screenshots. Every visual and responsive claim comes from class names.
