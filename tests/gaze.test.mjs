import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calibrationError,
  fitGazeMapping,
  GazeSmoother,
  mapGaze,
  summarizeCalibrationSamples,
} from '../public/gaze.mjs';

test('quadratic calibration map reconstructs a nonlinear gaze surface', () => {
  const targets = [];
  for (const rawX of [0.42, 0.47, 0.53, 0.58]) {
    for (const rawY of [0.42, 0.47, 0.53, 0.58]) {
      const x = (rawX - 0.5) * 10;
      const y = (rawY - 0.5) * 10;
      targets.push({
        raw: { x: rawX, y: rawY },
        target: {
          x: 720 + 260 * x + 38 * x * y + 22 * x * x,
          y: 430 + 210 * y - 26 * x * y + 18 * y * y,
        },
      });
    }
  }
  const mapping = fitGazeMapping(targets);
  const prediction = mapGaze(mapping, { x: 0.55, y: 0.46 });
  assert.ok(mapping);
  assert.ok(Math.abs(prediction.x - 847.9) < 2);
  assert.ok(Math.abs(prediction.y - 354.08) < 2);
  assert.ok(calibrationError(mapping, targets) < 2);
});

test('calibration sampling uses a robust median and reports its spread', () => {
  const result = summarizeCalibrationSamples([
    { x: 0.50, y: 0.50 },
    { x: 0.51, y: 0.49 },
    { x: 0.50, y: 0.51 },
    { x: 0.49, y: 0.50 },
    { x: 0.83, y: 0.18 },
  ]);
  assert.deepEqual(result.raw, { x: 0.5, y: 0.5 });
  assert.equal(result.count, 5);
  assert.ok(result.spread < 0.02);
});

const EYE_SCALE = 0.04;
const HEAD_CENTER = 0.5;

// Ground truth for the head tests: the screen point depends on where the head is,
// not only on the iris ratio, which is exactly what the polynomial alone cannot see.
function trueTarget(rawX, rawY, headX, headY) {
  const x = (rawX - 0.5) * 10;
  const y = (rawY - 0.5) * 10;
  const dx = (headX - HEAD_CENTER) / EYE_SCALE;
  const dy = (headY - HEAD_CENTER) / EYE_SCALE;
  return {
    x: 720 + 260 * x + 38 * x * y + 22 * x * x - 210 * dx,
    y: 430 + 210 * y - 26 * x * y + 18 * y * y - 175 * dy,
  };
}

function headSample(rawX, rawY, headX, headY) {
  const raw = { x: rawX, y: rawY, eyeDeltaX: 0, eyeDeltaY: 0, headX, headY, eyeScale: EYE_SCALE };
  return { raw, target: trueTarget(rawX, rawY, headX, headY) };
}

function headCalibrationSamples(offsets) {
  const ratios = [0.42, 0.47, 0.53, 0.58];
  const samples = [];
  for (let row = 0; row < ratios.length; row += 1) {
    for (let column = 0; column < ratios.length; column += 1) {
      const index = row * ratios.length + column;
      samples.push(headSample(
        ratios[column],
        ratios[row],
        HEAD_CENTER + offsets[(row + column) % 4] * EYE_SCALE,
        HEAD_CENTER + offsets[(row + 3 * column) % 4] * EYE_SCALE,
      ));
    }
  }
  return samples;
}

test('head-pose correction beats the polynomial alone when the head drifts', () => {
  const samples = headCalibrationSamples([-1, -0.35, 0.35, 1]);
  const mapping = fitGazeMapping(samples);
  assert.ok(mapping.headCorrection);
  const uncorrected = { ...mapping, headCorrection: null };

  const probes = [
    headSample(0.55, 0.46, HEAD_CENTER + 0.75 * EYE_SCALE, HEAD_CENTER - 0.6 * EYE_SCALE),
    headSample(0.45, 0.55, HEAD_CENTER - 0.8 * EYE_SCALE, HEAD_CENTER + 0.7 * EYE_SCALE),
  ];
  for (const probe of probes) {
    const corrected = mapGaze(mapping, probe.raw);
    const plain = mapGaze(uncorrected, probe.raw);
    const correctedError = Math.hypot(corrected.x - probe.target.x, corrected.y - probe.target.y);
    const plainError = Math.hypot(plain.x - probe.target.x, plain.y - probe.target.y);
    assert.ok(correctedError < plainError * 0.7, `${correctedError} vs ${plainError}`);
  }
  assert.ok(calibrationError(mapping, samples) < calibrationError(uncorrected, samples));
});

test('a calibration pass with a still head fits no head correction', () => {
  const jitter = [0.0002, -0.0001, 0.0001, -0.0002];
  const samples = headCalibrationSamples(jitter.map((value) => value / EYE_SCALE));
  const mapping = fitGazeMapping(samples);
  assert.equal(mapping.headCorrection, null);
  const raw = { x: 0.55, y: 0.46, eyeDeltaX: 0, eyeDeltaY: 0, headX: 0.56, headY: 0.44, eyeScale: EYE_SCALE };
  assert.deepEqual(mapGaze(mapping, raw), mapGaze({ ...mapping, headCorrection: null }, raw));
});

test('samples without head-pose fields still fit a usable base mapping', () => {
  const samples = [];
  for (const rawX of [0.42, 0.47, 0.53, 0.58]) {
    for (const rawY of [0.42, 0.47, 0.53, 0.58]) {
      samples.push({ raw: { x: rawX, y: rawY }, target: trueTarget(rawX, rawY, HEAD_CENTER, HEAD_CENTER) });
    }
  }
  const mapping = fitGazeMapping(samples);
  assert.equal(mapping.headCorrection, null);
  assert.ok(calibrationError(mapping, samples) < 2);
});

test('gaze smoother rejects a one-frame spike but accepts a confirmed gaze shift', () => {
  const smoother = new GazeSmoother({ outlierDistance: 180, minCutoff: 0.7, beta: 0.0012 });
  smoother.update({ x: 300, y: 300 }, 0);
  smoother.update({ x: 302, y: 298 }, 33);
  smoother.update({ x: 301, y: 301 }, 66);
  const spike = smoother.update({ x: 900, y: 80 }, 99);
  assert.equal(spike.rejected, true);
  assert.ok(spike.point.x < 310);
  const shift = smoother.update({ x: 905, y: 82 }, 132);
  assert.equal(shift.accepted, true);
  assert.ok(shift.point.x > 310);
});

// The upper eyelid follows the eyeball down, so the iris stays near-centred in the
// aperture and the raw vertical ratio covers a fraction of the horizontal range.
// A ridge that ignores that asymmetry flattens the vertical fit into a horizontal line.
test('a compressed vertical signal still maps across the full screen height', () => {
  const rawX = [0.35, 0.5, 0.65];
  const rawY = [0.495, 0.5, 0.505];
  const targetX = [150, 640, 1130];
  const targetY = [150, 400, 650];
  const samples = [];
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      samples.push({
        raw: { x: rawX[column], y: rawY[row] },
        target: { x: targetX[column], y: targetY[row] },
      });
    }
  }
  const mapping = fitGazeMapping(samples);
  const top = mapGaze(mapping, { x: 0.5, y: rawY[0] });
  const middle = mapGaze(mapping, { x: 0.5, y: rawY[1] });
  const bottom = mapGaze(mapping, { x: 0.5, y: rawY[2] });
  // The targets span 500px; a flat ridge collapses this to roughly a third of that.
  assert.ok(Math.abs(bottom.y - top.y) > 440);
  assert.ok(middle.y > top.y && middle.y < bottom.y);
  // The horizontal axis must not regress while fixing the vertical one.
  const left = mapGaze(mapping, { x: rawX[0], y: 0.5 });
  const right = mapGaze(mapping, { x: rawX[2], y: 0.5 });
  assert.ok(Math.abs(right.x - left.x) > 950);
});
