// Medical history as Tatva asks it: each choice – / Y / N. A No is kept apart from the items, so the allergy check never reads it as a Yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHistory, allergyText } from '../src/lib/history.js';

test('history keeps Yes as items, No apart, and the free-text note', () => {
  const h = cleanHistory({ conditions: [{ name: 'Thyroid' }], drugAllergies: [], denied: { conditions: ['Diabetes', 'Thyroid', ''], drugAllergies: ['Sulfa'], bogus: ['x'] }, notes: '  Mother had psoriasis  ', none: ['family'] });
  assert.deepEqual(h.conditions, [{ name: 'Thyroid' }]);
  assert.deepEqual(h.denied, { conditions: ['Diabetes'], drugAllergies: ['Sulfa'] }); // a Yes wins over a No; unknown keys and blanks go
  assert.equal(h.notes, 'Mother had psoriasis');
  assert.deepEqual(h.none, ['family']);
  assert.equal(allergyText(h), null); // "no sulfa allergy" is not an allergy
});
