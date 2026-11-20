# Billing per patient: fresh UI test (16 Nov 2026)

Branch `billing/patient-account` (d5e589c), fresh empty database, web rebuilt from the branch.
Tested in the browser as owner, receptionist, coordinator, second doctor, assistant and pharmacist.
Two test patients: Anita Rao (P00001) and Ravi Kumar (P00002). 11 invoices, 11 receipts, 7 credit notes, 6 refund vouchers, 1 EMI, day closed.

The account always added up (billed − received + refunded = due − advance) after every step, and the
day's money matched on every page: ₹46,763 in, ₹9,000 refunded, ₹37,763 collected
(cash ₹15,501, UPI ₹21,262, EMI ₹1,000) on Day report, End of day, Accounts and Clinic.

## Defects

### High

| # | What | How to repeat | Seen |
|---|------|---------------|------|
| H1 | **A discount at collection rewrites an invoice already issued.** | Generate invoice, Excision biopsy ₹3,000, *Nothing now, pay later*, print. Collect ₹3,000 → 10% discount, reason, cash. | INV-0002 printed ₹3,000 / due ₹3,000; the same number now prints ₹3,000 − ₹300 = ₹2,700, no credit note. An approved discount (INV-0006) does use a credit note, so the same thing is recorded two ways. |
| H2 | **Refund on an invoice cannot say which item; the credit note picks a line itself.** | INV-0008: Laser hair reduction ₹4,000 (18%) + Chemical peel ₹2,500 (exempt), ₹500 off, paid. Refund ₹3,000, reason "Laser not done", with credit note. | CN-2026-27-0005 takes ₹2,307.69 off **Chemical peel** (now fully credited) and only ₹692.31 off the laser. Wrong item and wrong GST reversed. The line is the "newest", and lines created together tie, so it is effectively random. |
| H3 | **Credit note print against a Tax Invoice shows no GST, and says the money went to the advance when it was paid out.** | Print CN-2026-27-0005 (or CN-0001). | No taxable value, CGST or SGST. "Moved to the patient's advance ₹3,000", but the ₹3,000 left as refund RF-2026-27-0006. |
| H4 | **Sessions removed and then added back are never billed (revenue leak).** | Ravi: doctor plans Fractional CO2 ×4 at ₹28,000. Invoice it, pay ₹20,000. Edit procedure → remove 2 sessions (credit note ₹14,000, ₹6,000 to advance). Edit → Add session (dialog shows +₹8,000). | Generate invoice: "Nothing is due". Procedures: "0/3 sessions · Fully paid". Price & payments: "₹14,000 for 3 sessions". The course counts ₹28,000 as invoiced and ignores the credit note, so nothing is left to invoice. The patient gets 3 sessions for ₹14,000 and can still get the ₹6,000 advance refunded. |

### Medium

| # | What | Seen |
|---|------|------|
| M1 | Refunds have no server-side duplicate guard (Record payment and Generate invoice do). | Two clicks in the same instant on "Give back ₹2,000" gave 2 refunds, 2 credit notes (CN-0001, CN-0002) and 2 vouchers on INV-0004. A human double-click 80 ms apart was blocked by the button, so the risk is a retry, a slow network or two tabs. |
| M2 | Invoice lines come out in random order when added together. | Entered Chemical peel then Hydrafacial, but INV-0001 prints Hydrafacial first. The same order decides which line money goes to (receipt R-0002 says the ₹462 paid "Hydrafacial"). |
| M3 | A discount request stays pending after its invoice is cancelled. | INV-0011 cancelled. The ₹500 request still shows in the owner's "Needs you", and the desk's Generate invoice still says "Waiting for approval: ₹500 off". |
| M4 | "Leave out of tax reports" has no tax report to leave anything out of. | There is no GST / tax-collected report anywhere. The action only adds a chip, and staff can mark Tax Invoices as excluded, which is a compliance risk. |
| M5 | GSTIN check accepts any 15 letters or digits. | "ABCDEFGHIJKLMNO" was accepted (Save enabled). This prints on every Tax Invoice. |
| M6 | Billing list and its totals stop silently at 500 invoices (code: `billViews` limit 500). | Not reproduced. At about 17 invoices a day, "This month" would show wrong totals with no warning. |
| M7 | Approve / Say no on a discount act on one click, and the request does not name the invoice. | One misclick rejects; the owner can't tell which INV it is. |

### Low

| # | What |
|---|------|
| L1 | Generate invoice: the Amount column is off-screen at 1024 px wide (horizontal scroll inside the table) and at phone width. |
| L2 | Amount boxes take up to ₹99,99,999; the server limit is ₹10,00,000. The error only comes after "Take ₹20,00,000 as advance?" is confirmed. |
| L3 | EMI "Bank credit arrived" with a fee larger than the EMI says only "Something went wrong. Please try again." |
| L4 | Adding a second payment mode clears the filled-in amount: Paying now drops to ₹0 and the button becomes "Pay ₹5,000 from advance", so ₹462 is left due unless typed. |
| L5 | A whole-rupee extra discount is split into paise per line (−₹175.30, −₹362.70 on INV-0001). |
| L6 | Invoice print leaves out the discount reason. A cancelled invoice print leaves out why and when, and shows Subtotal ₹0 beside a struck ₹1,500. |
| L7 | The credit note print says "Credit note" twice in its header. |
| L8 | Day report methods read "Upi", "Emi", "Upi refund" (should be UPI / EMI). A refund on an invoice reads "Refund from the advance" without the invoice number. |
| L9 | Invoices are INV-0001 with no financial year, while receipts, credit notes and refunds are R-/CN-/RF-2026-27-0001. Confirm the per-year series with the CA. |
| L10 | The same procedure can be billed again while an unpaid invoice for it exists, with no warning (Hydrafacial INV-0007 + a new Hydrafacial). |
| L11 | Clinic "₹4,700 still due" included ₹700 of discounts waiting for approval. |
| L12 | Accounts "Where it came from": an advance stays under "Other" even after it pays a procedure, while procedure refunds come off "Procedures", so procedures read low. |
| L13 | The Tax Invoice has no SAC code or place of supply (confirm with the CA). |
| L14 | API: `POST /charges` lets anyone with "Collect payments" create a charge of any amount and tax rate, which skips "prices are never typed". |

## Passed

- Advance by Record payment, receipt R-…; junk typed into amounts is cleaned; amount over the server limit is refused.
- Line discount: % over 100 capped, ₹ capped below the price, 100% refused, reason required (min 3 letters).
- Extra discount shared across lines the same on screen and on the server; 9% shown and saved.
- One bill paid by advance + UPI + cash; one receipt; invoice, receipt and voucher prints correct.
- Pay later; part payment; Collect from the invoice; Record payment clears oldest dues first, rest to advance; double confirm records once.
- Cancel invoice: reason checked (spaces refused), struck through, totals drop.
- Refund on invoice: more than paid refused, reason required; with credit note (due unchanged) and without (due again).
- Refund from advance; more than the advance refused; Refund button off when the advance is empty.
- Receptionist discount → approval; only the discounted amount taken; owner Approve → credit note; Say no → full amount due.
- GST: 18% inside the price, CGST/SGST split exactly, exempt line listed; invoices issued before the GSTIN still print as Bill of Supply.
- Billing list search by name, phone, invoice no; `%` and `_` safe; tiles match the rows.
- Doctor's plan → whole treatment on one invoice; cancel procedure → credit note; fewer sessions → overpaid part to advance.
- EMI needs lender + approval code; EMI awaiting; bank credit matched with fee booked as an expense.
- Permissions on the server: doctor sees only; coordinator collects but cannot refund; assistant and pharmacist see no money.
- Day close: count matches, closes; afterwards no payment or refund, paying from the advance still works and Collected does not change.

## Not covered

Packages (none set up in a fresh clinic), pharmacy bills on the patient account, a financial-year rollover,
two people working on one patient at once, the browser's real print dialog (print HTML was checked), and a junior doctor with fees hidden.

## Fixed (16 Nov 2026), re-run on a new empty database

Rules the code can no longer break:
- **Issued lines are frozen in the database** (migration 0047, trigger `charge_frozen`): any change to an issued line's amount, discount, GST, description, invoice or position is refused, whatever code tries it. A discount at issue is printed on the invoice; any later discount is a credit note.
- **Every refund carries a request key**, unique in the database: a retry, a slow network or a second tab returns the first refund.
- **Lines keep the order entered** (`line_no`): print order and payment order.
- **Treatments count sessions**: invoice lines say how many sessions they bill, credit notes how many they take back, so sessions added back are always billable.

| # | Re-run result |
|---|---|
| H1 | INV-0003 Excision biopsy ₹3,000, Collect with 10%: invoice still ₹3,000, credit note CN-2026-27-0001 "Discount: Known patient" ₹300, ₹2,700 paid, ₹0 due. The database refuses a direct change to the line. |
| H2 | INV-0004 Laser ₹3,692 (18%) + Chemical peel ₹2,308: the refund dialog asks how much comes off each item (with its GST). ₹3,000 off the laser → CN-0002 entirely on the laser at 18%. A two-item refund without items is refused (SAY_WHICH_ITEM). |
| H3 | CN-0002 print: GST column, "Taxable value reversed at 18% ₹2,542.37 · CGST ₹228.81 · SGST ₹228.82", "Given back to the patient · voucher RF-2026-27-0001 ₹3,000". A discount credit note says "Taken off what was due". |
| H4 | Ravi CO2 ×4 ₹28,000, ₹20,000 paid, cut to 2 (−₹14,000, ₹6,000 to advance), Add session: "0/3 sessions · ₹8,000 still to pay"; Generate invoice offers "1 session added" ₹8,000, paid from the ₹6,000 advance + ₹2,000. |
| M1 | The same refund sent twice at the same instant: one voucher (RF-0002), one credit note. |
| M2 | Lines print and take payments in the order entered (Laser, then Peel). |
| M3 | Cancelling INV-0007 withdrew its ₹700 request: nothing left in "Needs you". |
| M4 | Accounts › GST: Tax Invoices by rate less credit notes (₹19,230.50 taxable, CGST/SGST ₹1,730.75 each, exempt ₹4,608, checked by hand), lists, download, and the invoices the owner left out. "Leave out of tax reports" is owner only (desk: 403). |
| M5 | GSTIN needs the format and the check character: "ABCDEFGHIJKLMNO" refused on screen and by the server. |
| M6 | Billing totals cover every invoice in the dates; the list shows the newest 500 and says so. |
| M7 | Approval card names INV-0007; Approve and Say no ask first. |
| Lows | L1 compact table up to 1280 px; L2 amounts stop at ₹10,00,000; L3 EMI fee above the payment explained and blocked; L4 a second mode keeps the first amount; L5 extra discount in whole rupees (−₹308 / −₹192); L6 discount reason and cancel reason printed, cancelled invoice prints struck with why; L7 "Credit Note" once; L8 UPI/EMI in capitals, refunds name their invoice; L10 warns when the item is already on an unpaid invoice; L11 Clinic due says how much is awaiting approval; L12 advance money moves to Procedures when it pays one, refunds come out of "Advances & other" (₹27,300 on Day report, End of day, Accounts, Clinic); L14 `POST /charges` is settings-only. |

`test/moneyFuzz.test.ts` now checks against its own expected results after every step of 7 × 32 random actions (including item refunds, discounts at Collect, cuts then add-backs, double refunds): invoices never change, sessions billed − taken back + not invoiced = planned, nothing free, credit-note GST adds up. It found one more bug on the way (cancelling left the unused sessions planned at ₹0), now fixed.

For the accountant (not changed): L9 invoice series per financial year, L13 SAC code and place of supply on the Tax Invoice, and whether bills may be saved after the day is closed.
