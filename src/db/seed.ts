import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { tenant, branch, appUser, specialty, practitioner, formDefinition, feeCategory, medicine, procedureCatalog, session, type FormSchema } from './schema.js';
import { hashPassword } from '../lib/auth.js';
import { todayIn, addDays } from '../lib/core.js';

/** Dermatology encounter form: the first "specialty pack". Everything here is data, editable per tenant. */
export const DERM_ENCOUNTER: FormSchema = {
  sections: [
    { key: 'complaint', title: 'Complaint', fields: [
      { key: 'chief_complaint', label: 'Chief complaint', type: 'text', required: true, placeholder: 'e.g. acne on face' },
      { key: 'duration', label: 'Duration', type: 'text', placeholder: 'e.g. 3 months' },
      { key: 'site', label: 'Site', type: 'multiselect', options: ['Face', 'Scalp', 'Neck', 'Trunk', 'Back', 'Arms', 'Hands', 'Legs', 'Feet', 'Nails', 'Genitals', 'Generalised'] },
      { key: 'history', label: 'History / triggers', type: 'textarea' },
    ] },
    { key: 'exam', title: 'Examination', fields: [
      { key: 'morphology', label: 'Morphology', type: 'multiselect', options: ['Macule', 'Papule', 'Pustule', 'Nodule', 'Plaque', 'Vesicle', 'Comedone', 'Scale', 'Erosion', 'Ulcer', 'Scar', 'Hypopigmentation', 'Hyperpigmentation'] },
      { key: 'distribution', label: 'Distribution', type: 'select', options: ['Localised', 'Symmetrical', 'Unilateral', 'Dermatomal', 'Photo-exposed', 'Flexural', 'Extensor'] },
      { key: 'findings', label: 'Findings', type: 'textarea' },
    ] },
    { key: 'assessment', title: 'Assessment', fields: [
      { key: 'diagnosis', label: 'Diagnosis', type: 'text', required: true, placeholder: 'e.g. Acne vulgaris grade 2' },
      { key: 'severity', label: 'Severity', type: 'select', options: ['Mild', 'Moderate', 'Severe'] },
    ] },
    { key: 'plan', title: 'Plan', fields: [
      { key: 'advice', label: 'Advice', type: 'textarea', placeholder: 'sun protection, moisturiser…' },
    ] },
  ],
};

export const DERM_INTAKE: FormSchema = {
  sections: [{ key: 'intake', title: 'Intake', fields: [
    { key: 'weight_kg', label: 'Weight (kg)', type: 'number', unit: 'kg' },
    { key: 'complaint', label: 'Main complaint', type: 'text', required: true },
    { key: 'since', label: 'Since when', type: 'text' },
    { key: 'prior_treatment', label: 'Treatments tried', type: 'textarea' },
    { key: 'allergies', label: 'Known allergies', type: 'text' },
  ] }],
};

export async function seedIfEmpty() {
  const existing = await db.select().from(tenant).limit(1);
  if (existing.length) return;
  await seedDemo();
}

export async function seedDemo(slug = 'sahitya') {
  const [t] = await db.insert(tenant).values({
    slug, name: 'Sahitya Dermatology Hospital', timezone: 'Asia/Kolkata',
    settings: {
      scheduling: { windowMinutes: 60, arriveEarlyMinutes: 35, defaultCapacity: 7 },
      numbering: { opNumberScope: 'day+category' },
      print: { address: 'Rajahmundry, Andhra Pradesh', phone: '', footer: 'Get well soon · ఆరోగ్యంగా ఉండండి' },
      languages: ['te', 'en'],
    },
  }).returning();
  const tid = t.id;
  const [b] = await db.insert(branch).values({ tenantId: tid, name: 'Main', address: 'Rajahmundry' }).returning();
  const [derm] = await db.insert(specialty).values({ tenantId: tid, key: 'dermatology', name: 'Dermatology', sourcePack: 'dermatology@0.1' }).returning();
  const [drA, drB] = await db.insert(practitioner).values([
    { tenantId: tid, name: 'Dr. Main Doctor', regNo: 'APMC/00000', qualification: 'MD (DVL)', specialtyId: derm.id },
    { tenantId: tid, name: 'Dr. Second Doctor', regNo: 'APMC/00001', qualification: 'MBBS, DDVL', specialtyId: derm.id },
  ]).returning();
  const pw = hashPassword('demo1234');
  await db.insert(appUser).values([
    { tenantId: tid, email: 'owner@demo.clinic', name: 'Dr. Main Doctor', passwordHash: pw, role: 'owner', practitionerId: drA.id },
    { tenantId: tid, email: 'doctor2@demo.clinic', name: 'Dr. Second Doctor', passwordHash: pw, role: 'doctor', practitionerId: drB.id },
    { tenantId: tid, email: 'reception@demo.clinic', name: 'Lakshmi (OP Reception)', passwordHash: pw, role: 'receptionist' },
    { tenantId: tid, email: 'procedures@demo.clinic', name: 'Sunita (Procedures)', passwordHash: pw, role: 'coordinator' },
    { tenantId: tid, email: 'assistant@demo.clinic', name: 'Ravi (Assistant)', passwordHash: pw, role: 'assistant' },
    { tenantId: tid, email: 'pharmacy@demo.clinic', name: 'Pharmacy', passwordHash: pw, role: 'pharmacist' },
  ]);
  await db.insert(formDefinition).values([
    { tenantId: tid, key: 'encounter', specialtyId: derm.id, version: 1, schema: DERM_ENCOUNTER },
    { tenantId: tid, key: 'intake', specialtyId: derm.id, version: 1, schema: DERM_INTAKE },
  ]);
  // Fee categories from discovery. Amounts in paise. Eligibility = JSONLogic over facts in visits.ts.
  await db.insert(feeCategory).values([
    { tenantId: tid, code: 'GEN', name: 'General / New', amountPaise: 30000 },
    { tenantId: tid, code: 'REN', name: 'Renewal (within 15 days)', amountPaise: 0, eligibility: { '<=': [{ var: 'days_since_last_paid_consult' }, 14] }, eligibilityNote: 'Payment day counts as day 1; day 15 is the last free day' },
    { tenantId: tid, code: 'FREE', name: 'Free (procedure follow-up)', amountPaise: 0, affectsCapacity: false, eligibility: { '==': [{ var: 'has_open_procedure_course' }, true] } },
    { tenantId: tid, code: 'NGT', name: 'Emergency / Nightly', amountPaise: 50000, priority: 10 },
    { tenantId: tid, code: 'SPL', name: 'RMP/PMP Special Card', amountPaise: 20000, eligibility: { '==': [{ var: 'patient.referralCard' }, true] } },
    { tenantId: tid, code: 'ONL', name: 'Online consultation', amountPaise: 50000, affectsCapacity: false },
  ]);
  await db.insert(medicine).values([
    { tenantId: tid, name: 'Adapalene 0.1% gel', form: 'gel', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'at night', durationDays: 56, instructions: 'thin layer on affected area' } },
    { tenantId: tid, name: 'Clindamycin 1% gel', form: 'gel', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'morning', durationDays: 28 } },
    { tenantId: tid, name: 'Doxycycline 100 mg', form: 'cap', scheduleClass: 'H', defaults: { dose: '1 cap', route: 'oral', frequency: 'once daily after food', durationDays: 28 } },
    { tenantId: tid, name: 'Isotretinoin 20 mg', form: 'cap', scheduleClass: 'H', defaults: { dose: '1 cap', route: 'oral', frequency: 'once daily with food', durationDays: 30, instructions: 'avoid pregnancy; lipid/LFT monitoring' } },
    { tenantId: tid, name: 'Cetirizine 10 mg', form: 'tab', scheduleClass: 'OTC', defaults: { dose: '1 tab', route: 'oral', frequency: 'at night', durationDays: 7 } },
    { tenantId: tid, name: 'Mometasone 0.1% cream', form: 'cream', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'once daily', durationDays: 14 } },
    { tenantId: tid, name: 'Ketoconazole 2% cream', form: 'cream', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'twice daily', durationDays: 21 } },
    { tenantId: tid, name: 'Terbinafine 250 mg', form: 'tab', scheduleClass: 'H', defaults: { dose: '1 tab', route: 'oral', frequency: 'once daily', durationDays: 14 } },
    { tenantId: tid, name: 'Sunscreen SPF 50', form: 'lotion', scheduleClass: 'OTC', defaults: { route: 'topical', frequency: 'morning, reapply 3-hourly', durationDays: 90 } },
    { tenantId: tid, name: 'Moisturiser (ceramide)', form: 'cream', scheduleClass: 'OTC', defaults: { route: 'topical', frequency: 'twice daily', durationDays: 90 } },
  ]);
  await db.insert(procedureCatalog).values([
    { tenantId: tid, specialtyId: derm.id, name: 'Chemical peel', typicalMinutes: 30, pricePaise: 250000, typicalSittings: 6 },
    { tenantId: tid, specialtyId: derm.id, name: 'Hydrafacial', typicalMinutes: 45, pricePaise: 350000, typicalSittings: 1 },
    { tenantId: tid, specialtyId: derm.id, name: 'Laser hair reduction', typicalMinutes: 60, pricePaise: 400000, typicalSittings: 8, taxRateBp: 1800 },
    { tenantId: tid, specialtyId: derm.id, name: 'Fractional CO2 laser (acne scars)', typicalMinutes: 90, requiresMainDoctor: true, requiresReview: true, pricePaise: 800000, typicalSittings: 4, taxRateBp: 1800 },
    { tenantId: tid, specialtyId: derm.id, name: 'Intralesional steroid injection', typicalMinutes: 15, requiresMainDoctor: true, pricePaise: 100000 },
    { tenantId: tid, specialtyId: derm.id, name: 'Cryotherapy (warts)', typicalMinutes: 15, pricePaise: 150000, typicalSittings: 3 },
    { tenantId: tid, specialtyId: derm.id, name: 'PRP (hair)', typicalMinutes: 60, pricePaise: 600000, typicalSittings: 6 },
    { tenantId: tid, specialtyId: derm.id, name: 'Excision biopsy', typicalMinutes: 45, requiresMainDoctor: true, requiresReview: true, pricePaise: 300000 },
  ]);
  // OP windows for today and tomorrow, main doctor: a typical day from discovery
  const today = todayIn(t.timezone);
  const windows = [['10:00', '11:00', 7], ['11:00', '12:00', 7], ['12:00', '13:00', 6], ['14:00', '15:00', 7], ['15:00', '16:00', 7], ['16:00', '17:00', 5], ['19:00', '20:00', 6]] as const;
  for (const day of [today, addDays(today, 1)]) {
    await db.insert(session).values(windows.map(([s, e, c]) => ({ tenantId: tid, branchId: b.id, practitionerId: drA.id, day, startTime: s, endTime: e, capacity: c })));
  }
  return { tenantId: tid, branchId: b.id };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  const { migrate, applyRls } = await import('./index.js');
  await migrate(); await applyRls(); await seedIfEmpty();
  console.log('seeded'); process.exit(0);
}
