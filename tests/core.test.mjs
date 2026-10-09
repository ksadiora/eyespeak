import test from 'node:test';
import assert from 'node:assert/strict';
import { LETTER_GROUPS, deleteCharacter, lettersForGroup } from '../public/core.mjs';

test('letter keyboard uses compact three-letter groups', () => {
  assert.deepEqual(LETTER_GROUPS, ['ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQR', 'STU', 'VWX', 'YZ']);
  assert.deepEqual(lettersForGroup('ABC'), ['A', 'B', 'C']);
  assert.deepEqual(lettersForGroup('NOPE'), []);
});

test('deletion removes only the latest letter', () => {
  assert.equal(deleteCharacter('HELLO'), 'HELL');
  assert.equal(deleteCharacter(''), '');
});
