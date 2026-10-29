// The consultation's quick medicine line: "itra 100 1-0-1 7d after food" becomes a full prescription row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRxLine } from '../web/src/rxLine.js';

const meds = [
  { id: 'i1', name: 'Itraconazole 100 mg', defaults: { frequency: '1-0-0', durationDays: 14 } },
  { id: 'i2', name: 'Itraconazole 200 mg', defaults: {} },
  { id: 't1', name: 'Terbinafine 250 mg', defaults: { durationDays: 14, instructions: 'after food' } },
  { id: 'a1', name: 'Adapalene 0.1% gel', defaults: {} },
];

test('a typed line becomes a prescription row', () => {
  const r = parseRxLine('itra 100 1-0-1 7d after food', meds)!;
  assert.equal(r.medicineId, 'i1'); assert.equal(r.frequency, '1-0-1'); assert.equal(r.durationDays, 7); assert.equal(r.instructions, 'after food');
  assert.equal(parseRxLine('itra 200 2w', meds)!.medicineId, 'i2', 'strength picks the right one');
  assert.equal(parseRxLine('itra 200 2w', meds)!.durationDays, 14, 'weeks become days');
  const d = parseRxLine('terbinafine', meds)!;
  assert.equal(d.durationDays, 14, 'catalogue defaults fill the rest'); assert.equal(d.instructions, 'after food');
  const n = parseRxLine('adapalene at night 30 days', meds)!;
  assert.equal(n.frequency, 'at night'); assert.equal(n.durationDays, 30); assert.equal(n.instructions, undefined);
  const x = parseRxLine('calamine lotion 1-1-1', meds)!;
  assert.equal(x.medicineId, null, 'unknown medicine stays as typed'); assert.equal(x.name, 'calamine lotion');
  assert.equal(parseRxLine('   ', meds), null);
});
