import {
  pgTable, uuid, text, integer, boolean, timestamp, date, jsonb, numeric, bigint, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const id = () => uuid('id').primaryKey().defaultRandom();

export const tenant = pgTable('tenant', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  kind: text('kind').notNull().default('clinic'), // clinic | platform
  settings: jsonb('settings').$type<Record<string, any>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// every tenant-scoped table starts with these
const tenantCols = {
  id: id(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  createdAt: ts('created_at').notNull().defaultNow(),
};

export const branch = pgTable('branch', { ...tenantCols, name: text('name').notNull(), address: text('address') });

export const appUser = pgTable('app_user', {
  ...tenantCols,
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(), // primary role, kept for display
  roles: text('roles').array().notNull().default([]), // all roles; permissions are the union
  practitionerId: uuid('practitioner_id'),
  active: boolean('active').notNull().default(true),
}, (t) => [uniqueIndex('user_email').on(t.tenantId, t.email)]);

export const specialty = pgTable('specialty', { ...tenantCols, key: text('key').notNull(), name: text('name').notNull(), sourcePack: text('source_pack') });

export const practitioner = pgTable('practitioner', {
  ...tenantCols,
  name: text('name').notNull(),
  regNo: text('reg_no'),
  qualification: text('qualification'),
  specialtyId: uuid('specialty_id').references(() => specialty.id),
  // Weekly routine, set once: { days: { "1": [["10:00","12:00"],["15:00","19:00"]], ... }, capacity: 7, windowMinutes: 60 }. OP windows are generated from it on demand.
  routine: jsonb('routine').$type<Routine | null>(),
  active: boolean('active').notNull().default(true),
});
export type Routine = { days: Record<string, [string, string][]>; capacity: number; windowMinutes: number };

export const formDefinition = pgTable('form_definition', {
  ...tenantCols,
  key: text('key').notNull(),          // 'encounter' | 'intake'
  specialtyId: uuid('specialty_id').references(() => specialty.id),
  version: integer('version').notNull().default(1),
  schema: jsonb('schema').$type<FormSchema>().notNull(),
  active: boolean('active').notNull().default(true),
});

export const feeCategory = pgTable('fee_category', {
  ...tenantCols,
  code: text('code').notNull(),
  name: text('name').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  priority: integer('priority').notNull().default(0),
  affectsCapacity: boolean('affects_capacity').notNull().default(true),
  eligibility: jsonb('eligibility').$type<Record<string, any> | null>(), // JSONLogic
  eligibilityNote: text('eligibility_note'),
  active: boolean('active').notNull().default(true),
}, (t) => [uniqueIndex('fee_code').on(t.tenantId, t.code)]);

export const medicine = pgTable('medicine', {
  ...tenantCols,
  name: text('name').notNull(),
  form: text('form'),            // tab | cap | cream | gel | lotion | syrup | inj
  strength: text('strength'),
  scheduleClass: text('schedule_class'), // H | H1 | X | OTC
  mrpPaise: integer('mrp_paise').notNull().default(0), // price per unit, GST included
  gstBp: integer('gst_bp').notNull().default(1200),   // 1200 = 12%
  hsn: text('hsn'),
  defaults: jsonb('defaults').$type<{ dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string }>(),
  packSize: integer('pack_size').notNull().default(1),         // tablets in the strip the MRP is for; 1 for a tube or bottle
  reorderLevel: integer('reorder_level').notNull().default(0), // low stock below this many packs
});

export const procedureCatalog = pgTable('procedure_catalog', {
  ...tenantCols,
  specialtyId: uuid('specialty_id').references(() => specialty.id),
  name: text('name').notNull(),
  typicalMinutes: integer('typical_minutes').notNull().default(30),
  requiresMainDoctor: boolean('requires_main_doctor').notNull().default(false),
  requiresReview: boolean('requires_review').notNull().default(false),
  pricePaise: integer('price_paise'),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  typicalSittings: integer('typical_sittings').notNull().default(1),
  requiredCapability: text('required_capability'), // e.g. 'laser': only rooms tagged with it qualify
  bufferMinutes: integer('buffer_minutes').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export type PatientFlags = { vip?: boolean; family?: boolean; careful?: { note: string; by: string; at: string } };
export const patient = pgTable('patient', {
  ...tenantCols,
  patientNo: text('patient_no').notNull(),
  fullName: text('full_name').notNull(),
  sex: text('sex'),
  ageYears: integer('age_years'),
  dob: date('dob'),
  phone: text('phone'),              // shared by families; never unique
  locality: text('locality'),
  referralCard: boolean('referral_card').notNull().default(false),
  allergies: text('allergies'),
  history: jsonb('history').$type<Record<string, { yes: boolean; note?: string }>>().notNull().default({}), // diabetes, thyroid, bp, other: asked once, confirmed at each visit
  flags: jsonb('flags').$type<PatientFlags>().notNull().default({}),   // VIP, Family and friends, Handle carefully (with a reason)
  guardianId: uuid('guardian_id'),           // a minor's parent has their own record
  contactLabel: text('contact_label'),       // who answers this phone: mother, father…
  notes: text('notes'),
  legacyId: text('legacy_id'),
  consents: jsonb('consents').$type<Record<string, { grantedAt: string; by: string }>>().notNull().default({}),
}, (t) => [uniqueIndex('patient_no').on(t.tenantId, t.patientNo), index('patient_phone').on(t.tenantId, t.phone)]);

// OP availability block: doctor × day × time window × practical capacity
export const session = pgTable('session', {
  ...tenantCols,
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  practitionerId: uuid('practitioner_id').references(() => practitioner.id),
  day: date('day').notNull(),
  startTime: text('start_time').notNull(), // 'HH:MM' local
  endTime: text('end_time').notNull(),
  capacity: integer('capacity').notNull(),
  note: text('note'),
  source: text('source').notNull().default('manual'), // manual | routine
}, (t) => [index('session_day').on(t.tenantId, t.day)]);

export const appointment = pgTable('appointment', {
  ...tenantCols,
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  sessionId: uuid('session_id').notNull().references(() => session.id),
  status: text('status').notNull().default('booked'), // requested | booked | confirmed | arrived | cancelled | no_show
  source: text('source').notNull().default('phone'), // phone | walk_in | online | repeat
  note: text('note'),
  overbooked: boolean('overbooked').notNull().default(false),
  idempotencyKey: text('idempotency_key'),
  serviceId: uuid('service_id'),
  seriesId: uuid('series_id'),          // repeat bookings share one id
  publicToken: text('public_token'),    // the patient's confirm / cancel / reschedule link
  confirmedAt: ts('confirmed_at'),
  cancelReason: text('cancel_reason'),
}, (t) => [uniqueIndex('appt_idem').on(t.tenantId, t.idempotencyKey), uniqueIndex('appt_token').on(t.publicToken), index('appt_series').on(t.tenantId, t.seriesId)]);

/** Statuses that hold a place in a window, and the ones still ahead of arrival (movable, cancellable). */
export const HOLDS_PLACE = ['requested', 'booked', 'confirmed', 'arrived'] as const;
export const OPEN_STATUSES = ['requested', 'booked', 'confirmed'] as const;

/** What patients book ("visit types"). Clinic-defined; colour shows on the calendar. */
export const service = pgTable('service', {
  ...tenantCols,
  name: text('name').notNull(),
  description: text('description'),
  minutes: integer('minutes').notNull().default(60),
  pricePaise: integer('price_paise'),
  feeCategoryId: uuid('fee_category_id'),   // suggested at check-in
  color: text('color').notNull().default('#3A5A78'),
  bufferMinutes: integer('buffer_minutes').notNull().default(0),
  places: integer('places').notNull().default(1), // OP places one booking uses
  practitionerIds: uuid('practitioner_ids').array().notNull().default([]), // empty = every doctor
  onlineBookable: boolean('online_bookable').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

/** Outbox: every patient message, rendered when queued, sent by the dispatcher. */
export const message = pgTable('message', {
  ...tenantCols,
  patientId: uuid('patient_id'),
  appointmentId: uuid('appointment_id'),
  kind: text('kind').notNull(),        // confirmation | requested | reminder | cancelled | moved | declined
  channel: text('channel').notNull(),  // whatsapp | sms | none
  toPhone: text('to_phone'),
  body: text('body').notNull(),
  params: jsonb('params').$type<Record<string, string>>().notNull().default({}),
  status: text('status').notNull().default('pending'), // pending | sent | logged | failed | skipped
  sendAfter: ts('send_after').notNull().defaultNow(),
  sentAt: ts('sent_at'),
  attempts: integer('attempts').notNull().default(0),
  error: text('error'),
  providerRef: text('provider_ref'),
  broadcastId: uuid('broadcast_id'),   // set when the message belongs to a bulk send
}, (t) => [index('msg_due').on(t.status, t.sendAfter), index('msg_appt').on(t.tenantId, t.appointmentId)]);

// A bulk message to many patients: what was said, to whom (as messages), by whom. Demo until WhatsApp is connected.
export const broadcast = pgTable('broadcast', {
  ...tenantCols,
  title: text('title').notNull(),
  body: text('body').notNull(),
  audience: text('audience').notNull(),            // all | recent | lapsed | followup | course | pick
  audienceLabel: text('audience_label').notNull(),
  recipients: integer('recipients').notNull(),
  skipped: integer('skipped').notNull().default(0), // matched but had no valid mobile number
  mode: text('mode').notNull().default('demo'),     // demo: recorded, not sent
  createdBy: uuid('created_by').notNull(),
}, (t) => [index('broadcast_at').on(t.tenantId, t.createdAt)]);

export const visit = pgTable('visit', {
  ...tenantCols,
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  appointmentId: uuid('appointment_id').references(() => appointment.id),
  practitionerId: uuid('practitioner_id').references(() => practitioner.id),
  feeCategoryId: uuid('fee_category_id').notNull().references(() => feeCategory.id),
  day: date('day').notNull(),
  opNumber: text('op_number').notNull(),
  arrivedAt: ts('arrived_at').notNull().defaultNow(),
  details: jsonb('details').$type<Record<string, any>>().notNull().default({}), // weight, locality, complaint
  status: text('status').notNull().default('waiting'), // waiting | intake | in_consult | done | left
  queuePosition: numeric('queue_position').notNull(),  // fractional inserts, no renumbering
  priority: integer('priority').notNull().default(0),
  idempotencyKey: text('idempotency_key'),
}, (t) => [index('visit_day').on(t.tenantId, t.day), uniqueIndex('visit_idem').on(t.tenantId, t.idempotencyKey)]);

export const encounter = pgTable('encounter', {
  ...tenantCols,
  visitId: uuid('visit_id').notNull().references(() => visit.id),
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  practitionerId: uuid('practitioner_id').references(() => practitioner.id),
  formDefinitionId: uuid('form_definition_id').notNull().references(() => formDefinition.id),
  data: jsonb('data').$type<Record<string, any>>().notNull().default({}),
  status: text('status').notNull().default('draft'), // draft | completed
  completedAt: ts('completed_at'),
  provenance: jsonb('provenance').$type<Record<string, any>>().notNull().default({ source: 'typed' }),
}, (t) => [index('enc_patient').on(t.tenantId, t.patientId)]);

export const prescriptionItem = pgTable('prescription_item', {
  ...tenantCols,
  encounterId: uuid('encounter_id').notNull().references(() => encounter.id),
  medicineId: uuid('medicine_id').references(() => medicine.id),
  name: text('name').notNull(),
  dose: text('dose'), route: text('route'), frequency: text('frequency'),
  durationDays: integer('duration_days'), instructions: text('instructions'),
  sortOrder: integer('sort_order').notNull().default(0),
  dispensed: boolean('dispensed').notNull().default(false), // something was issued at the counter
  issuedQty: integer('issued_qty').notNull().default(0),   // packs issued so far, across bills
  notIssuedReason: text('not_issued_reason'),              // why the rest was not issued (optional)
});

export const room = pgTable('room', {
  ...tenantCols,
  branchId: uuid('branch_id').notNull().references(() => branch.id),
  name: text('name').notNull(),
  capabilities: text('capabilities').array().notNull().default([]), // e.g. ['laser', 'minor_ot']
  active: boolean('active').notNull().default(true),
});

// Time the doctor is NOT available for OP: breaks, leave, procedures. Reduces window capacity proportionally.
export const calendarBlock = pgTable('calendar_block', {
  ...tenantCols,
  practitionerId: uuid('practitioner_id').references(() => practitioner.id),
  roomId: uuid('room_id').references(() => room.id),
  day: date('day').notNull(),
  startTime: text('start_time').notNull(), // HH:MM local
  endTime: text('end_time').notNull(),
  kind: text('kind').notNull(), // break | leave | procedure | other | late (zero length: running late, no places lost) | stop (no new bookings)
  note: text('note'),
  procedureSessionId: uuid('procedure_session_id'),
}, (t) => [index('block_day').on(t.tenantId, t.day)]);

// One sitting of a procedure course, scheduled against a room and a practitioner.
export const procedureSession = pgTable('procedure_session', {
  ...tenantCols,
  recommendationId: uuid('recommendation_id').notNull(),
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  procedureId: uuid('procedure_id').references(() => procedureCatalog.id),
  practitionerId: uuid('practitioner_id').references(() => practitioner.id),
  roomId: uuid('room_id').references(() => room.id),
  sittingNo: integer('sitting_no').notNull().default(1),
  day: date('day').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  state: text('state').notNull().default('confirmed'), // confirmed | in_progress | completed | missed | cancelled | postponed
  stateReason: text('state_reason'),
  notes: text('notes'),
  outcome: jsonb('outcome').$type<Record<string, any>>(),
  patientConfirmedAt: ts('patient_confirmed_at'), // the coordinator spoke to the patient; cleared when the sitting moves
}, (t) => [index('psession_day').on(t.tenantId, t.day)]);

// doctor's plan → worklists. One table serves both follow-up and procedure recommendations.
export const recommendation = pgTable('recommendation', {
  ...tenantCols,
  encounterId: uuid('encounter_id').notNull().references(() => encounter.id),
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  kind: text('kind').notNull(),            // followup | procedure
  procedureId: uuid('procedure_id').references(() => procedureCatalog.id),
  dueOn: date('due_on'),
  sittings: integer('sittings'),
  notes: text('notes'),
  status: text('status').notNull().default('open'), // open | contacted | scheduled | done | cancelled (for a test: open = pending, done = report received)
  contactLog: jsonb('contact_log').$type<{ at: string; by: string; outcome: string; note?: string }[]>().notNull().default([]),
  // Tests only. Tests ordered together share an order number; the doctor reviews an order once, when every test in it is received.
  orderNo: integer('order_no').notNull().default(1),
  expectedOn: date('expected_on'),
  receivedAt: ts('received_at'),
  reviewedAt: ts('reviewed_at'),
  reviewOutcome: text('review_outcome'), // normal | change_medicines | needs_visit | will_call
  reviewNote: text('review_note'),
  reviewedBy: text('reviewed_by'),
  informedAt: ts('informed_at'),
  informedHow: text('informed_how'),     // in_person | phone | whatsapp
  informedBy: text('informed_by'),
}, (t) => [index('rec_status').on(t.tenantId, t.kind, t.status)]);

export const charge = pgTable('charge', {
  ...tenantCols,
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  visitId: uuid('visit_id').references(() => visit.id),
  description: text('description').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  status: text('status').notNull().default('due'), // due | paid | waived | refunded
  adjustmentReason: text('adjustment_reason'),
  adjustedBy: uuid('adjusted_by'),
});

export const payment = pgTable('payment', {
  ...tenantCols,
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  chargeId: uuid('charge_id').references(() => charge.id), // ponytail: direct link; payment_allocation table when packages/partials arrive
  amountPaise: integer('amount_paise').notNull(),
  method: text('method').notNull(), // cash | upi | card | bank
  reference: text('reference'),
  receivedBy: uuid('received_by').notNull(),
  receivedAt: ts('received_at').notNull().defaultNow(),
  idempotencyKey: text('idempotency_key'),
}, (t) => [uniqueIndex('pay_idem').on(t.tenantId, t.idempotencyKey), index('pay_at').on(t.tenantId, t.receivedAt)]);

// A pharmacy counter sale: prices come from the medicine catalogue, GST is inside the price, one invoice number per sale.
export const pharmacySale = pgTable('pharmacy_sale', {
  ...tenantCols,
  invoiceNo: text('invoice_no').notNull(),
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  chargeId: uuid('charge_id').references(() => charge.id),
  items: jsonb('items').$type<SaleLine[]>().notNull(),
  grossPaise: integer('gross_paise').notNull(),      // sum of lines at MRP
  discountPaise: integer('discount_paise').notNull().default(0),
  gstPaise: integer('gst_paise').notNull(),          // GST contained in the total
  totalPaise: integer('total_paise').notNull(),
  method: text('method').notNull(),                  // cash | upi | card | split
  reference: text('reference'),
  receivedPaise: integer('received_paise'),          // cash handed over, for change
  createdBy: uuid('created_by').notNull(),
  encounterId: uuid('encounter_id'),                 // the prescription this bill issued against
  payments: jsonb('payments').$type<{ method: string; amountPaise: number; reference: string | null }[]>().notNull().default([]),
  returns: jsonb('returns').$type<SaleReturn[]>().notNull().default([]),
}, (t) => [uniqueIndex('pharmacy_invoice').on(t.tenantId, t.invoiceNo), index('pharmacy_sale_at').on(t.tenantId, t.createdAt)]);

export type SaleLine = { medicineId: string; name: string; hsn: string | null; qty: number; mrpPaise: number; gstBp: number; amountPaise: number;
  batchId?: string | null; batchNo?: string | null; expiry?: string | null; prescriptionItemId?: string | null };
export type SaleReturn = { creditNoteNo: string; at: string; by: string; reason: string; method: string; reference: string | null; refundPaise: number; lines: { line: number; qty: number; amountPaise: number }[] };

// --- pharmacy stock ---
// Who the clinic buys from.
export const vendor = pgTable('vendor', {
  ...tenantCols,
  name: text('name').notNull(),
  phone: text('phone'),
  gstin: text('gstin'),
  address: text('address'),
  note: text('note'),
  active: boolean('active').notNull().default(true),
});

/**
 * One stock document: a purchase order (the vendor's promise), a receipt (what the bill and the box say), a return to
 * the vendor, or a stock count. Lines are kept on the document; stock itself lives in stock_batch and stock_move.
 */
export const stockDoc = pgTable('stock_doc', {
  ...tenantCols,
  kind: text('kind').notNull(),        // order | receipt | return | count
  docNo: text('doc_no').notNull(),     // PO-0001 · GRN-0001 · RT-0001 · CNT-0001
  vendorId: uuid('vendor_id').references(() => vendor.id),
  orderId: uuid('order_id'),           // receipt against this order
  status: text('status').notNull(),    // order: open|part|closed|cancelled · receipt: ok|review|settled · return: done · count: open|review|closed
  billNo: text('bill_no'),
  billDate: date('bill_date', { mode: 'string' }),
  billTotalPaise: integer('bill_total_paise'),
  billPhotoKey: text('bill_photo_key'),
  dueDate: date('due_date', { mode: 'string' }),
  vendorRef: text('vendor_ref'),
  note: text('note'),
  lines: jsonb('lines').$type<any[]>().notNull().default([]),
  decision: jsonb('decision').$type<{ choice: string; reason: string | null; by: string; at: string; debitPaise?: number } | null>(),
  createdBy: uuid('created_by').notNull(),
  createdByName: text('created_by_name').notNull(),
}, (t) => [uniqueIndex('stock_doc_no').on(t.tenantId, t.kind, t.docNo), index('stock_doc_at').on(t.tenantId, t.kind, t.createdAt)]);

// A batch on the shelf. Paid and free units sit together; cost is the real cost per pack with free units counted in.
export const stockBatch = pgTable('stock_batch', {
  ...tenantCols,
  medicineId: uuid('medicine_id').notNull().references(() => medicine.id),
  batchNo: text('batch_no').notNull(),
  expiry: date('expiry', { mode: 'string' }).notNull(), // last day of the expiry month
  qty: integer('qty').notNull().default(0),
  paidQty: integer('paid_qty').notNull().default(0),
  freeQty: integer('free_qty').notNull().default(0),
  costPaise: integer('cost_paise').notNull().default(0),
  mrpPaise: integer('mrp_paise').notNull().default(0),
  vendorId: uuid('vendor_id'),
  receiptId: uuid('receipt_id'),
  receiptNo: text('receipt_no'),
}, (t) => [uniqueIndex('stock_batch_no').on(t.tenantId, t.medicineId, t.batchNo), index('stock_batch_med').on(t.tenantId, t.medicineId)]);

// Every change to stock, never edited or deleted. balance = the medicine's total on hand after this change.
export const stockMove = pgTable('stock_move', {
  ...tenantCols,
  batchId: uuid('batch_id').notNull().references(() => stockBatch.id),
  medicineId: uuid('medicine_id').notNull(),
  change: integer('change').notNull(),
  balance: integer('balance').notNull(),
  kind: text('kind').notNull(),        // receive | sale | patient_return | vendor_return | count | adjust
  docId: uuid('doc_id'),
  docNo: text('doc_no'),
  note: text('note'),
  by: uuid('by').notNull(),
  byName: text('by_name').notNull(),
}, (t) => [index('stock_move_med').on(t.tenantId, t.medicineId, t.createdAt), index('stock_move_batch').on(t.tenantId, t.batchId)]);

// Free units a vendor promised but did not deliver; closed when they arrive later or the owner writes them off.
export const vendorOwed = pgTable('vendor_owed', {
  ...tenantCols,
  vendorId: uuid('vendor_id').notNull().references(() => vendor.id),
  medicineId: uuid('medicine_id').notNull(),
  name: text('name').notNull(),
  qty: integer('qty').notNull(),
  fromDocId: uuid('from_doc_id').notNull(),
  fromDocNo: text('from_doc_no').notNull(),
  status: text('status').notNull().default('owed'), // owed | received | written_off
  settledNote: text('settled_note'),
  decidedBy: text('decided_by').notNull(),
}, (t) => [index('vendor_owed_v').on(t.tenantId, t.vendorId, t.status)]);

// A doctor's saved starting point for a consultation: every row of the note, the medicines and the plan.
export const rxTemplate = pgTable('rx_template', {
  ...tenantCols,
  practitionerId: uuid('practitioner_id'),
  name: text('name').notNull(),
  data: jsonb('data').$type<Record<string, any>>().notNull().default({}),
  prescription: jsonb('prescription').$type<any[]>().notNull().default([]),
  recommendations: jsonb('recommendations').$type<any[]>().notNull().default([]),
  uses: integer('uses').notNull().default(0),
  linked: jsonb('linked').$type<{ complaints?: string[]; diagnoses?: string[] }>().notNull().default({}), // complaints and diagnoses this protocol is suggested for
}, (t) => [index('rx_template_t').on(t.tenantId, t.practitionerId)]);

// Small reusable sets for one section of the note: medicines, a complaint's checklist, findings, advice, tests, a procedure package.
// Suggested by the complaint or diagnosis they are linked to; they stack, so adding one never repeats what is already there.
export type TemplateKind = 'medicine' | 'complaint' | 'finding' | 'advice' | 'tests' | 'procedure';
export const tmpl = pgTable('tmpl', {
  ...tenantCols,
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  linked: jsonb('linked').$type<{ complaints?: string[]; diagnoses?: string[] }>().notNull().default({}),
  mode: text('mode').notNull().default('chip'),   // chip: shown as a suggestion · auto: added for the doctor when the complaint or diagnosis is picked
  payload: jsonb('payload').$type<Record<string, any>>().notNull().default({}),
  uses: integer('uses').notNull().default(0),
  active: boolean('active').notNull().default(true),
  draft: boolean('draft').notNull().default(false), // saved from a visit by a doctor, waiting for the owner
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [index('tmpl_t').on(t.tenantId, t.kind)]);

// Patients who want an earlier place; offered one when a place opens.
export const waitlist = pgTable('waitlist', {
  ...tenantCols,
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  practitionerId: uuid('practitioner_id'),
  note: text('note'),
  untilDay: date('until_day'),
  status: text('status').notNull().default('waiting'), // waiting | offered | booked | removed
  offeredAt: ts('offered_at'),
}, (t) => [index('waitlist_t').on(t.tenantId, t.status)]);

export const expense = pgTable('expense', {
  ...tenantCols,
  day: date('day').notNull(),
  description: text('description').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  method: text('method').notNull().default('cash'),
  category: text('category').notNull().default('Other'),
  note: text('note'),
  enteredBy: uuid('entered_by').notNull(),
  voidedAt: ts('voided_at'),
  voidedReason: text('voided_reason'),
});

// Uploaded files: lab reports, clinical photos, consent scans. Bytes live in object storage (R2/S3) or on local disk; see lib/storage.ts.
export const document = pgTable('document', {
  ...tenantCols,
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  encounterId: uuid('encounter_id').references(() => encounter.id),
  recommendationId: uuid('recommendation_id').references(() => recommendation.id),
  recommendationIds: uuid('recommendation_ids').array().notNull().default([]), // every test this file is the result of (recommendationId is the first)
  reviewedAt: ts('reviewed_at'),                                              // the doctor has opened this result
  kind: text('kind').notNull().default('report'), // report | photo | prescription | consent | other
  title: text('title').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  storageKey: text('storage_key').notNull(),
  note: text('note'),
  uploadedBy: uuid('uploaded_by').notNull(),
  // clinical photos: where on the body, which angle, and the procedure sitting they were taken at
  area: text('area'),
  view: text('view'),                         // front | left | right | back | closeup
  procedureSessionId: uuid('procedure_session_id'),
  takenAt: ts('taken_at').notNull().defaultNow(),
}, (t) => [index('doc_patient').on(t.tenantId, t.patientId), index('doc_photo_area').on(t.tenantId, t.patientId, t.area)]);

export const numberingSequence = pgTable('numbering_sequence', {
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  scope: text('scope').notNull(),
  nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
}, (t) => [uniqueIndex('numseq_pk').on(t.tenantId, t.key, t.scope)]);

// Audit log: every action by every user, written by the server and never changed (a trigger refuses updates and deletes).
export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  at: ts('at').notNull().defaultNow(),
  userId: uuid('user_id'),
  userName: text('user_name'),
  role: text('role'),
  ip: text('ip'),
  kind: text('kind').notNull(),     // money | change | cancel | view | print | signin | settings
  action: text('action').notNull(), // e.g. POST /appointments, patient.viewed, signin.stopped
  summary: text('summary').notNull(),
  entity: text('entity'),
  entityId: text('entity_id'),
  patientId: uuid('patient_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  unusual: boolean('unusual').notNull().default(false),
}, (t) => [index('audit_t_at').on(t.tenantId, t.at), index('audit_t_patient').on(t.tenantId, t.patientId)]);

export const domainEvent = pgTable('domain_event', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  type: text('type').notNull(),
  aggregate: text('aggregate').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  actor: jsonb('actor').notNull(),
  occurredAt: ts('occurred_at').notNull().defaultNow(),
  publishedAt: ts('published_at'),
});

export const TENANT_TABLES = [
  'branch', 'app_user', 'specialty', 'practitioner', 'form_definition', 'fee_category', 'medicine', 'procedure_catalog',
  'patient', 'session', 'appointment', 'visit', 'encounter', 'prescription_item', 'recommendation', 'charge', 'payment',
  'expense', 'pharmacy_sale', 'rx_template', 'tmpl', 'waitlist', 'audit_log', 'vendor', 'stock_doc', 'stock_batch', 'stock_move', 'vendor_owed', 'broadcast', 'document', 'room', 'calendar_block', 'procedure_session', 'numbering_sequence', 'domain_event', 'service', 'message',
];

export type FormField = {
  key: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'tags' | 'diagnoses' | 'duration' | 'date';
  required?: boolean; options?: string[]; unit?: string; placeholder?: string;
};
export type FormSchema = { sections: { key: string; title: string; fields: FormField[] }[] };

