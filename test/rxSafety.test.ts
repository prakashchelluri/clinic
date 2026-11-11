// Prescription safety: allergy classes, pregnancy, isotretinoin + tetracycline, quantity from the dose, age text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allergyHit, rxWarnings, qtyFor, ageText, pregnancyFlag } from '../web/src/rxLine.js';

test('allergy classes catch brand and generic names', () => {
  for (const m of ['Amoxyclav 625', 'Augmentin', 'Moxclav', 'Amoxicillin 500 mg', 'Ampicillin', 'Cloxacillin']) assert.equal(allergyHit('Penicillin', m), 'penicillin', m);
  for (const m of ['Cefixime 200', 'Cefuroxime', 'Cefpodoxime', 'Cephalexin']) assert.equal(allergyHit('Cephalosporins', m), 'cephalosporin', m);
  for (const m of ['Doxycycline 100 mg', 'Minocycline', 'Tetracycline']) assert.equal(allergyHit('Tetracyclines', m), 'tetracycline', m);
  for (const m of ['Lidocaine gel', 'Lignocaine', 'Prilocaine', 'EMLA cream']) assert.equal(allergyHit('Local anaesthetic', m), 'local anaesthetic', m);
  for (const m of ['Azithromycin 500', 'Clarithromycin', 'Erythromycin gel']) assert.equal(allergyHit('macrolides', m), 'macrolide', m);
  for (const m of ['Ciprofloxacin', 'Levofloxacin', 'Ofloxacin', 'Moxifloxacin']) assert.equal(allergyHit('Quinolone', m), 'quinolone', m);
  assert.equal(allergyHit('Sulpha drugs, penicillin', 'Dapsone 100'), 'sulfa');
  assert.equal(allergyHit('Sulpha drugs, penicillin', 'Amoxyclav'), 'penicillin');
  assert.equal(allergyHit('Penicillin', 'Mox 500', ), null, 'a brand alone is not known…');
  assert.equal(allergyHit('Penicillin', 'Mox 500 amoxicillin'), 'penicillin', '…but its generic is');
  // look-alikes that must not be flagged
  assert.equal(allergyHit('Tetracyclines', 'Minoxidil 5% solution'), null);
  assert.equal(allergyHit('Tetracyclines', 'Doxylamine'), null);
  assert.equal(allergyHit('Quinolone', 'Levocetirizine 5 mg'), null);
  assert.equal(allergyHit(null, 'Amoxyclav'), null);
});

test('pregnancy and the isotretinoin + tetracycline interaction', () => {
  const preg = pregnancyFlag({ conditions: [{ name: 'Thyroid' }, { name: 'Pregnant' }] });
  assert.equal(preg, 'Pregnant');
  const w = rxWarnings([{ name: 'Isotretinoin 20 mg' }, { name: 'Doxycycline 100 mg' }, { name: 'Calamine lotion' }], { name: 'Meena', allergies: null, pregnant: preg });
  assert.equal(w.length, 3);
  assert.match(w[0], /^Meena is pregnant: Isotretinoin/);
  assert.match(w[2], /Isotretinoin 20 mg with Doxycycline 100 mg/);
  assert.deepEqual(rxWarnings([{ name: 'Finasteride 1 mg' }], { name: 'R', pregnant: null }), []);
  assert.equal(rxWarnings([{ name: 'Methotrexate' }], { name: 'R', pregnant: 'Breastfeeding' }).length, 1);
  assert.deepEqual(rxWarnings([{ name: 'Amoxyclav' }], { name: 'Meena', allergies: 'Penicillin' }), ['Meena is allergic to penicillin: Amoxyclav.']);
});

test('quantity counts units, never milligrams', () => {
  assert.equal(qtyFor({ dose: '500 mg', frequency: '1-0-1', durationDays: 7 }), 14);
  assert.equal(qtyFor({ dose: '2 tab', frequency: '1-0-1', durationDays: 5 }), 20);
  assert.equal(qtyFor({ dose: '1', frequency: '1-0-0', durationDays: 10 }), 10);
  assert.equal(qtyFor({ dose: '½', frequency: '1-0-0', durationDays: 10 }), 5);
  assert.equal(qtyFor({ dose: '0.1%', frequency: '0-0-1', durationDays: 30 }), 30);
  assert.equal(qtyFor({ dose: '1 tab', frequency: 'at night', durationDays: 30, route: 'topical' }), 1);
});

test('age text shows infants', () => {
  assert.equal(ageText({ ageYears: 0 }), '0 y');
  assert.equal(ageText({ ageYears: null }), null);
  assert.equal(ageText({ ageYears: 34 }), '34 y');
  assert.equal(ageText({ ageYears: 0, dob: '2026-04-01' }, new Date('2026-11-11')), '7 m');
  assert.equal(ageText({ ageYears: 3, dob: '2023-01-01' }, new Date('2026-11-11')), '3 y');
});
