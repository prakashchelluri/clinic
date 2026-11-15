# Billing UI test — branch billing/patient-account (f996210)

Tested 15 Nov 2026 in the browser on a fresh database (server `cubott-billqa`, port 3130, sample data loaded), as owner, reception and pharmacy.
Patients used: Kiran Kumar (LHR + peel + CO2), Durga Prasad (CO2, discount approval), Sowmya (advance only), Anjali Reddy (Glow combo package).
Automated tests: `bills`, `procBilling`, `procSettings`, `wave5` — 11/11 pass. None of them catch the defects below.

## High

| # | Defect | Steps | Seen |
|---|---|---|---|
| H1 | **A refund on an invoice makes the refunded money billable again** | Invoice CO2 ₹32,000 (INV-0034), take ₹5,355, refund ₹5,355 on the invoice | Invoice drops to ₹26,645. Generate invoice now offers "Fractional CO2 · 4 sessions, **the rest ₹5,355**". Procedures card: "₹32,000 still to pay". Price & payments: "nothing paid yet · ₹32,000 still to pay" with a Generate invoice button. The refund lowers the charge (`/bills/:id/refund`), and the course counts invoiced = sum of charge amounts, so the gap reappears as uninvoiced. |
| H2 | **Owner screens show three different "due" totals** | Any part-paid invoice | Billing: Due ₹40,444 (correct). Clinic: "₹50,645 still due from 2 patients". Accounts: "Not in yet ₹65,645 from 3 patients". Reports: "Still due ₹0". `dayclose.ts:130` sums `charge.amount_paise` where status = due and ignores part payments. |

## Medium

| # | Defect | Seen |
|---|---|---|
| M1 | Invoice status "Refunded" while money is still due | INV-0034 after refunding everything paid: chip "Refunded", Due ₹26,645 in red. `billViews` checks refunded ≥ paid before due. |
| M2 | Discount awaiting approval breaks the totals | Reception: 20% off CO2 ₹24,000, takes ₹5,000. Header "Due ₹19,000", Bills tab "Due ₹14,200". After Record payment ₹14,200: invoice "Paid fully" (₹19,200 of ₹24,000), tab Due ₹0, header Due ₹4,800. The pending ₹4,800 is not shown anywhere on the patient tab. |
| M3 | Printed invoice wrong after a treatment is cancelled | INV-0033 after cancelling LHR: row prints "₹3,480 − ₹3,480 = ₹0" (it was ₹24,000) and is not marked cancelled. Payment lines add to ₹27,645 against "Total paid ₹7,125". The ₹20,520 credit prints in red as "Refund Advance −₹20,520", although the commit says a credit is not shown as a refund. |
| M4 | Advance hidden when anything is due | Kiran: strip shows "Due ₹26,645" only; the ₹20,520 advance is not shown. The patient's net position is ₹6,125 owed. |
| M5 | Hidden reference saved on the payment | Record payment: EMI, type approval code, switch to Cash, record. Saved as "Cash · EMI-STALE-REF". The same state pattern exists in Generate invoice's payment modes. |
| M6 | Success toast names the wrong mode and amount | "Nothing now" with advance used: "₹355 UPI + the advance" (no UPI taken). Hydrafacial ₹3,500 = ₹1,500 advance + ₹2,000 cash: "₹3,500 cash + the advance". The printed receipt is correct. |
| M7 | One payment prints as several lines | UPI ₹10,000 prints on the invoice as UPI ₹7,125 + UPI ₹2,875. Receipt R-0001 lists LHR twice. |
| M8 | GST shown on a clinic with no GSTIN | Generate invoice shows "GST 18%" and "of which GST ₹3,130"; the printed bill says "Bill of Supply… no tax is charged". |
| M9 | Consultation billable and discountable from Generate invoice | Search "consult" adds "New consultation ₹300" (also for a patient with no visit), and its discount box is enabled. This bypasses "consultation fees take no discount / taken at check-in". |
| M10 | Double-billing risk from search | Kiran has an un-invoiced CO2 treatment listed. Searching "co2" adds a separate one-off "CO2 ₹8,000" with no warning. |
| M11 | Stale amount on the approval card | Owner sees "₹5,000 taken on that bill" after ₹19,200 has been taken (`paidPaise` is stored only at ask time). |
| M12 | Price-list procedure counted as "Other" in End of day | Hydrafacial ₹2,000 cash shows under Other, not Procedures. |
| Q1 | Question: pharmacist sees the clinic-wide Billing page and can record payments on procedure invoices | Pharmacy login → Billing visible; `POST /patients/:id/payments` returned 200 (₹1 recorded on INV-0034 as proof). Intended? |

## Low

1. A ₹0 free-consult invoice reads "nothing paid yet" next to "Paid fully".
2. Invoice item order flips between loads (lines share a timestamp).
3. % discount takes 3 decimals (1.259%) and gives paise totals (₹23,697.84).
4. The line's GST and Amount columns ignore the extra bill discount (row ₹3,294.92 vs summary ₹3,130.17).
5. Billing search: `%` and `_` match every invoice; one request per keystroke; a search miss says "No invoices in these dates".
6. "Billed (35)" counts cancelled invoices.
7. Cancel invoice exists only on the Billing page, not the patient tab; its confirm button reads "Save".
8. Reception: the ⋯ menu opens empty on INV-0036.
9. Refund from the advance has no voucher number or print; receipts don't name the invoice they paid.
10. A treatment stays price-locked after its only invoice is cancelled (question).
11. After day close, Record payment and Generate invoice still open; the error only appears on submit. "Nothing now" with advance use is also blocked although no money moves.
12. Stale text on Clinic: "course advances are not split by doctor".
13. Accessibility: the disabled Refund button's name is its tooltip; End of day "Why" box has no label.
14. The Generate invoice dialog keeps stale lines after another desk invoices the same treatment (the server refuses correctly).

## Passed

- Discount box: letters and symbols stripped; >100% capped; ₹ above the price capped; 100% blocked ("The discount is the whole of…"); reason needed (≥3 letters).
- Line + extra discount maths and GST split match the server to the paisa (₹31,500 − ₹3,855 = ₹27,645).
- Two payment modes, part payment, overpay → "Keep the extra as advance"; unticked → blocked.
- Double-click on Collect: two POSTs, one invoice, one receipt (idempotency key).
- Record payment: zero blocked, EMI needs lender + code, oldest due first, extra → advance.
- Invoice refund: more than paid blocked; reason required.
- Advance: take, refund (over balance and short reason blocked), auto-used on the next invoice, untick works.
- Cancel unpaid invoice → treatment billable again.
- Package: lines tick together; server refuses half a package; a stale dialog gets "already on an invoice".
- Cancel paid treatment → invoice lowered, money to advance, totals reconcile (billed − received + refunded = due − advance).
- Qty stepper 1–20.
- Permissions: reception has no Refund / Cancel / approve; the API returns 403 for refund, advance refund and approve; negative amounts and paying from an empty advance are refused.
- Discount approval: reception's 20% goes for approval; owner Say no → ₹4,800 due again.
- Day close: short cash needs a note; after close, money is refused with a clear message.

Not exercised in the UI: per-session billing of a never-invoiced treatment (Start session was blocked on consent), EMI settlement, expired package, approve path (server tests cover it).
