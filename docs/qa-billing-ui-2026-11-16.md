# Billing UI test, round 2: branch billing/patient-account (8cb0a34 + uncommitted pharmacist change)

Tested 16 Nov 2026 in the browser on a fresh database (server `cubott-billqa`, port 3130, `/dev/reset-sample`), as Owner, Reception and Pharmacy. Every step went through the real screens; figures were then compared across the patient header, Bills & payments tab, invoice view, printed invoice, printed receipt, Billing, Clinic, Accounts, Reports overview, Daily report and End of day.

Patients used: Kiran Kumar (CO2 whole treatment, discounts, multi-mode, overpay, refunds, session removal, cancel, advance), Durga Prasad (Reception 20% discount, Say no), Aruna Kumari (Reception 15% discount, Approve, no phone), Swapna (part paid, after day close), Anjali Reddy (price-list items, qty, double-click, cancel invoice), Pavani (GST on), Lakshmi Devi (per-session billing).

## High

| # | Defect | Steps | Seen |
|---|---|---|---|
| H1 | **A session billed on its own is billed again with the whole treatment** | Lakshmi Devi, Chemical peel 6 sessions ₹15,000, never invoiced. Procedures › Start session › Mark done ("₹2,500 will be due"). Generate invoice. | Two lines offered: "Chemical peel session 1 · INV-0116 ₹2,500" **and** "Chemical peel · 6 sessions ₹15,000" (full, not "the rest"). Ticking both saves: header Due ₹17,500 for a ₹15,000 treatment. The server accepts it. Likely cause: `standing()` (`src/modules/courses.ts:17`) counts only charges with this `course_id`; the session charge made before the course existed isn't linked, so `uninvoicedPaise` stays ₹15,000. |
| H2 | **Removing a session from a discounted treatment credits the undiscounted share** | Kiran: CO2 4 sessions ₹32,000, discount ₹4,640.99, paid ₹27,359.01, refund ₹5,000 on the invoice. Edit procedure › remove session 4 › Save. | Preview "−₹6,750, new total ₹20,250"; ₹6,750 moved to the advance. He paid ≈₹5,590 a session after the discount, so the clinic gives back ₹1,160 too much per removed session. `syncTreatment` (`courses.ts:38`) takes the full list share off and keeps the whole discount on the remaining sessions. Same rule on cancel, capped only by what is left on the invoice. |
| H3 | **Daily report "Outstanding overall" ignores part payments** | Any part-paid invoice (Swapna ₹1,000 of ₹3,500; Durga ₹25,600 of ₹32,000). Reports › Day. | "Outstanding overall ₹55,550 across 5". Billing (This month), Clinic and Reports overview all say ₹28,950. `src/modules/billing.ts:260` sums `charge.amount_paise` where status = due; the fix from last round (`chargeBalance` in `src/lib/money.ts`) was not applied here. |

## Medium

| # | Defect | Seen |
|---|---|---|
| M1 | Old invoices change when the GSTIN changes | INV-0109 was issued as "Bill of Supply · no tax is charged". After saving a GSTIN in Settings › Billing, the same invoice reprints as "Tax Invoice" with "GST included ₹2,381.04". Removing the GSTIN does the reverse to INV-0113. A printed invoice must stay as issued. |
| M2 | "Collect ₹6,400" on a discount still awaiting approval | Reception: Durga, 20% off sent for approval, ₹25,600 paid. Invoice view shows "Collect ₹6,400"; it opens "Nothing is due". The table's ⋯ menu correctly hides it (it subtracts the waiting discount, the invoice view does not: `billing.tsx:105`). |
| M3 | Procedure price shown without the discount | Kiran's Price & payments and Edit procedure say "₹27,000 for 4 sessions · about ₹6,750 each (₹32,000 less ₹5,000 refunded)". The invoice was ₹22,359.01 at that point. The per-session figure is what H2 then credits. |
| M4 | Credits and advance use print as refunds on the Daily report | Payments list shows "Advance ₹6,750" + "Advance refund −₹6,750" for a session credit, and "Advance ₹7,750" + "Advance refund −₹7,750" when the advance paid INV-0114. No money went back in either case. |
| M5 | Three different "paid" figures for one invoice | INV-0109 view: side panel Paid ₹20,609.01; print "Total paid ₹27,359.01" and "Net paid ₹15,609.01"; Billing row Paid ₹20,609.01 against Billed ₹15,609.01 (paid above billed). |
| M6 | Invoice line keeps the old session count | After cutting CO2 to 3 sessions, and after cancelling it, INV-0109 still reads "Fractional CO2 laser · 4 sessions" on screen and in print. |
| M7 | GST layout on the documents (question for the accountant) | With a GSTIN both the invoice and its receipt are titled "Tax Invoice" for the same supply. The receipt has the CGST/SGST split by rate; the invoice (the actual tax invoice) has only "GST included", no split, no SAC code. Invoice says "—" for an exempt line, receipt says "Exempt". |

## Low

1. Refund on an invoice opens with the full paid amount filled in (₹27,359.01): one careless click refunds everything.
2. Line discount in ₹ keeps any number in the box (₹99,99,99,999) while % is capped at 100; ₹ also allows paise (₹3,200.99), so totals come out in paise.
3. Paying more than "To pay" while "Use advance" is ticked takes ₹7,750 from the advance and puts ₹9,250 back, instead of using less advance.
4. Double-click on Save the bill: one invoice (correct) but two identical success toasts.
5. Search keeps offering an item already on the bill (Hydrafacial twice); packages are not searchable at all (only via the doctor's plan; intended?).
6. Bills & payments tab badge counts invoice lines, not invoices (Anjali 2 → 4 after one 2-line invoice).
7. Cancelled invoice row shows ₹0 instead of the struck original amount.
8. Cancel invoice: a short reason is rejected only after the box closes (start over); the buttons read "Cancel" and "Cancel invoice" side by side.
9. Refund on invoice after day close: no warning until submit (Record payment now warns up front).
10. Bills can still be saved after the day is closed; that day's billed figures change after close (question).
11. Record payment accepts ₹99,99,999 by UPI with no reference and no confirmation.
12. Patient header shows a red "Due ₹6,400" when all of it is a discount awaiting approval.
13. Generate invoice re-centres vertically when the reason box appears/disappears, so the dialog jumps under the cursor.
14. "Payment · UPI + Cash · 4321": the UPI reference is shown as if it were the whole payment's.
15. Refund from advance has no reference field for UPI/bank (refund on invoice has one). Vouchers share the receipt series (R-…).
16. Accounts source label "Procedures · sessions and course advances" (course advances were retired).
17. Accessibility: "Nothing now, pay later" and "Keep the extra as advance" checkboxes are announced as "on".
18. On a phone the Generate invoice item table scrolls sideways; Price/Discount/Amount are off-screen at first.
19. `AdvanceDialog` in `web/src/billing.tsx` is not used anywhere.
20. Outside billing, seen in passing: Clinic "Longest wait now −231 min".

## Fixed since round 1 (re-checked in the browser)

H1 refund re-billed, H2 three "due" totals (Billing, Clinic, Accounts, Reports overview now agree; Daily report does not, see H3), M1 status, M2 waiting discount totals, M5 hidden EMI reference (Record payment and Generate invoice), M6 toasts, M8 GST without GSTIN, M9 consultation in search, M10 duplicate treatment from search, M11 approval card amount, M12 Hydrafacial under Procedures, L4 line GST vs summary, L5 `%`/`_` search, L6 Billed count, L7 cancel from patient tab, L11 Record payment after close, L12 doctor footnote, Q1 pharmacist (uncommitted change: no Billing menu, no Bills tab, API 403 on payments/bills/account).

## Passed

- Discount box: letters, `-`, `e`, double dots stripped; 150% → 100%; 100% blocked; reason needs 3 letters (spaces don't count).
- Line % + extra % + extra ₹ maths and GST split match the receipt to the paisa (LHR ₹6,975.93 = ₹5,911.81 + ₹532.06 + ₹532.06).
- Two modes, part pay, overpay → advance; unticked → blocked; toast names the right modes and amounts.
- Collect on a part-paid invoice: line and extra discount locked.
- Record payment: junk/0/0.001 blocked, EMI needs code + lender, oldest due first, rest to advance.
- Refund on invoice: over paid blocked, two modes, reason required; refunded money not billable again.
- Refund from advance: over balance blocked, reason required, voucher printed.
- Advance auto-used on a new invoice, part + UPI; "Pay from advance" when it covers all.
- Cancel unpaid invoice; cancel paid treatment caps the credit at what is left on the invoice.
- Reception: discount goes for approval (any %), no Refund/Cancel; owner Say no → full due; Approve → bill lowered.
- GSTIN field: invalid rejected, lowercase upper-cased.
- Billing page: totals reconcile (billed − net paid = due), phone search, date min/max.
- Day close: short cash needs a note; afterwards money refused, saving a bill allowed.
- No server errors in the log.

Not exercised: EMI settlement ("Bank credit arrived"), expired package, leave out of tax reports, two desks on one invoice at once.

## Round 3: redesign, then the report re-run (16 Nov 2026)

The three highs came from the same causes: two ways to bill a treatment, issued invoices being changed, and each page computing "due" its own way. Billing is now built on four rules (`src/lib/money.ts`):

1. **A treatment is billed once, whole**: at Generate invoice, or automatically when its first session is marked done. Sessions never bill.
2. **An issued invoice never changes.** What comes off it is a numbered credit note (`CN-2026-27-0001`), worked out from what was really charged (after discount and earlier credits). Money paid above what is then owed moves to the patient's advance.
3. **Money only leaves through a refund voucher** (`RF-2026-27-0001`) from the advance. A refund on an invoice is a credit note (ticked by default) plus a voucher.
4. **One "due" rule** used by every page: amount − credit notes − money applied. GST status is fixed when the invoice is issued.

Migration 0046 converts old data (lowered lines → credit notes; old refunds → credit note + voucher from the advance). On a copy of the demo database all 25 patients balance after it.

`test/moneyFuzz.test.ts` plays 5 × 28 random real actions (invoices, discounts for approval, payments, refunds both ways, sessions done, sessions added/removed, cancels, advance, fee refunds). After every step it checks that billed − received + refunded = due − advance; that the header, invoice list, invoice view and print agree; that Clinic, Accounts and the Daily report show one due; and that vouchers print what left.

Re-run in the browser on migrated demo data, as Owner, Reception and Pharmacy:

| # | Result |
|---|---|
| H1 | Session done on a never-invoiced 6-session peel: confirm says "invoiced now, whole (₹15,000)". One invoice; Generate invoice offers no second treatment line; header Due ₹15,000. |
| H2 | CO2 ₹32,000 − ₹4,640 discount, ₹5,000 refunded: removing session 4 previews and credits −₹5,590 (was −₹6,750); ₹5,590 to the advance. |
| H3 | Clinic, Accounts, Daily report, Billing and Reports all show ₹15,000, then ₹20,500. Daily report says "on 2 invoices". |
| M1 | INV-0040 (no GSTIN) stays a Bill of Supply after a GSTIN is saved; an invoice issued with the GSTIN stays a Tax Invoice after it is removed. |
| M2 | Reception 20% for approval: no Collect button; header amber "₹6,400 discount awaiting approval"; Approve issues CN-…-0003, invoice stays ₹32,000. |
| M3 | Price panel: "₹22,360 for 4 sessions · about ₹5,590 each · invoiced at ₹32,000, less ₹4,640 discount and ₹5,000 in credit notes". |
| M4 | Daily payments list shows only money that moved (no Advance / Advance refund pairs for credits). |
| M5 | One paid figure: Billed ₹27,360 · Credit notes −₹10,590 · Paid ₹16,770 · Due ₹0, the same on the view, print and Billing row. |
| M6 | By design the invoice line keeps "4 sessions" (as issued); the credit note says "Sessions changed to 3". |
| M7 | Invoice: Tax Invoice with GSTIN, GST column, "Exempt" for 0% lines, CGST/SGST split per rate (₹266.95 + ₹266.95 = the dialog's ₹533.90). Receipts are now "Receipt" / "Refund voucher" with no tax table. SAC codes: not in the data (question below). |
| Lows | 1 refund amount empty; 2 ₹ discount whole rupees, capped at the item; 3 typed money uses less advance; 4 double-click → one invoice, one toast; 5 same item twice → qty 2; 6 tab badge counts invoices; 7 cancelled row struck at its amount; 8 reason checked inside the box, "Keep" / "Cancel invoice"; 9 refund after close warns up front; 11 Record payment asks before money goes to the advance; 12 header amber; 13 reason box keeps its room; 14 reference per mode ("UPI 4321"); 15 refund from advance has a reference, RF series; 16 Accounts label; 17 checkbox labels; 18 phone: amount in view, no sideways scroll; 19 AdvanceDialog removed; 20 longest wait never negative. |
| Pharmacy | Sale ₹120, return ₹30 → credit note CN-0001 on the pharmacy invoice, due ₹0, account balances, End of day +₹90. Pharmacist still gets 403 on accounts. |

Also fixed while re-running: Mark done now refreshes the patient header and bills at once; each move to the advance prints on its own line naming its credit note; "Bill of Supply" no longer printed twice.

Still questions for you: (10) bills can still be saved after day close (kept by design); packages are not in search (they come from the doctor's plan); SAC codes on the tax invoice need a SAC per procedure, which the price list does not have.
