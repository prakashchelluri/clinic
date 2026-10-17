import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from './index.js';
import { tenant, branch, appUser, specialty, practitioner, formDefinition, feeCategory, medicine, procedureCatalog, session, room, type FormSchema } from './schema.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../lib/auth.js';
import { todayIn, addDays } from '../lib/core.js';

/* ---------------- Dermatology specialty pack (data, editable per clinic in Settings → Forms) ---------------- */
export const DERM_ENCOUNTER_VERSION = 3;
export const DERM_ENCOUNTER: FormSchema = {
  sections: [
    { key: 'complaint', title: 'Complaint', fields: [
      { key: 'chief_complaint', label: 'Complaints', type: 'tags', required: true, placeholder: 'Type a complaint, press Enter for the next', options: ['Pimples', 'Itching', 'Rash', 'Hair fall', 'Dark patches', 'White patches', 'Dandruff', 'Warts', 'Dry skin', 'Nail changes', 'Burning sensation', 'Scars', 'Unwanted hair'] },
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
      { key: 'diagnosis', label: 'Diagnoses (each with severity)', type: 'diagnoses', required: true, placeholder: 'Type a diagnosis, press Enter for the next', options: ['Acne vulgaris', 'Melasma', 'Tinea corporis', 'Tinea cruris', 'Psoriasis vulgaris', 'Alopecia areata', 'Androgenetic alopecia', 'Verruca vulgaris', 'Atopic dermatitis', 'Seborrheic dermatitis', 'Contact dermatitis', 'Acute urticaria', 'Chronic urticaria', 'Vitiligo', 'Post-inflammatory hyperpigmentation', 'Scabies', 'Pityriasis versicolor', 'Lichen planus', 'Rosacea', 'Molluscum contagiosum', 'Impetigo', 'Herpes zoster'] },
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
const DERM_MEDICINES = [
  { name: 'Adapalene 0.1% gel', form: 'gel', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'at night', durationDays: 56, instructions: 'thin layer on affected area' } },
  { name: 'Clindamycin 1% gel', form: 'gel', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'morning', durationDays: 28 } },
  { name: 'Doxycycline 100 mg', form: 'cap', scheduleClass: 'H', defaults: { dose: '1 cap', route: 'oral', frequency: 'once daily after food', durationDays: 28 } },
  { name: 'Isotretinoin 20 mg', form: 'cap', scheduleClass: 'H', defaults: { dose: '1 cap', route: 'oral', frequency: 'once daily with food', durationDays: 30, instructions: 'avoid pregnancy; lipid/LFT monitoring' } },
  { name: 'Cetirizine 10 mg', form: 'tab', scheduleClass: 'OTC', defaults: { dose: '1 tab', route: 'oral', frequency: 'at night', durationDays: 7 } },
  { name: 'Mometasone 0.1% cream', form: 'cream', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'once daily', durationDays: 14 } },
  { name: 'Ketoconazole 2% cream', form: 'cream', scheduleClass: 'H', defaults: { route: 'topical', frequency: 'twice daily', durationDays: 21 } },
  { name: 'Terbinafine 250 mg', form: 'tab', scheduleClass: 'H', defaults: { dose: '1 tab', route: 'oral', frequency: 'once daily', durationDays: 14 } },
  { name: 'Sunscreen SPF 50', form: 'lotion', scheduleClass: 'OTC', defaults: { route: 'topical', frequency: 'morning, reapply 3-hourly', durationDays: 90 } },
  { name: 'Moisturiser (ceramide)', form: 'cream', scheduleClass: 'OTC', defaults: { route: 'topical', frequency: 'twice daily', durationDays: 90 } },
];
const DERM_PROCEDURES = [
  { name: 'Chemical peel', typicalMinutes: 30, pricePaise: 250000, typicalSittings: 6, requiredCapability: 'procedure' },
  { name: 'Hydrafacial', typicalMinutes: 45, pricePaise: 350000, typicalSittings: 1, requiredCapability: 'procedure' },
  { name: 'Laser hair reduction', typicalMinutes: 60, pricePaise: 400000, typicalSittings: 8, taxRateBp: 1800, requiredCapability: 'laser' },
  { name: 'Fractional CO2 laser (acne scars)', typicalMinutes: 90, requiresMainDoctor: true, requiresReview: true, pricePaise: 800000, typicalSittings: 4, taxRateBp: 1800, requiredCapability: 'laser', bufferMinutes: 15 },
  { name: 'Intralesional steroid injection', typicalMinutes: 15, requiresMainDoctor: true, pricePaise: 100000, requiredCapability: 'procedure' },
  { name: 'Cryotherapy (warts)', typicalMinutes: 15, pricePaise: 150000, typicalSittings: 3, requiredCapability: 'cryo' },
  { name: 'PRP (hair)', typicalMinutes: 60, pricePaise: 600000, typicalSittings: 6, requiredCapability: 'procedure' },
  { name: 'Excision biopsy', typicalMinutes: 45, requiresMainDoctor: true, requiresReview: true, pricePaise: 300000, requiredCapability: 'minor_ot', bufferMinutes: 15 },
];
const DERM_ROOMS = [
  { name: 'Procedure Room 1', capabilities: ['procedure', 'cryo'] },
  { name: 'Procedure Room 2 (Laser)', capabilities: ['procedure', 'laser'] },
  { name: 'Minor OT', capabilities: ['procedure', 'minor_ot', 'cryo'] },
];

export type NewClinic = { name: string; slug: string; timezone?: string; address?: string; phone?: string; owner: { name: string; email: string; password: string; regNo?: string; qualification?: string; isDoctor?: boolean }; pack?: 'dermatology' };

/** Onboard a clinic: tenant, branch, owner (also a doctor unless told otherwise), specialty pack, default fees, rooms. */
export async function createClinic(input: NewClinic) {
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (await db.select().from(tenant).where(eq(tenant.slug, slug)).then((r) => r.length)) throw new Error('SLUG_TAKEN');
  const newId = randomUUID();
  return (db as any).transaction(async (db: any) => {
  await db.execute(sql`select set_config('app.tenant_id', ${newId}, true)`);
  const [t] = await db.insert(tenant).values({ id: newId, slug, name: input.name, timezone: input.timezone ?? 'Asia/Kolkata', kind: 'clinic', settings: {
    scheduling: { windowMinutes: 60, arriveEarlyMinutes: 35, defaultCapacity: 7 }, numbering: { opNumberScope: 'day+category' },
    print: { address: input.address ?? '', phone: input.phone ?? '', footer: 'Get well soon' }, languages: ['en'] } }).returning();
  const tid = t.id;
  const [b] = await db.insert(branch).values({ tenantId: tid, name: 'Main', address: input.address ?? null }).returning();
  const [derm] = await db.insert(specialty).values({ tenantId: tid, key: 'dermatology', name: 'Dermatology', sourcePack: `dermatology@${DERM_ENCOUNTER_VERSION}` }).returning();
  // Default routine Mon–Sat 10–13 and 16–20; the owner changes it once in their profile.
  const routine = { days: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), [['10:00', '13:00'], ['16:00', '20:00']] as [string, string][]])), capacity: 7, windowMinutes: 60 };
  let ownerPrac: any = null;
  if (input.owner.isDoctor !== false) [ownerPrac] = await db.insert(practitioner).values({ tenantId: tid, name: input.owner.name, regNo: input.owner.regNo ?? null, qualification: input.owner.qualification ?? null, specialtyId: derm.id, routine }).returning();
  const roles = input.owner.isDoctor !== false ? ['owner', 'doctor'] : ['owner'];
  await db.insert(appUser).values({ tenantId: tid, email: input.owner.email.toLowerCase(), name: input.owner.name, passwordHash: hashPassword(input.owner.password), role: 'owner', roles, practitionerId: ownerPrac?.id ?? null });
  await db.insert(formDefinition).values([
    { tenantId: tid, key: 'encounter', specialtyId: derm.id, version: DERM_ENCOUNTER_VERSION, schema: DERM_ENCOUNTER },
    { tenantId: tid, key: 'intake', specialtyId: derm.id, version: 1, schema: DERM_INTAKE },
  ]);
  await db.insert(feeCategory).values([
    { tenantId: tid, code: 'GEN', name: 'General / New', amountPaise: 30000 },
    { tenantId: tid, code: 'REN', name: 'Renewal (within 15 days)', amountPaise: 0, eligibility: { '<=': [{ var: 'days_since_last_paid_consult' }, 14] }, eligibilityNote: 'Payment day counts as day 1; day 15 is the last free day' },
    { tenantId: tid, code: 'FREE', name: 'Free (procedure follow-up)', amountPaise: 0, affectsCapacity: false, eligibility: { '==': [{ var: 'has_open_procedure_course' }, true] } },
    { tenantId: tid, code: 'NGT', name: 'Emergency / Nightly', amountPaise: 50000, priority: 10 },
    { tenantId: tid, code: 'SPL', name: 'RMP/PMP Special Card', amountPaise: 20000, eligibility: { '==': [{ var: 'patient.referralCard' }, true] } },
    { tenantId: tid, code: 'ONL', name: 'Online consultation', amountPaise: 50000, affectsCapacity: false },
  ]);
  await db.insert(medicine).values(DERM_MEDICINES.map((m) => ({ ...m, tenantId: tid })));
  await db.insert(procedureCatalog).values(DERM_PROCEDURES.map((p) => ({ ...p, tenantId: tid, specialtyId: derm.id })));
  await db.insert(room).values(DERM_ROOMS.map((r) => ({ ...r, tenantId: tid, branchId: b.id })));
  return { tenantId: tid, branchId: b.id, practitionerId: ownerPrac?.id ?? null, specialtyId: derm.id, slug };
  });
}

/** Forms are versioned: encounters pin the version they were written with. New versions are added, never edited in place. */
export async function ensureFormsCurrent() {
  for (const t of await db.select().from(tenant).where(eq(tenant.kind, 'clinic'))) {
    await (db as any).transaction(async (db: any) => {
      await db.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    // Data upgrades for clinics created by earlier builds
    await db.execute(sql`update app_user set roles = array_append(roles, 'doctor') where 'owner' = any(roles) and practitioner_id is not null and not ('doctor' = any(roles))`);
    await db.execute(sql`update practitioner set routine = '{"days":{"1":[["10:00","13:00"],["16:00","20:00"]],"2":[["10:00","13:00"],["16:00","20:00"]],"3":[["10:00","13:00"],["16:00","20:00"]],"4":[["10:00","13:00"],["16:00","20:00"]],"5":[["10:00","13:00"],["16:00","20:00"]],"6":[["10:00","13:00"],["16:00","20:00"]]},"capacity":7,"windowMinutes":60}'::jsonb where routine is null and active`);
    for (const p of DERM_PROCEDURES) await db.execute(sql`update procedure_catalog set required_capability = ${p.requiredCapability}, buffer_minutes = ${(p as any).bufferMinutes ?? 0} where name = ${p.name} and required_capability is null`);
  
    const cur = await db.select().from(formDefinition).where(and(eq(formDefinition.tenantId, t.id), eq(formDefinition.key, 'encounter'))).orderBy(desc(formDefinition.version)).then((r: any) => r[0]);
    // Only auto-upgrade clinics still on the stock pack (no owner-edited versions beyond it).
    if (cur && cur.version >= DERM_ENCOUNTER_VERSION) return;
    if (cur) await db.update(formDefinition).set({ active: false }).where(and(eq(formDefinition.tenantId, t.id), eq(formDefinition.key, 'encounter')));
    await db.insert(formDefinition).values({ tenantId: t.id, key: 'encounter', specialtyId: cur?.specialtyId ?? null, version: DERM_ENCOUNTER_VERSION, schema: DERM_ENCOUNTER });
    const rooms = await db.select().from(room).where(eq(room.tenantId, t.id));
    if (!rooms.length) { const b = (await db.select().from(branch).where(eq(branch.tenantId, t.id)))[0]; if (b) await db.insert(room).values(DERM_ROOMS.map((r) => ({ ...r, tenantId: t.id, branchId: b.id }))); }


    });
  }
}

/** The platform tenant hosts CUBOTT staff who onboard clinics. Created once. */
export async function ensurePlatform() {
  if (await db.select().from(tenant).where(eq(tenant.kind, 'platform')).then((r) => r.length)) return;
  const pid = randomUUID();
  await (db as any).transaction(async (db: any) => {
  await db.execute(sql`select set_config('app.tenant_id', ${pid}, true)`);
  const [t] = await db.insert(tenant).values({ id: pid, slug: 'cubott', name: 'CUBOTT Platform', kind: 'platform', settings: {} }).returning();
  await db.insert(appUser).values({ tenantId: t.id, email: 'superadmin@cubott.in', name: 'CUBOTT Admin', passwordHash: hashPassword(process.env.SUPERADMIN_PASSWORD ?? 'demo1234'), role: 'superadmin', roles: ['superadmin'] });
  });
}

export async function seedIfEmpty() {
  if (await db.select().from(tenant).where(eq(tenant.kind, 'clinic')).limit(1).then((r) => r.length)) return;
  await seedDemo();
}

/** Demo clinic from discovery: Sahitya Dermatology Hospital with its staff and a typical OP day. */
export async function seedDemo(slug = 'sahitya') {
  const c = await createClinic({ name: 'Sahitya Dermatology Hospital', slug, address: 'Rajahmundry, Andhra Pradesh', owner: { name: 'Dr. Main Doctor', email: 'owner@demo.clinic', password: 'demo1234', regNo: 'APMC/00000', qualification: 'MD (DVL)' } });
  const tid = c.tenantId;
  return (db as any).transaction(async (db: any) => {
  await db.execute(sql`select set_config('app.tenant_id', ${tid}, true)`);
  await db.update(tenant).set({ settings: { scheduling: { windowMinutes: 60, arriveEarlyMinutes: 35, defaultCapacity: 7 }, numbering: { opNumberScope: 'day+category' }, print: { address: 'Rajahmundry, Andhra Pradesh', phone: '', footer: 'Get well soon · ఆరోగ్యంగా ఉండండి' }, languages: ['te', 'en'] } }).where(eq(tenant.id, tid));
  const [drB] = await db.insert(practitioner).values({ tenantId: tid, name: 'Dr. Second Doctor', regNo: 'APMC/00001', qualification: 'MBBS, DDVL', specialtyId: c.specialtyId,
    routine: { days: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [String(d), [['10:00', '14:00']] as [string, string][]])), capacity: 6, windowMinutes: 60 } }).returning();
  const pw = hashPassword('demo1234');
  await db.insert(appUser).values([
    { tenantId: tid, email: 'doctor2@demo.clinic', name: 'Dr. Second Doctor', passwordHash: pw, role: 'doctor', roles: ['doctor'], practitionerId: drB.id },
    { tenantId: tid, email: 'reception@demo.clinic', name: 'Lakshmi (OP Reception)', passwordHash: pw, role: 'receptionist', roles: ['receptionist'] },
    { tenantId: tid, email: 'procedures@demo.clinic', name: 'Sunita (Procedures)', passwordHash: pw, role: 'coordinator', roles: ['coordinator'] },
    { tenantId: tid, email: 'assistant@demo.clinic', name: 'Ravi (Assistant)', passwordHash: pw, role: 'assistant', roles: ['assistant'] },
    { tenantId: tid, email: 'pharmacy@demo.clinic', name: 'Pharmacy', passwordHash: pw, role: 'pharmacist', roles: ['pharmacist'] },
  ]);
  const today = todayIn('Asia/Kolkata');
  const windows = [['10:00', '11:00', 7], ['11:00', '12:00', 7], ['12:00', '13:00', 6], ['14:00', '15:00', 7], ['15:00', '16:00', 7], ['16:00', '17:00', 5], ['19:00', '20:00', 6]] as const;
  for (const day of [today, addDays(today, 1)]) {
    await db.insert(session).values(windows.map(([s, e, cap]) => ({ tenantId: tid, branchId: c.branchId, practitionerId: c.practitionerId!, day, startTime: s, endTime: e, capacity: cap })));
  }
  return { tenantId: tid, branchId: c.branchId };
  });
}

if (process.argv[1]?.endsWith('seed.ts')) {
  const { migrate, applyRls } = await import('./index.js');
  await migrate(); await applyRls(); await ensurePlatform(); await seedIfEmpty(); await ensureFormsCurrent();
  console.log('seeded'); process.exit(0);
}

/** A seed that died half way (before it ran in one scoped transaction) can leave a tenant with no users, which blocks re-seeding. Remove only those. */
export async function healEmptyTenants() {
  for (const t of await db.select().from(tenant)) {
    try {
      await (db as any).transaction(async (db: any) => {
        await db.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
        const [{ n }] = (await db.execute(sql`select count(*)::int as n from app_user where tenant_id = ${t.id}`)).rows ?? (await db.execute(sql`select count(*)::int as n from app_user where tenant_id = ${t.id}`));
        if (Number(n) === 0) { await db.execute(sql`delete from tenant where id = ${t.id}`); console.log('removed empty tenant', t.slug); }
      });
    } catch (e) { console.warn('could not heal tenant', t.slug, (e as Error).message); }
  }
}
