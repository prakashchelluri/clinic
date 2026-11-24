import { and, desc, eq, sql } from 'drizzle-orm';
import { appUser, formDefinition, medicine, procedureCatalog, rxTemplate, stockBatch, tmpl, type FormSchema } from './schema.js';
import { receiveStock } from '../modules/stock.js';
import { addDays } from '../lib/core.js';

/*
 * Starter content for a dermatology clinic, added only where it is missing (matched by name), so a doctor's own edits
 * are never touched: more medicines, whole-prescription and section templates for common conditions, a form for every
 * procedure (Laser hair reduction and Chemical peel in full) and opening stock for the pharmacy.
 */

type Med = { name: string; generic?: string; allergyClass?: string; mrpPaise: number; gstBp: number; form: string; scheduleClass: string; packSize: number; reorderLevel: number;
  defaults: { dose?: string; route?: string; frequency?: string; durationDays?: number; instructions?: string } };
const tab = (name: string, mrpPaise: number, defaults: Med['defaults'], x: Partial<Med> = {}): Med => ({ name, mrpPaise, gstBp: 1200, form: 'tab', scheduleClass: 'H', packSize: 10, reorderLevel: 10, defaults: { dose: '1 tab', route: 'oral', ...defaults }, ...x });
const top = (name: string, form: string, mrpPaise: number, defaults: Med['defaults'], x: Partial<Med> = {}): Med => ({ name, mrpPaise, gstBp: 1200, form, scheduleClass: 'H', packSize: 1, reorderLevel: 5, defaults: { route: 'topical', ...defaults }, ...x });

export const EXTRA_MEDICINES: Med[] = [
  top('Permethrin 5% cream', 'cream', 14000, { frequency: 'once at night', durationDays: 1, instructions: 'neck down, wash off after 8 hours; repeat after 1 week' }, { generic: 'permethrin' }),
  tab('Ivermectin 12 mg', 6500, { frequency: 'single dose', durationDays: 1, instructions: 'empty stomach; repeat after 1 week' }, { generic: 'ivermectin', packSize: 1 }),
  tab('Hydroxyzine 25 mg', 7500, { frequency: 'at night', durationDays: 14, instructions: 'may cause drowsiness' }, { generic: 'hydroxyzine' }),
  tab('Levocetirizine 5 mg', 6000, { frequency: 'at night', durationDays: 14 }, { generic: 'levocetirizine', scheduleClass: 'OTC' }),
  tab('Fexofenadine 120 mg', 18000, { frequency: '1-0-0', durationDays: 30 }, { generic: 'fexofenadine' }),
  tab('Fluconazole 150 mg', 4500, { frequency: 'once a week', durationDays: 28 }, { generic: 'fluconazole', packSize: 1 }),
  tab('Itraconazole 100 mg', 32000, { dose: '2 cap', frequency: '1-0-0', durationDays: 21, instructions: 'after food' }, { generic: 'itraconazole', form: 'cap', packSize: 4 }),
  tab('Azithromycin 500 mg', 12000, { frequency: '1-0-0', durationDays: 3 }, { generic: 'azithromycin', allergyClass: 'macrolide', packSize: 3 }),
  tab('Minocycline 50 mg', 21000, { frequency: '1-0-1', durationDays: 30, instructions: 'after food' }, { generic: 'minocycline', allergyClass: 'tetracycline' }),
  tab('Biotin 10 mg', 25000, { frequency: '1-0-0', durationDays: 90 }, { scheduleClass: 'OTC', gstBp: 1800 }),
  tab('Multivitamin with zinc', 14000, { frequency: '1-0-0', durationDays: 30 }, { scheduleClass: 'OTC', gstBp: 1800 }),
  tab('Ferrous ascorbate + folic acid', 16000, { frequency: '0-1-0', durationDays: 90, instructions: 'after lunch' }, { scheduleClass: 'OTC' }),
  tab('Vitamin D3 60,000 IU', 3500, { dose: '1 sachet', frequency: 'once a week', durationDays: 56 }, { form: 'sachet', packSize: 1, scheduleClass: 'OTC' }),
  tab('Prednisolone 10 mg', 2500, { frequency: '1-0-0', durationDays: 5, instructions: 'after food' }, { generic: 'prednisolone' }),
  tab('Tranexamic acid 250 mg', 22000, { frequency: '1-0-1', durationDays: 60 }, { generic: 'tranexamic acid' }),
  top('Clobetasol 0.05% cream', 'cream', 9000, { frequency: 'once daily', durationDays: 14, instructions: 'thin layer, not on the face' }, { generic: 'clobetasol' }),
  top('Calcipotriol 0.005% ointment', 'ointment', 42000, { frequency: 'twice daily', durationDays: 30 }, { generic: 'calcipotriol' }),
  top('Tacrolimus 0.1% ointment', 'ointment', 52000, { frequency: 'twice daily', durationDays: 30 }, { generic: 'tacrolimus' }),
  top('Fusidic acid 2% cream', 'cream', 16000, { frequency: '1-0-1', durationDays: 7 }, { generic: 'fusidic acid' }),
  top('Mupirocin 2% ointment', 'ointment', 13500, { frequency: '1-0-1', durationDays: 7 }, { generic: 'mupirocin' }),
  top('Luliconazole 1% cream', 'cream', 24000, { frequency: 'once daily', durationDays: 28, instructions: '2 cm beyond the edge' }, { generic: 'luliconazole' }),
  top('Ketoconazole 2% shampoo', 'shampoo', 31000, { frequency: 'twice a week', durationDays: 30, instructions: 'leave on 5 minutes, then wash' }, { generic: 'ketoconazole' }),
  top('Minoxidil 5% solution', 'solution', 69000, { dose: '1 ml', frequency: 'twice daily', durationDays: 90, instructions: 'on dry scalp' }, { generic: 'minoxidil' }),
  top('Benzoyl peroxide 2.5% gel', 'gel', 15000, { frequency: 'at night', durationDays: 30 }, { generic: 'benzoyl peroxide' }),
  top('Azelaic acid 20% cream', 'cream', 38000, { frequency: 'twice daily', durationDays: 60 }, { generic: 'azelaic acid' }),
  top('Metronidazole 0.75% gel', 'gel', 19000, { frequency: 'twice daily', durationDays: 60 }, { generic: 'metronidazole' }),
  top('Kojic acid cream', 'cream', 34000, { frequency: 'at night', durationDays: 60 }, { scheduleClass: 'OTC', gstBp: 1800 }),
  top('Salicylic acid wart paint', 'solution', 11000, { frequency: 'at night', durationDays: 30, instructions: 'only on the wart; file the top first' }, { generic: 'salicylic acid' }),
  top('Calamine lotion', 'lotion', 9500, { frequency: 'three times daily', durationDays: 14 }, { scheduleClass: 'OTC' }),
  top('Sunscreen gel SPF 50 (oil-free)', 'gel', 52000, { frequency: 'morning, reapply 3-hourly', durationDays: 90 }, { scheduleClass: 'OTC', gstBp: 1800 }),
  // used during procedures (issued by the pharmacy against the session, no bill)
  top('Glycolic acid peel 35%', 'solution', 180000, { durationDays: 1 }, { gstBp: 1800, reorderLevel: 2 }),
  top('Salicylic acid peel 30%', 'solution', 160000, { durationDays: 1 }, { gstBp: 1800, reorderLevel: 2 }),
  top('Peel neutraliser', 'solution', 90000, { durationDays: 1 }, { gstBp: 1800, reorderLevel: 2 }),
  top('Aloe vera cooling gel', 'gel', 32000, { frequency: 'twice daily', durationDays: 5 }, { scheduleClass: 'OTC', gstBp: 1800 }),
  top('Lidocaine-prilocaine 5% cream', 'cream', 46000, { frequency: '45 minutes before', durationDays: 1, instructions: 'under cling film' }, { generic: 'lidocaine' }),
  top('Triamcinolone 10 mg/ml injection', 'inj', 9000, { route: 'intralesional', durationDays: 1 }, { generic: 'triamcinolone', reorderLevel: 3 }),
];

/* ---------------- whole-prescription templates (Rx pad "Templates") ---------------- */
type Line = [name: string, frequency: string, days: number, instructions?: string];
type Proto = { name: string; complaints: string[]; site?: string[]; morphology?: string[]; distribution?: string; diagnosis: { name: string; severity?: string }[]; advice: string[]; rx: Line[]; followupDays: number; linkDx: string[] };
const PROTOCOLS: Proto[] = [
  { name: 'Scabies', complaints: ['Itching', 'Rash'], site: ['Hands', 'Genitals', 'Trunk'], morphology: ['Papule', 'Vesicle'], diagnosis: [{ name: 'Scabies' }], linkDx: ['Scabies'],
    advice: ['Treat everyone at home on the same night', 'Hot-wash clothes and bedding', 'Cut nails short'], followupDays: 14,
    rx: [['Permethrin 5% cream', 'once at night', 1, 'neck down, repeat after 1 week'], ['Ivermectin 12 mg', 'single dose', 1, 'repeat after 1 week'], ['Hydroxyzine 25 mg', 'at night', 14, 'for itching']] },
  { name: 'Psoriasis · mild', complaints: ['Rash', 'Itching'], site: ['Scalp', 'Arms', 'Legs'], morphology: ['Plaque', 'Scale'], distribution: 'Extensor', diagnosis: [{ name: 'Psoriasis vulgaris', severity: 'Mild' }], linkDx: ['Psoriasis vulgaris'],
    advice: ['Moisturise twice daily', "Don't pick the scales", 'Avoid smoking and alcohol', 'Short sun exposure helps'], followupDays: 30,
    rx: [['Clobetasol 0.05% cream', 'once daily', 14, 'thin layer, not on the face'], ['Calcipotriol 0.005% ointment', 'twice daily', 30], ['Moisturiser (ceramide)', 'twice daily', 30]] },
  { name: 'Atopic dermatitis', complaints: ['Itching', 'Dry skin'], site: ['Face', 'Arms'], morphology: ['Plaque', 'Scale'], distribution: 'Flexural', diagnosis: [{ name: 'Atopic dermatitis', severity: 'Moderate' }], linkDx: ['Atopic dermatitis'],
    advice: ['Lukewarm short baths', 'Moisturise within 3 minutes of bathing', 'Loose cotton clothes', 'No soap on the rash'], followupDays: 21,
    rx: [['Mometasone 0.1% cream', 'once daily', 10], ['Tacrolimus 0.1% ointment', 'twice daily', 30, 'after the steroid course'], ['Moisturiser (ceramide)', 'twice daily', 30], ['Levocetirizine 5 mg', 'at night', 14]] },
  { name: 'Seborrhoeic dermatitis', complaints: ['Dandruff', 'Itching'], site: ['Scalp', 'Face'], morphology: ['Scale'], diagnosis: [{ name: 'Seborrheic dermatitis' }], linkDx: ['Seborrheic dermatitis'],
    advice: ['Wash hair 3 times a week', 'Leave the shampoo on 5 minutes', 'Avoid oiling the scalp'], followupDays: 30,
    rx: [['Ketoconazole 2% shampoo', 'twice a week', 30, 'leave on 5 minutes'], ['Ketoconazole 2% cream', 'once daily', 14, 'on the face patches']] },
  { name: 'Hair fall · telogen effluvium', complaints: ['Hair fall'], site: ['Scalp'], diagnosis: [{ name: 'Telogen effluvium' }], linkDx: ['Telogen effluvium'],
    advice: ['Protein in every meal', 'Gentle combing, no tight hairstyles', 'Hair fall settles in 3 to 6 months'], followupDays: 60,
    rx: [['Biotin 10 mg', '1-0-0', 90], ['Ferrous ascorbate + folic acid', '0-1-0', 90, 'after lunch'], ['Vitamin D3 60,000 IU', 'once a week', 56], ['Minoxidil 5% solution', 'twice daily', 90, 'on dry scalp']] },
  { name: 'Pityriasis versicolor', complaints: ['White patches'], site: ['Trunk', 'Neck'], morphology: ['Macule', 'Scale', 'Hypopigmentation'], diagnosis: [{ name: 'Pityriasis versicolor' }], linkDx: ['Pityriasis versicolor'],
    advice: ['Keep the skin dry', 'Colour takes 2 to 3 months to return', 'Repeat the shampoo once a month in summer'], followupDays: 28,
    rx: [['Ketoconazole 2% shampoo', 'daily for 5 days', 5, 'as a body wash, leave 5 minutes'], ['Fluconazole 150 mg', 'once a week', 14], ['Luliconazole 1% cream', 'once daily', 28]] },
  { name: 'Warts', complaints: ['Warts'], site: ['Hands', 'Feet'], morphology: ['Papule'], diagnosis: [{ name: 'Verruca vulgaris' }], linkDx: ['Verruca vulgaris'],
    advice: ["Don't pick or shave over warts", 'Keep feet dry, no barefoot walking', 'Cryotherapy if not better in 4 weeks'], followupDays: 28,
    rx: [['Salicylic acid wart paint', 'at night', 30, 'only on the wart; file the top first']] },
  { name: 'Vitiligo · stable', complaints: ['White patches'], site: ['Face', 'Hands'], morphology: ['Macule'], diagnosis: [{ name: 'Vitiligo' }], linkDx: ['Vitiligo'],
    advice: ['Sunscreen on the patches', '10 minutes of morning sun on the patches', 'Not contagious'], followupDays: 60,
    rx: [['Tacrolimus 0.1% ointment', 'twice daily', 60], ['Mometasone 0.1% cream', 'once daily', 30, 'alternate weeks'], ['Sunscreen SPF 50', 'morning', 60]] },
  { name: 'Rosacea', complaints: ['Burning sensation', 'Pimples'], site: ['Face'], morphology: ['Papule', 'Pustule'], diagnosis: [{ name: 'Rosacea' }], linkDx: ['Rosacea'],
    advice: ['Avoid spicy food, hot drinks and alcohol', 'Gentle cleanser only', 'Sunscreen every day'], followupDays: 30,
    rx: [['Metronidazole 0.75% gel', 'twice daily', 60], ['Azithromycin 500 mg', '1-0-0', 3], ['Sunscreen gel SPF 50 (oil-free)', 'morning', 60]] },
  { name: 'Post-acne marks', complaints: ['Dark patches', 'Scars'], site: ['Face'], morphology: ['Hyperpigmentation', 'Macule'], diagnosis: [{ name: 'Post-inflammatory hyperpigmentation' }], linkDx: ['Post-inflammatory hyperpigmentation'],
    advice: ['Sunscreen every 3 hours', "Don't pick pimples", 'Peels help after 4 weeks of creams'], followupDays: 30,
    rx: [['Azelaic acid 20% cream', 'twice daily', 60], ['Kojic acid cream', 'at night', 60], ['Sunscreen gel SPF 50 (oil-free)', 'morning', 60]] },
  { name: 'Acne · severe', complaints: ['Pimples'], site: ['Face', 'Back'], morphology: ['Nodule', 'Pustule', 'Scar'], diagnosis: [{ name: 'Acne vulgaris', severity: 'Severe' }], linkDx: [],
    advice: ['Avoid pregnancy during treatment', 'Lip balm and moisturiser daily', 'Blood tests before starting and after 1 month'], followupDays: 30,
    rx: [['Isotretinoin 20 mg', '0-1-0', 30, 'after food'], ['Moisturiser (ceramide)', 'twice daily', 30], ['Sunscreen gel SPF 50 (oil-free)', 'morning', 30]] },
  { name: 'Urticaria · chronic', complaints: ['Itching'], morphology: [], diagnosis: [{ name: 'Chronic urticaria' }], linkDx: ['Chronic urticaria'],
    advice: ['Note foods or medicines before each episode', 'Avoid painkillers like ibuprofen', 'Loose cotton clothes'], followupDays: 30,
    rx: [['Fexofenadine 120 mg', '1-0-0', 30], ['Levocetirizine 5 mg', 'at night', 30], ['Calamine lotion', 'three times daily', 14]] },
];

/* ---------------- section templates (each card's own template list on the pad) ---------------- */
type SetRow = { kind: string; name: string; payload: any; linked: any; mode?: string };
const SETS: SetRow[] = [
  // symptoms
  ...[
    ['Itchy rash', ['Itching', 'Rash'], [['Itching', '2 weeks', 'Moderate', 'worse at night'], ['Rash', '2 weeks', 'Moderate']]],
    ['Pimples', ['Pimples', 'Acne'], [['Pimples', '6 months', 'Moderate'], ['Oily skin', '1 year', 'Mild']]],
    ['Hair fall', ['Hair fall'], [['Hair fall', '3 months', 'Moderate', 'more while combing'], ['Thinning', '3 months', 'Mild']]],
    ['Dark patches', ['Dark patches', 'Pigmentation'], [['Dark patches', '1 year', 'Moderate', 'cheeks and forehead']]],
    ['White patches', ['White patches'], [['White patches', '6 months', 'Mild', 'no itching']]],
    ['Dandruff', ['Dandruff'], [['Dandruff', '6 months', 'Mild'], ['Scalp itching', '6 months', 'Mild']]],
    ['Unwanted hair', ['Unwanted hair'], [['Unwanted hair', '2 years', 'Moderate', 'chin and upper lip']]],
  ].map(([name, links, items]: any) => ({ kind: 'symptom', name, linked: { complaints: links }, payload: { items: items.map(([n, since, severity, note]: string[]) => ({ name: n, since, severity, ...(note ? { note } : {}) })) } })),
  // diagnoses
  ...[
    ['Fungal infection', ['Tinea corporis', 'Tinea cruris'], [['Tinea corporis', 'Moderate'], ['Tinea cruris', 'Moderate']]],
    ['Acne', ['Acne vulgaris'], [['Acne vulgaris', 'Moderate']]],
    ['Scabies', ['Scabies'], [['Scabies', 'Moderate']]],
    ['Melasma', ['Melasma'], [['Melasma', 'Moderate']]],
    ['Hair loss', ['Telogen effluvium', 'Androgenetic alopecia'], [['Telogen effluvium', 'Moderate']]],
    ['Eczema', ['Atopic dermatitis'], [['Atopic dermatitis', 'Moderate']]],
    ['Psoriasis', ['Psoriasis vulgaris'], [['Psoriasis vulgaris', 'Mild']]],
    ['Hirsutism (for laser)', ['Hirsutism'], [['Hirsutism', 'Moderate']]],
  ].map(([name, links, items]: any) => ({ kind: 'diagnosis', name, linked: { diagnoses: links }, payload: { items: items.map(([n, severity]: string[]) => ({ name: n, severity, status: 'Active' })) } })),
  // notes
  { kind: 'notes', name: 'Laser counselling', linked: { complaints: ['Unwanted hair'] }, payload: { text: 'Explained laser hair reduction: 6 to 8 sessions, 4 to 6 weeks apart. Hair reduces, it may not go fully. Shave the area the day before. No waxing, threading or bleaching between sessions. Avoid sun tan. Mild redness for a day is normal.' } },
  { kind: 'notes', name: 'Peel counselling', linked: { diagnoses: ['Melasma', 'Post-inflammatory hyperpigmentation', 'Acne vulgaris'] }, payload: { text: 'Explained chemical peel: 4 to 6 sessions, 2 to 3 weeks apart. Stop retinoid creams 3 days before. Light peeling for 3 to 5 days, do not pick. Strict sunscreen. No peel if on isotretinoin in the last 6 months.' } },
  { kind: 'notes', name: 'Isotretinoin counselling', linked: { diagnoses: ['Acne vulgaris'] }, payload: { text: 'Explained isotretinoin: dry lips and skin expected, no pregnancy during and 1 month after, no blood donation, blood tests at start and after 1 month.' } },
  // medicines, findings, advice, tests for the conditions above
  { kind: 'advice', name: 'After laser', linked: { complaints: ['Unwanted hair'] }, mode: 'chip', payload: { lines: ['Ice or aloe gel if it feels warm', 'No sun, gym, sauna or hot bath for 48 hours', 'Sunscreen on the area', 'Shave only, no waxing or threading'] } },
  { kind: 'advice', name: 'After peel', linked: { diagnoses: ['Melasma', 'Post-inflammatory hyperpigmentation'] }, mode: 'chip', payload: { lines: ["Don't pick the peeling skin", 'Sunscreen every 3 hours', 'Mild soap and moisturiser only', 'No retinoid or scrub for 5 days'] } },
  { kind: 'advice', name: 'Psoriasis advice', linked: { diagnoses: ['Psoriasis vulgaris'] }, payload: { lines: ['Moisturise twice daily', "Don't pick the scales", 'Avoid smoking and alcohol'] } },
  { kind: 'finding', name: 'Scabies findings', linked: { diagnoses: ['Scabies'] }, payload: { items: [{ name: 'Burrows', note: 'finger webs' }, { name: 'Papules', note: 'wrists, waist' }, { name: 'Excoriation' }] } },
  { kind: 'finding', name: 'Hair fall exam', linked: { complaints: ['Hair fall'] }, payload: { items: [{ name: 'Hair pull test', note: 'positive / negative' }, { name: 'Widening of parting' }, { name: 'Scalp', note: 'normal' }] } },
  { kind: 'finding', name: 'Hirsutism exam', linked: { complaints: ['Unwanted hair'] }, payload: { items: [{ name: 'Ferriman-Gallwey score' }, { name: 'Areas', note: 'chin, upper lip' }, { name: 'Acne' }] } },
  { kind: 'tests', name: 'Isotretinoin baseline', linked: { diagnoses: ['Acne vulgaris'] }, payload: { tests: [{ name: 'LFT' }, { name: 'Lipid profile' }, { name: 'Urine pregnancy test', note: 'women' }] } },
  { kind: 'tests', name: 'Hirsutism work-up', linked: { complaints: ['Unwanted hair'] }, payload: { tests: [{ name: 'Testosterone' }, { name: 'TSH' }, { name: 'Prolactin' }, { name: 'USG pelvis', days: 7 }] } },
  { kind: 'tests', name: 'Urticaria work-up', linked: { diagnoses: ['Chronic urticaria'] }, payload: { tests: [{ name: 'CBC' }, { name: 'ESR' }, { name: 'TSH' }, { name: 'Stool for ova and cysts' }] } },
];

/* ---------------- procedure forms ---------------- */
type F = FormSchema['sections'][number]['fields'][number];
const f = (key: string, label: string, type: F['type'], x: Partial<F> = {}): F => ({ key, label, type, ...x } as F);
const SKIN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const nextDate = f('next_session', 'Next session', 'date');
const notes = f('notes', 'Notes', 'textarea', { width: 4 });

const LHR: Omit<FormSchema, 'products'> = { sections: [
  { key: 'before', title: 'Before', fields: [
    f('skin_type', 'Skin type (Fitzpatrick)', 'chips', { options: SKIN, required: true, carry: true }),
    f('hair_colour', 'Hair colour', 'chips', { options: ['Black', 'Dark brown', 'Light brown', 'Grey / blonde'], carry: true }),
    f('hair_thickness', 'Hair thickness', 'chips', { options: ['Fine', 'Medium', 'Coarse'], carry: true }),
    f('areas', 'Areas', 'multiselect', { options: ['Upper lip', 'Chin', 'Side locks', 'Full face', 'Neck', 'Underarms', 'Full arms', 'Half arms', 'Full legs', 'Half legs', 'Bikini', 'Back', 'Chest', 'Abdomen'], required: true, carry: true }),
    f('shaved', 'Area shaved', 'checkbox'),
    f('recent_tan', 'Sun tan in the last 2 weeks', 'checkbox'),
    f('photosensitive_meds', 'On photosensitising medicine', 'checkbox', { help: 'Isotretinoin, doxycycline, St John’s wort…' }),
    f('patch_test', 'Patch test', 'chips', { options: ['Not needed', 'Done, no reaction', 'Done, reaction'] }),
  ] },
  { key: 'during', title: 'During', fields: [
    f('machine', 'Machine', 'select', { options: ['Diode 808 nm', 'Alexandrite 755 nm', 'Nd:YAG 1064 nm', 'Triple wavelength (755/808/1064)'], required: true, carry: true }),
    f('fluence', 'Fluence', 'number', { unit: 'J/cm²', required: true, carry: true }),
    f('pulse_width', 'Pulse width', 'number', { unit: 'ms', carry: true }),
    f('spot_size', 'Spot size', 'number', { unit: 'mm', carry: true }),
    f('frequency', 'Repetition rate', 'number', { unit: 'Hz', carry: true }),
    f('passes', 'Passes', 'number', { carry: true }),
    f('shots', 'Shots', 'number'),
    f('cooling', 'Cooling', 'chips', { options: ['Contact cooling', 'Cold air', 'Ice packs'], carry: true }),
    f('numbing', 'Numbing cream used', 'checkbox'),
    f('pain', 'Pain score (0–10)', 'select', { options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] }),
  ] },
  { key: 'after', title: 'After', fields: [
    f('reaction', 'Immediate reaction', 'multiselect', { options: ['Expected (perifollicular oedema)', 'Redness', 'Burning', 'Blister', 'None'] }),
    f('ice', 'Ice / cooling gel applied', 'checkbox'),
    f('advice', 'After-care advice given', 'checkbox'),
    f('hair_reduction', 'Hair reduction so far', 'chips', { options: ['Under 25%', '25–50%', '50–75%', 'Over 75%'] }),
    nextDate, notes,
  ] },
] };

const PEEL: Omit<FormSchema, 'products'> = { sections: [
  { key: 'before', title: 'Before', fields: [
    f('indication', 'Treating', 'multiselect', { options: ['Acne', 'Acne marks', 'Melasma', 'Tan', 'Dull skin', 'Open pores', 'Fine lines'], required: true, carry: true }),
    f('skin_type', 'Skin type (Fitzpatrick)', 'chips', { options: SKIN, carry: true }),
    f('skin_nature', 'Skin', 'chips', { options: ['Oily', 'Normal', 'Dry', 'Combination', 'Sensitive'], carry: true }),
    f('primed', 'Primed for 2 weeks', 'checkbox'),
    f('priming_with', 'Primed with', 'text', { placeholder: 'e.g. glycolic cream at night', carry: true }),
    f('isotretinoin_6m', 'Isotretinoin in the last 6 months', 'checkbox', { help: 'If yes, no peel today' }),
    f('active_lesions', 'Cold sore, cut or active infection', 'checkbox'),
    f('pregnant', 'Pregnant or breastfeeding', 'checkbox'),
  ] },
  { key: 'during', title: 'During', fields: [
    f('agent', 'Peel', 'select', { options: ['Glycolic acid', 'Salicylic acid', 'Mandelic acid', 'Lactic acid', "Jessner's", 'TCA', 'Yellow peel'], required: true, carry: true }),
    f('strength', 'Strength', 'number', { unit: '%', required: true, carry: true }),
    f('areas', 'Areas', 'multiselect', { options: ['Full face', 'Forehead', 'Cheeks', 'Nose', 'Chin', 'Neck', 'Underarms', 'Back', 'Hands'], carry: true }),
    f('layers', 'Layers / coats', 'number', { carry: true }),
    f('contact_time', 'Contact time', 'number', { unit: 'min', carry: true }),
    f('end_point', 'End point', 'chips', { options: ['Erythema', 'Pseudo-frost', 'Frost level 1', 'Frost level 2', 'Frost level 3'] }),
    f('neutralised', 'Neutralised / washed off', 'checkbox'),
    f('burning', 'Burning (0–10)', 'select', { options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] }),
  ] },
  { key: 'after', title: 'After', fields: [
    f('redness', 'Redness', 'chips', { options: ['None', 'Mild', 'Moderate', 'Severe'] }),
    f('reaction', 'Other reaction', 'multiselect', { options: ['None', 'Patchy frosting', 'Blister', 'Crusting', 'Swelling'] }),
    f('sunscreen', 'Sunscreen applied and advised', 'checkbox'),
    f('advice', 'After-care advice given', 'checkbox'),
    f('response', 'Response so far', 'chips', { options: ['No change', 'Slight', 'Good', 'Very good'] }),
    nextDate, notes,
  ] },
] };

/** A short form for every other procedure, with the one or two numbers that matter for it. */
const basic = (during: F[]): Omit<FormSchema, 'products'> => ({ sections: [
  { key: 'before', title: 'Before', fields: [f('indication', 'Treating', 'text', { carry: true }), f('area', 'Area', 'text', { carry: true })] },
  { key: 'during', title: 'During', fields: during },
  { key: 'after', title: 'After', fields: [f('reaction', 'Reaction', 'chips', { options: ['None', 'Mild', 'Moderate', 'Severe'] }), f('advice', 'After-care advice given', 'checkbox'), nextDate, notes] },
] });
const FORMS: Record<string, { form: Omit<FormSchema, 'products'>; products: [string, number][] }> = {
  'Laser hair reduction': { form: LHR, products: [['Aloe vera cooling gel', 1]] },
  'Chemical peel': { form: PEEL, products: [['Glycolic acid peel 35%', 1], ['Peel neutraliser', 1]] },
  Hydrafacial: { form: basic([f('serum', 'Booster serum', 'select', { options: ['Hydrating', 'Brightening', 'Anti-acne', 'Anti-ageing'], carry: true }), f('steps', 'Steps done', 'multiselect', { options: ['Cleanse', 'Peel', 'Extract', 'Hydrate', 'LED'] })]), products: [] },
  'Fractional CO2 laser (acne scars)': { form: basic([f('energy', 'Energy', 'number', { unit: 'mJ', required: true, carry: true }), f('density', 'Density', 'number', { unit: '%', carry: true }), f('passes', 'Passes', 'number', { carry: true }), f('numbing', 'Numbing cream used', 'checkbox')]), products: [['Lidocaine-prilocaine 5% cream', 1]] },
  'Intralesional steroid injection': { form: basic([f('drug', 'Drug', 'select', { options: ['Triamcinolone acetonide'], carry: true }), f('concentration', 'Concentration', 'number', { unit: 'mg/ml', required: true, carry: true }), f('volume', 'Volume injected', 'number', { unit: 'ml' }), f('lesions', 'Lesions injected', 'number')]), products: [['Triamcinolone 10 mg/ml injection', 1]] },
  'Cryotherapy (warts)': { form: basic([f('warts', 'Warts treated', 'number', { required: true }), f('freeze_time', 'Freeze time', 'number', { unit: 'sec', carry: true }), f('cycles', 'Freeze-thaw cycles', 'number', { carry: true })]), products: [] },
  'PRP (hair)': { form: basic([f('blood_drawn', 'Blood drawn', 'number', { unit: 'ml', carry: true }), f('prp_volume', 'PRP injected', 'number', { unit: 'ml' }), f('technique', 'Technique', 'chips', { options: ['Injections', 'Derma-roller + PRP', 'Microneedling + PRP'], carry: true })]), products: [] },
  'Excision biopsy': { form: basic([f('site', 'Site', 'text', { required: true }), f('size', 'Size', 'number', { unit: 'mm' }), f('sutures', 'Sutures', 'number'), f('sample_sent', 'Sample sent to lab', 'checkbox')]), products: [] },
};

/* ---------------- opening stock ---------------- */
/** Months to expiry, packs on hand. A few are low or expiring soon so the pharmacy's alerts show something. */
const STOCK_SPECIAL: Record<string, { qty: number; months: number }[]> = {
  'Cetirizine 10 mg': [{ qty: 3, months: 14 }],                 // low
  'Permethrin 5% cream': [{ qty: 2, months: 18 }],              // low
  'Clindamycin 1% gel': [{ qty: 6, months: 2 }, { qty: 15, months: 20 }], // one batch expiring
  'Calamine lotion': [{ qty: 8, months: 2 }],                   // expiring
  'Glycolic acid peel 35%': [{ qty: 4, months: 12 }],
  'Salicylic acid peel 30%': [{ qty: 3, months: 12 }],
  'Peel neutraliser': [{ qty: 4, months: 12 }],
  'Triamcinolone 10 mg/ml injection': [{ qty: 10, months: 10 }],
};

/** Adds whatever is missing. Safe to run on every start: nothing already there is changed. */
export async function ensureDemoPack(db: any, tid: string, today: string) {
  // medicines
  const have = new Set((await db.select({ name: medicine.name }).from(medicine).where(eq(medicine.tenantId, tid))).map((m: any) => m.name.toLowerCase()));
  const newMeds = EXTRA_MEDICINES.filter((m) => !have.has(m.name.toLowerCase()));
  if (newMeds.length) await db.insert(medicine).values(newMeds.map((m) => ({ ...m, tenantId: tid })));
  const meds: any[] = await db.select().from(medicine).where(eq(medicine.tenantId, tid));
  const med = (name: string) => meds.find((m) => m.name === name);

  // whole-prescription templates (shared by the clinic's doctors)
  const haveRx = new Set((await db.select({ name: rxTemplate.name }).from(rxTemplate).where(eq(rxTemplate.tenantId, tid))).map((r: any) => r.name.toLowerCase()));
  const rxRows = PROTOCOLS.filter((p) => !haveRx.has(p.name.toLowerCase())).map((p) => ({
    tenantId: tid, name: p.name, linked: { complaints: p.complaints, ...(p.linkDx.length ? { diagnoses: p.linkDx } : {}) },
    data: { complaint: { chief_complaint: p.complaints, ...(p.site ? { site: p.site } : {}) }, exam: { ...(p.morphology?.length ? { morphology: p.morphology } : {}), ...(p.distribution ? { distribution: p.distribution } : {}) }, assessment: { diagnosis: p.diagnosis }, plan: { advice: p.advice.join('\n') } },
    prescription: p.rx.map(([name, frequency, durationDays, instructions]) => { const m = med(name); return m && { name, medicineId: m.id, dose: m.defaults?.dose, route: m.defaults?.route, frequency, durationDays, instructions }; }).filter(Boolean),
    recommendations: [{ kind: 'followup', intervalDays: p.followupDays }],
  }));
  if (rxRows.length) await db.insert(rxTemplate).values(rxRows);

  // section templates; a medicine set is built from its protocol's lines
  const haveSet = new Set((await db.select({ kind: tmpl.kind, name: tmpl.name }).from(tmpl).where(eq(tmpl.tenantId, tid))).map((r: any) => `${r.kind}:${r.name.toLowerCase()}`));
  const medSets: SetRow[] = PROTOCOLS.map((p) => ({ kind: 'medicine', name: p.name, linked: { complaints: p.complaints, ...(p.linkDx.length ? { diagnoses: p.linkDx } : {}) },
    payload: { items: p.rx.map(([name, frequency, durationDays, instructions]) => { const m = med(name); return m && { name, medicineId: m.id, dose: m.defaults?.dose ?? null, route: m.defaults?.route ?? null, frequency, durationDays, instructions: instructions ?? null }; }).filter(Boolean) } }));
  const [{ n }] = await db.select({ n: sql<number>`coalesce(max(${tmpl.sortOrder}), 0)::int` }).from(tmpl).where(eq(tmpl.tenantId, tid));
  const setRows = [...SETS, ...medSets].filter((s) => !haveSet.has(`${s.kind}:${s.name.toLowerCase()}`) && (s.kind !== 'medicine' || s.payload.items.length))
    .map((s, i) => ({ tenantId: tid, kind: s.kind, name: s.name, linked: s.linked, mode: s.mode ?? 'chip', payload: s.payload, sortOrder: Number(n) + 1 + i }));
  if (setRows.length) await db.insert(tmpl).values(setRows);

  // a form for every procedure that has none yet
  const procs: any[] = await db.select().from(procedureCatalog).where(eq(procedureCatalog.tenantId, tid));
  for (const p of procs) {
    const [cur] = await db.select().from(formDefinition).where(and(eq(formDefinition.tenantId, tid), eq(formDefinition.key, `procedure:${p.id}`))).orderBy(desc(formDefinition.version)).limit(1);
    if (cur) { // older demo forms asked 'Consent signed' again; Start takes the consent now, so a new version drops it (old sessions keep theirs)
      const sc = cur.schema as FormSchema; const dup = (x: F) => x.key === 'consent' && x.label === 'Consent signed';
      if (sc.sections.some((sec) => sec.fields.some(dup))) await db.insert(formDefinition).values({ tenantId: tid, key: cur.key, specialtyId: cur.specialtyId, version: cur.version + 1, schema: { ...sc, sections: sc.sections.map((sec) => ({ ...sec, fields: sec.fields.filter((x) => !dup(x)) })) } });
      continue;
    }
    const def = FORMS[p.name]; if (!def) continue;
    const products = def.products.map(([name, qty]) => { const m = med(name); return m && { medicineId: m.id, name, qty }; }).filter(Boolean) as FormSchema['products'];
    await db.insert(formDefinition).values({ tenantId: tid, key: `procedure:${p.id}`, specialtyId: p.specialtyId ?? null, version: 1, schema: { ...def.form, products } });
  }

  await ensureOpeningStock(db, tid, today);
}

/** Opening stock for every medicine, once: only when the clinic has never had any stock. */
export async function ensureOpeningStock(db: any, tid: string, today: string) {
  if ((await db.select({ id: stockBatch.id }).from(stockBatch).where(eq(stockBatch.tenantId, tid)).limit(1)).length) return;
  const owner = (await db.select().from(appUser).where(and(eq(appUser.tenantId, tid), eq(appUser.role, 'owner'))).limit(1))[0];
  if (!owner) return;
  const meds: any[] = await db.select().from(medicine).where(eq(medicine.tenantId, tid));
  if (!meds.length) return;
  const ym = (months: number) => addDays(today, months * 31).slice(0, 7);
  const lines = meds.flatMap((m, i) => (STOCK_SPECIAL[m.name] ?? [{ qty: Math.max(m.reorderLevel * 3, 12) + (i % 5) * 4, months: 12 + (i % 4) * 6 }]).map((b, j) => ({
    medicineId: m.id, qty: b.qty, freeQty: 0, ratePaise: Math.round((m.mrpPaise * 0.7) / (1 + m.gstBp / 10000)), discBp: 0,
    batchNo: `OP${String(i + 1).padStart(3, '0')}${j ? String.fromCharCode(65 + j) : ''}`, expiry: ym(b.months), mrpPaise: m.mrpPaise })));
  await receiveStock(db, { tenantId: tid, userId: owner.id, name: owner.name }, { lines, keepOpen: false } as any, today);
}
