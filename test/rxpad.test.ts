// The Rx pad's pure parts: lab flags, the history migration, the pad defaults and the Telugu line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findParam, flagOf } from '../src/lib/labs.js';
import { normHistory, cleanHistory, allergyText, historyCategories } from '../src/lib/history.js';
import { padConfig, printSettings, te, teluguTable } from '../src/lib/pad.js';

test('a typed value is flagged against the clinic list', () => {
  const hb = findParam('hb')!; assert.equal(hb.name, 'Haemoglobin', 'aliases resolve');
  assert.equal(flagOf('11.2', hb), 'low'); assert.equal(flagOf('14', hb), 'normal'); assert.equal(flagOf('18.5', hb), 'high');
  assert.equal(flagOf('7,800', findParam('Total WBC')), 'normal', 'thousands separators are fine');
  assert.equal(flagOf('Negative', findParam('KOH mount')), 'normal'); assert.equal(flagOf('Positive', findParam('KOH mount')), 'abnormal');
  assert.equal(flagOf('Non reactive', findParam('VDRL')), 'normal');
  assert.equal(flagOf('see report', findParam('Skin biopsy')), null, 'free text has no flag');
  assert.equal(flagOf('12', undefined), null, 'an unlisted test has no range');
});

test('old yes/no history becomes the six categories, once', () => {
  const h = normHistory({ diabetes: { yes: true, note: 'Metformin' }, bp: { yes: false }, allergy: { yes: true, note: 'sulfa' }, other: { yes: true, note: 'Asthma' } });
  assert.deepEqual(h.conditions, [{ name: 'Diabetes', note: 'Metformin' }, { name: 'Asthma' }]);
  assert.deepEqual(h.drugAllergies, [{ name: 'sulfa' }]);
  assert.equal(normHistory(h), h, 'already migrated: returned as is');
  assert.equal(allergyText(h), 'sulfa');
  const c = cleanHistory({ conditions: [{ name: ' BP ', note: 'Telmisartan' }, { name: '' }], none: ['family', 'conditions', 'bogus'], heightCm: 168 });
  assert.deepEqual(c, { conditions: [{ name: 'BP', note: 'Telmisartan' }], none: ['family'], heightCm: 168 }, 'blank names, a none that has items, and unknown keys are dropped');
});

test('pad defaults fill what the clinic has not configured', () => {
  const d = padConfig({});
  assert.ok(d.every((s) => !s.required), 'nothing is required until the clinic ticks it');
  assert.equal(padConfig({ pad: { sections: [{ key: 'diagnosis', show: true, required: true, print: true }] } }).find((s) => s.key === 'diagnosis')!.required, true);
  assert.equal(d.find((s) => s.key === 'photos')!.show, false);
  assert.equal(d.find((s) => s.key === 'notes')!.print, false);
  const saved = padConfig({ pad: { sections: [{ key: 'medicines', show: true, required: false, print: true }, { key: 'diagnosis', show: false, required: false, print: true }, { key: 'junk', show: true, required: false, print: true }] } });
  assert.equal(saved[0].key, 'medicines', 'saved order first'); assert.equal(saved[1].key, 'diagnosis'); assert.equal(saved[1].show, true, 'diagnosis cannot be hidden');
  assert.ok(!saved.some((s) => s.key === 'junk')); assert.equal(saved.length, padConfig({}).length);
  assert.equal(printSettings({}).lang, 'te+en'); assert.equal(printSettings({ print: { rx: { lang: 'en' } } }).lang, 'en');
});

test('standard phrases get a Telugu line, free text does not', () => {
  assert.equal(te('1-0-1'), 'ఉదయం 1, రాత్రి 1'); assert.equal(te('After food'), 'భోజనం తర్వాత'); assert.equal(te('14 days'), '14 రోజులు');
  assert.equal(te('neck down, repeat day 8'), null); assert.equal(te(''), null);
});

test("the clinic's own phrases and history options sit on top of the built-in lists", () => {
  const s = { pad: { telugu: { 'after food': 'భోజనం అయ్యాక', 'after bath': 'స్నానం తర్వాత', 'at night': '' }, historyOptions: { conditions: ['BP', 'Anaemia'] } } };
  assert.equal(te('After food', s), 'భోజనం అయ్యాక', 'an edited phrase wins');
  assert.equal(te('after bath', s), 'స్నానం తర్వాత', 'an added phrase translates');
  assert.equal(te('at night', s), null, 'an emptied phrase prints in English only');
  assert.equal(te('after food'), 'భోజనం తర్వాత', 'without settings the built-in line stands');
  assert.ok(Object.keys(teluguTable(s)).length > 40, 'the merged table keeps every built-in phrase');
  assert.deepEqual(historyCategories(s).find((c) => c.key === 'conditions')!.options, ['BP', 'Anaemia']);
  assert.equal(historyCategories(s).find((c) => c.key === 'family')!.options.length, historyCategories({}).find((c) => c.key === 'family')!.options.length, 'untouched categories keep the defaults');
});

test('finish needs only what the clinic ticked: the form definition alone no longer makes symptoms or diagnosis required', async () => {
  const { validate } = await import('../src/lib/pad.js');
  const DERM_ENCOUNTER = { sections: [{ key: 'complaint', fields: [{ key: 'chief_complaint', label: 'Complaints', type: 'tags', required: true }] }, { key: 'assessment', fields: [{ key: 'diagnosis', label: 'Diagnoses', type: 'diagnoses', required: true }] }] };
  assert.deepEqual(validate(DERM_ENCOUNTER, {}, padConfig({})), [], 'an empty pad finishes by default');
  const pad = padConfig({ pad: { sections: [{ key: 'diagnosis', show: true, required: true, print: true }, { key: 'symptoms', show: true, required: true, print: true }] } });
  assert.deepEqual(validate(DERM_ENCOUNTER, {}, pad).map((e) => e.path).sort(), ['assessment.diagnosis', 'complaint.chief_complaint']);
});

test('a custom module locks only once a line on the pad holds something', async () => {
  const { usedModuleIds } = await import('../src/lib/pad.js');
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(usedModuleIds({ modules: { [a]: { rows: [['', ' '], ['Rice', '']] }, [b]: { rows: [['', '']] }, junk: { rows: [['x']] } } }), [a], 'blank lines and a bad id lock nothing');
  assert.deepEqual(usedModuleIds({}), []);
});
