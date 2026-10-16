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
  role: text('role').notNull(), // owner | doctor | receptionist | coordinator | pharmacist | assistant | admin
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
  active: boolean('active').notNull().default(true),
});

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
}, (t) => [index('session_day').on(t.tenantId, t.day)]);

export const appointment = pgTable('appointment', {
  ...tenantCols,
  patientId: uuid('patient_id').notNull().references(() => patient.id),
  sessionId: uuid('session_id').notNull().references(() => session.id),
  status: text('status').notNull().default('booked'), // booked | arrived | cancelled | no_show
  source: text('source').notNull().default('phone'),
  note: text('note'),
  overbooked: boolean('overbooked').notNull().default(false),
  idempotencyKey: text('idempotency_key'),
}, (t) => [uniqueIndex('appt_idem').on(t.tenantId, t.idempotencyKey)]);

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
  enteredBy: uuid('entered_by').notNull(),
});

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
  'expense', 'numbering_sequence', 'domain_event',
];

export type FormField = {
  key: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'duration' | 'date';
  required?: boolean; options?: string[]; unit?: string; placeholder?: string;
};
export type FormSchema = { sections: { key: string; title: string; fields: FormField[] }[] };

