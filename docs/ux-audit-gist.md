# UX audit — the gist (2 pages)

*Reviewer's summary of `docs/ux-audit-2026-11.md` (11 Nov 2026). Read this; open the big file only to look up a screen.*

## The verdict

The app is well made and plainer than most clinic software, but it has **real safety, money and privacy bugs** that matter more than how it looks. Fix those first, then make every role's screen simpler. Everything below was found in the code and the worst items were re-checked by hand.

## Must fix now (can hurt a patient, lose money or leak data)

**Prescriptions**
1. The allergy check is a short word list. "Augmentin" for a penicillin-allergic patient is not caught, and the pad then says *"no clash found"*.
2. Quantity is taken from the dose number: "500 mg, 1‑0‑1, 7 days" = **7000 tablets**; the pharmacy pre-fills the whole shelf.
3. "Preview" prints a draft that looks like a signed prescription, and printing right after Finish can print the old version.
4. Infants show no age (0 years is treated as "unknown"). No pregnancy flag, no duplicate-medicine or interaction check.

**Money**
5. "Collect" at the front desk records **cash** in one tap — no UPI/card choice, no confirm; a double-tap pays twice. Check-in accepts any amount.
6. A refund only changes a label; End of day still counts the money. Reports and End of day show **two different "Collected" totals**.
7. Procedure sittings booked without a course are **never charged**.
8. A pharmacy sale retried on a bad connection is billed twice. Schedule H drugs can be sold without a prescription.

**Privacy and access**
9. Every list has an **Export** button that downloads patient names and phones for any role, with no audit trail.
10. Front desk and pharmacy can see diagnoses; junior doctors get all prices.
11. An admin can make themselves Owner or lock the owner out. "Test data → RESET" can wipe a live clinic.
12. The login page shows demo accounts and a pre-filled password.

**Labs and procedures**
13. The doctor's lab review shows no values and starts on "Normal" — one click files an abnormal result as normal.
14. No consent is recorded before a laser or peel.

## Why it feels hard to use

- **Too much on one screen.** The front desk header has ~13 controls; Settings has 18 topics with prices spread over 5; the Rx pad has 3 layouts and a toolbar on every section.
- **One thing, many names.** "Not yet arrived / Still to arrive / Booked, not here yet". Three different booking forms.
- **Errors look like "nothing here".** On a bad connection lists say "No patients found" — so staff register the patient again.
- **No undo, and confirms are random.** Some deletes ask, many don't; Esc or a stray click wipes a half-filled check-in.
- **Not built for the setting.** English only, small text, small tap targets on tablets, heavy glass effects on slow PCs, UPI by typing a 12-digit number.

## What the redesign looks like

- **One home screen per role, one big button, five menu items at most.**
  - *Reception — Desk:* search box, "Not here yet" and "Waiting" lists, "Arrived" opens payment; **a calendar panel on the home screen** (asked for by reception).
  - *Doctor — Today:* the next patient with allergies in red, "Results to sign", **a calendar panel on the home screen** (asked for by the doctor).
  - *Junior doctor — To screen.* *Coordinator — Sittings today* (prepaid/due and consent on each row). *Pharmacist — Counter* (Rx lines with batch, expiry, QR payment). *Owner — Home:* Yesterday · Today · Needs you.
- **One of each:** one patient panel, one payment form (mode is the button, UPI shows a QR), one booking form, one call list.
- **Stop for safety, undo for everything else.** Allergy, interaction, money and delete actions ask clearly; status changes act at once with Undo.
- **Honest states:** loading, "couldn't load — retry" and empty always look different; a "no internet" strip.
- **Plain words** from one vocabulary list; patient-facing text in Telugu/Hindi.
- **Remove:** pad layouts, per-section template buttons, the 9 stage tiles, the separate Bookings page, client-side export, demo logins, RESET on live clinics, blur effects.

## Time saved (estimated)

| Task | Today | Proposed |
|---|---|---|
| New walk-in, check in, pay by UPI | 7 clicks + typing | 3 |
| Follow-up consult to print | 10–12 clicks, scrolling | 8–9, no scroll |
| Dispense prescription, UPI | 9 + 12-digit UTR | 3 |
| Procedure day, take payment | ~9, leaves the page | 3 |
| Owner: yesterday's takings | 3, numbers disagree | 0 (on home) |

## The plan

1. **Week 1–2 — safety, money, privacy fixes** (mostly small code changes; on branch `redesign/ux-audit`).
2. **Weeks 3–6 — medium items:** proper allergy/interaction data, sign-off and amend, trustworthy autosave, one money ledger, consent, pharmacy guards, offline strip, settings in 6 groups, bigger text and targets.
3. **Week 7+ — the big redesigns** (role homes with calendar, front desk, Rx pad v2, pharmacy counter v2, owner home, Telugu/Hindi) — designed on the canvas first, then built, each tested with a new receptionist who gets no training.
