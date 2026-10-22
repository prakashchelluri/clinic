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
  defaults: jsonb('defaults').$type<{ dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string }>(),
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
}, (t) => [index('msg_due').on(t.status, t.sendAfter), index('msg_appt').on(t.tenantId, t.appointmentId)]);

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
  dispensed: boolean('dispensed').notNull().default(false),
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
  kind: text('kind').notNull(), // break | leave | procedure | other
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
  status: text('status').notNull().default('open'), // open | contacted | scheduled | done | cancelled
  contactLog: jsonb('contact_log').$type<{ at: string; by: string; outcome: string; note?: string }[]>().notNull().default([]),
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
  'expense', 'document', 'room', 'calendar_block', 'procedure_session', 'numbering_sequence', 'domain_event', 'service', 'message',
];

export type FormField = {
  key: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'tags' | 'diagnoses' | 'duration' | 'date';
  required?: boolean; options?: string[]; unit?: string; placeholder?: string;
};
export type FormSchema = { sections: { key: string; title: string; fields: FormField[] }[] };

