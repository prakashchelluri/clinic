# Billing QA, fresh pass (16 Nov 2026)

Branch `billing/patient-account` at fd8177e. Empty database (`data/pglite-qa5`, server `cubott-qa5`, port 3140). Earlier QA documents were not read.
Roles used: owner, reception; pharmacy, coordinator, assistant and second doctor checked for access.
Patients: Anita Qa (P00001), Bala Qa (P00002), Chitra Qa (check-in after close, refused).

After every money step I checked that **billed − received + refunded = due − advance** on the patient. I also compared the same figures across the Bills tab, the Billing list, Clinic, Accounts, Reports › Day and End of day, and the printed invoice, receipt and credit note.

## High

**H1. A refund that names an unpaid item pays cash out and takes the payment off the items that were paid.**
INV-0005 is Excision ₹3,000 + Injection ₹1,000, with ₹1,000 paid by UPI (it went to Excision). I chose Refund ₹1,000 "off Intralesional injection" (take it off the invoice).
Result: ₹1,000 cash went back (RF-0002) and CN-0002 credited the injection. Excision now shows "nothing paid yet" and due stays ₹3,000. Receipt R-0005 still says "Paid INV-0005".
The desk wanted the bill reduced, not cash handed out. `invoices.ts:191-195` takes the money from the other lines when the named line has none.

**H2. An item not given on a part-paid invoice cannot be taken off without giving cash back.**
Cancel invoice is hidden once anything is paid. Generate invoice allows at most ₹999 off a ₹1,000 line, and no discount at all once that line is paid. Refund needs an amount of money out.
There is no "credit note only" action. This gap is what pushes the desk into H1.

**H3. Cash can be refunded against EMI money the lender has not paid yet.**
Record payment by EMI ₹5,000 against ₹3,000 due was accepted, and ₹2,000 went to the advance. Refund ₹2,000 cash from the advance then went through (RF-0005) before "Bank credit arrived".
EMI above what is due should be refused. EMI money should not be refundable until it is settled.

**H4. Reception can void a paid line through the API, after day close, with no approval or credit note.**
`POST /charges/:id/adjust {kind:'waived'}` needs only `payment.waive`, which reception has. I waived INV-0003 (Cryotherapy, ₹1,500 fully paid): it returned 200 after the day was closed.
INV-0003 now shows "Cancelled". The ₹1,500 received is on no invoice and not in the advance. Anita's account no longer adds up: ₹1,500 vs ₹3,000.
No screen calls this route, but it is open (`billing.ts:68-91`). It should refuse lines with money on them, and paid/issued lines in general, and respect day close.

**H5. Accounts › Not in yet › "Given back or let go" counts internal advance moves as refunds.**
It shows 13 rows totalling ₹14,516.66. Real refunds were 5 vouchers, ₹7,583.33. Rows such as "Hydrafacial · advance ₹1,000" and "Payment · advance ₹850" are bookkeeping, not money out.
`finance.ts:71-73` selects every negative payment. It should skip `method = 'advance'`.

## Medium

- **M1. The whole-bill discount can reach 100% on screen, then the server refuses it with a wrong message.**
  - Typing 100% (or ₹11,499 on ₹11,500) in Extra discount leaves Save enabled.
  - The server then answers "The discount is the whole of Hydrafacial. Ask for it to be waived instead." The user never discounted Hydrafacial, and there is no waive.
  - Cause: the per-line share is rounded to whole rupees, so the cheaper line hits 100%. The screen check (`takePayment.tsx` `tooBig`) ignores the shares.
- **M2. Changing or cancelling a course credits an averaged price, which produces paise and overcharges.**
  - Chemical peel was invoiced at ₹2,375 a session (5% off). One session was added at ₹2,500, one was done, then the course was cancelled.
  - Results: CN-0007 ₹2,333.33, advance ₹2,583.33 (refunded in cash as ₹2,583.33), and End of day "Short by ₹0.67" until I typed paise.
  - The done session now costs ₹2,416.67 instead of ₹2,375: ₹41.67 more than it was invoiced at.
- **M3. The session "Mark done" confirm says "nothing more is billed", but marking done created INV-0009 (₹2,500) and used ₹250 of the advance without asking.**
- **M4. A procedure the patient is on a course for can be billed again from the price list.** The "already on INV-…" warning shows only while the course invoice is unpaid.
- **M5. After a refund, the invoice print shows "Moved to the patient's advance (CN-…) −₹1,000"** and does not name the refund voucher, though the patient got cash.
- **M6. End of day "Money collected" shows negative cells.** Examples: Procedures EMI/other −₹1,733.33; Other cash −₹6,583.33, UPI −₹150, EMI/other +₹6,733.33. Totals are right; the rows cannot be used to reconcile.
- **M7. "Billed" means two different things.** On the patient tab it is net of credit notes (₹16,950). On the Billing list and invoice rows it is as issued. Same label, different figures for the same patient.
- **M8. Check-in after day close shows no warning.** It fails only on submit, and a fee-paying patient cannot be checked in for the rest of the day.
- **M9. Accounts Summary stays stale after "Bank credit arrived".** It still showed ₹5,000 EMI not in and ₹0 went out until the page was reloaded.

## Low

- L1. A ₹0 free consultation uses an invoice number (INV-0004, "Paid fully ₹0").
- L2. "100% off" is shown for 99.97%. The % box accepts 100, while the ₹ box stops at price − ₹1.
- L3. The refund dialog shows "GST 18%" on a Bill of Supply (no GSTIN at the time).
- L4. After day close, "Save the bill" with only old dues ticked toasts "Bill saved for Anita" though nothing was created.
- L5. After a discount is decided, the Clinic approval dialog keeps the title "1 discount above the limit to approve" over an empty list.
- L6. A rejected discount leaves no trace in the patient's account activity.
- L7. The GST tab's "6 Bills of Supply, ₹21,950" ignores the ₹2,000 of credit notes against them.
- L8. "Payment mode" adds a second mode at ₹0 instead of the rest.
- L9. UPI and card references are optional.
- L10. Copy and labelling:
  - The schedule dialog says "Anita Qa · · 3 sittings planned".
  - The cancel-procedure dialog shows a raw date ("2026-12-14 16:30").
  - The cancel reason box has no label.
- L11. After H1, Excision accepts a discount again, although money was taken on that invoice.
- L12. Bills of Supply and Tax Invoices share one INV series with no financial year in it; receipts and credit notes have the year. Ask the CA.

## Questions

- The second doctor and the coordinator can see every invoice and every patient account (`fees.see`), and the coordinator can take payments. Is that intended?
- Should the advance be used automatically when a session's invoice is raised (M3), or only on the desk's say?

## Passed

- Price-list search, quantity, % and ₹ discounts with limits and switching, reason required, extra-discount split.
- Split payment (UPI + cash), part payment, overpayment kept as advance (and blocked when unticked), triple-click on Collect (one receipt).
- Advance used first; Record payment oldest due first, with confirm for the extra.
- Refund with a credit note per item, with checks: over the line, over paid, items not adding up.
- Refund from the advance, including paise.
- Cancel unpaid invoice, with a 3-letter reason.
- Discount above the limit from reception: only the discounted amount is collectable; reject leaves the full amount due.
- GSTIN checksum, Tax Invoice CGST/SGST split, old invoices stay Bills of Supply, credit note reverses GST, GST tab totals.
- Course: invoiced whole, sessions removed credited at the charged share, added sessions at standard.
- Day close blocks payments and refunds and still allows saving bills.
- Search on the Billing list, including `%` and `_`.
- Clinic, Reports and Accounts "came in" all agree (₹19,700, then ₹25,116.67).

## Not covered

- Packages: none in the demo data.
- Pharmacy billing.
- Phone layout.
- Next-day and financial-year rollover.
- Two tabs at once.
- The real browser print dialog: the print HTML was captured instead.
- The browser pane was hidden for most of the run, so after the first invoice the screens were driven through their own buttons and inputs by script rather than by clicks on screen.

## Fixed (16 Nov 2026), re-run on a new empty database

| # | Re-run result |
|---|---|
| H1 | INV-0004 Excision ₹3,000 + Injection ₹1,000, ₹1,000 paid (to the Excision). Refund offers only the Excision ("₹1,000 paid on it"); the server refuses money back off an item nobody paid for (MORE_THAN_PAID_ON_THE_ITEM). A refund never takes money off another item (checked by the random test after every refund). |
| H2 | New **Take item off (credit note)** on the invoice menu, the invoice view and the Bills tab: CN-0001 took the injection off, no cash, Excision keeps its ₹1,000, ₹2,000 due. Anything already paid on an item taken off moves to the advance. |
| H3 | EMI above what is due is refused (screen and server). EMI that has moved to the advance cannot go back until the lender pays: with ₹3,000 in the advance and ₹2,000 unsettled EMI, Refund allows ₹1,000; after "Bank credit arrived" all of it. |
| H4 | Waive only applies to a line with no money and no credit note, with the day open: reception waiving a paid line gets "use Take item off". |
| H5 | "Given back or let go" lists only refund vouchers (RF-0001 ₹1,000), never moves into or out of the advance. |
| M1 | Extra discount stops at 99.99%; Save stays off with "The discount on the bill is too big: every item must still cost something". |
| M2 | Sessions taken off come off at their own invoice line's price, newest first: cancelling Chemical peel (3 at ₹2,375 + 1 added at ₹2,500, 1 done) credited ₹2,500 + 2 × ₹2,375; the done session stays at ₹2,375; no paise. |
| M3 | Mark done: "₹2,500 not invoiced yet is invoiced now; the patient's advance pays it first". The advance is used automatically (your answer). |
| M4 | Adding a price-list procedure the patient has a treatment for says so. |
| M5 | The invoice print lists "Given back to the patient · RF-… · mode" under the payments. |
| M6 | End of day: refund vouchers have their own row ("Refunds given back"); no other negative cells. Moves through the advance only show on the Accounts chart. |
| M7 | Bills tab: "Billed ₹5,300 · Credit notes −₹4,000", the same meaning as the Billing list. |
| M8 | Check-in after day close says so before submit when a fee would be taken. |
| M9 | Every money action refreshes Accounts and End of day. |
| Roles | New permission "See invoices and patient accounts" (fees.invoices): owner, admin, reception, coordinator. Doctor: 403 on invoices and accounts, no charges or due on the record. Coordinator takes payments. Migration 0048 adds it to saved roles. |
| Lows | L1 a ₹0 line gets no invoice number; L2 % stops at 99.99, "% off" never rounds up to 100; L3 GST shown only on Tax Invoices; L4 nothing to save is refused; L5 the approval drawer title follows the list; L6 a discount said no to (or withdrawn) shows on the patient's account; L7 Bills of Supply net of credit notes; L8 a second mode starts at what is left to pay; L9 UPI and card need a reference; L10 schedule dialog subtitle and cancel dialog dates; L11 no discount on a line that ever took money. L12 (invoice series per financial year) is for the CA. |

Also found by the random test and fixed: approving a discount after its item was taken off failed and left the request pending for ever; now it takes off what is left, or withdraws the request.

Tests: new fixed tests for each high; the random test now also checks that a refund only takes money off the item it names, that unsettled EMI never goes back, that a line with money is never waived, and that a discount request can always be decided. 151 pass; the 4 that fail were failing before this work.
