import test from 'node:test';
import assert from 'node:assert/strict';
import { BlinkPauseGate } from '../public/gaze.mjs';

const BASELINE = 0.3;

test('pause engages before the 65ms closed confirmation would fire', () => {
  const gate = new BlinkPauseGate();
  // Lid closing at ~33ms per frame; the confirmation needs 65ms below baseline * 0.55.
  const closing = [
    { openness: 0.3, at: 0 },
    { openness: 0.21, at: 33 },
    { openness: 0.13, at: 66 },
    { openness: 0.06, at: 99 },
    { openness: 0.04, at: 132 },
  ];
  let pausedAt = null;
  let confirmedAt = null;
  let closedSince = 0;
  for (const frame of closing) {
    if (gate.update(frame.openness, BASELINE) && pausedAt === null) pausedAt = frame.at;
    if (frame.openness < BASELINE * 0.55) {
      if (!closedSince) closedSince = frame.at;
      if (frame.at - closedSince >= 65 && confirmedAt === null) confirmedAt = frame.at;
    } else {
      closedSince = 0;
    }
  }
  assert.equal(pausedAt, 33);
  assert.equal(confirmedAt, 132);
  assert.ok(pausedAt < confirmedAt);
});

test('pause holds through the reopening tail until openness clears the resume threshold', () => {
  const gate = new BlinkPauseGate();
  assert.equal(gate.update(0.12, BASELINE), true);
  // Just above the enter threshold is still a half-covered iris, so it must stay paused.
  assert.equal(gate.update(BASELINE * 0.78, BASELINE), true);
  assert.equal(gate.update(BASELINE * 0.74, BASELINE), true);
  assert.equal(gate.update(BASELINE * 0.85, BASELINE), true);
  assert.equal(gate.update(BASELINE * 0.89, BASELINE), true);
  assert.equal(gate.update(BASELINE * 0.95, BASELINE), false);
});

test('ordinary open-eye noise never engages pause', () => {
  const gate = new BlinkPauseGate();
  const noise = [1, 0.98, 1.02, 0.97, 1.03, 0.99, 0.96, 1.01, 0.98, 1.04, 0.95, 1];
  for (const scale of noise) {
    assert.equal(gate.update(BASELINE * scale, BASELINE), false);
  }
});

test('reset clears a pause so a fresh calibration starts unpaused', () => {
  const gate = new BlinkPauseGate();
  assert.equal(gate.update(0.05, BASELINE), true);
  gate.reset();
  assert.equal(gate.paused, false);
});

// Looking at the bottom of the screen narrows the lids, and a gate that reads that
// as a blink freezes tracking on exactly the rows the user is trying to reach.
test('a gradual narrowing from looking down is not treated as a blink', () => {
  const gate = new BlinkPauseGate();
  const baseline = 0.30;
  let openness = baseline;
  let now = 0;
  // Half a second to settle to 70% of baseline: below the level threshold, but
  // nothing like blink speed.
  for (let step = 0; step < 15; step += 1) {
    openness -= 0.006;
    now += 33;
    assert.equal(gate.update(openness, baseline, now), false, `paused at step ${step}, openness ${openness}`);
  }
  assert.ok(openness < baseline * 0.76);
  assert.ok(gate.settledBelow(openness, baseline), 'should ask the caller to re-baseline');
});

test('an actual blink still pauses immediately', () => {
  const gate = new BlinkPauseGate();
  const baseline = 0.30;
  gate.update(baseline, baseline, 0);
  // Lids travelling shut inside two frames.
  assert.equal(gate.update(baseline * 0.7, baseline, 33), true);
  assert.equal(gate.settledBelow(baseline * 0.7, baseline), false);
});

test('a deep closure pauses on level alone however slowly it arrives', () => {
  const gate = new BlinkPauseGate();
  const baseline = 0.30;
  let now = 0;
  for (const openness of [0.29, 0.26, 0.23, 0.20, 0.16]) {
    now += 200;
    gate.update(openness, baseline, now);
  }
  assert.equal(gate.paused, true);
});

test('without timestamps the gate keeps its original level-only behaviour', () => {
  const gate = new BlinkPauseGate();
  assert.equal(gate.update(0.30 * 0.7, 0.30), true);
});
