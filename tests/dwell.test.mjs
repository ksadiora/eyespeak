import test from 'node:test';
import assert from 'node:assert/strict';
import { DwellSelector } from '../public/core.mjs';

const options = { dwellMs: 900, graceMs: 200, cooldownMs: 600 };

test('holding one tile selects it once the dwell time elapses', () => {
  const dwell = new DwellSelector(options);
  assert.equal(dwell.update('tile-a', 0).fired, false);
  assert.ok(dwell.update('tile-a', 500).progress > 0.5);
  assert.equal(dwell.update('tile-a', 899).fired, false);
  assert.equal(dwell.update('tile-a', 900).fired, true);
});

test('a selection blocks whichever tile the re-render puts under the gaze', () => {
  const dwell = new DwellSelector(options);
  dwell.update('tile-a', 0);
  assert.equal(dwell.update('tile-a', 900).fired, true);
  assert.equal(dwell.update('tile-b', 905).progress, 0);
  assert.equal(dwell.update('tile-b', 1400).fired, false);
  assert.equal(dwell.update('tile-b', 1600).progress, 0);
  assert.equal(dwell.update('tile-b', 2500).fired, true);
});

test('a brief wobble off the tile keeps the hold alive', () => {
  const dwell = new DwellSelector(options);
  dwell.update('tile-a', 0);
  dwell.update('tile-a', 600);
  assert.ok(dwell.update(null, 700).progress > 0.6);
  assert.equal(dwell.update('tile-a', 900).fired, true);
});

test('looking away for longer than the grace window drops the hold', () => {
  const dwell = new DwellSelector(options);
  dwell.update('tile-a', 0);
  dwell.update(null, 600);
  assert.equal(dwell.update(null, 900).progress, 0);
  assert.equal(dwell.update('tile-a', 1000).progress, 0);
  assert.equal(dwell.update('tile-a', 1700).fired, false);
  assert.equal(dwell.update('tile-a', 1900).fired, true);
});

test('moving to a different tile restarts the hold', () => {
  const dwell = new DwellSelector(options);
  dwell.update('tile-a', 0);
  dwell.update('tile-a', 800);
  assert.equal(dwell.update('tile-b', 810).progress, 0);
  assert.equal(dwell.update('tile-b', 1000).fired, false);
  assert.equal(dwell.update('tile-b', 1710).fired, true);
});
