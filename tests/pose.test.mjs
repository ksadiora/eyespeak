import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axisError,
  calibrationError,
  crossValidatedError,
  evaluateTracePass,
  fixationSpread,
  extractFaceMeasurement,
  fitBestGazeMapping,
  fitGazeMapping,
  GazeSmoother,
  headPose,
  verticalSeparation,
} from '../public/gaze.mjs';

const EYE_HALF_WIDTH = 0.03;

// A face built to order, so a single property can be moved while everything else
// is held still. Only the landmarks the gaze code reads are given real positions.
function buildFace({ irisY = 0.5, lidFollowsEye = true, lidHalf = 0.008 } = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const place = (index, x, y, z = 0) => { landmarks[index] = { x, y, z }; };
  for (const [outer, inner, top, bottom, irisStart, centerX] of [
    [33, 133, 159, 145, 468, 0.43],
    [362, 263, 386, 374, 473, 0.57],
  ]) {
    place(outer, centerX - EYE_HALF_WIDTH, 0.5);
    place(inner, centerX + EYE_HALF_WIDTH, 0.5);
    // The whole point of the vertical rework: when the eye looks down the upper lid
    // rides down with it, so the iris stays put inside the aperture even though the
    // eyeball has plainly rotated.
    const lidCenter = lidFollowsEye ? irisY : 0.5;
    place(top, centerX, lidCenter - lidHalf);
    place(bottom, centerX, lidCenter + lidHalf);
    for (let offset = 0; offset < 5; offset += 1) place(irisStart + offset, centerX, irisY);
  }
  place(168, 0.5, 0.47, 0.02);
  place(152, 0.5, 0.62, 0);
  return landmarks;
}

test('vertical gaze survives an eyelid that follows the eye down', () => {
  const up = extractFaceMeasurement(buildFace({ irisY: 0.492 })).raw;
  const middle = extractFaceMeasurement(buildFace({ irisY: 0.5 })).raw;
  const down = extractFaceMeasurement(buildFace({ irisY: 0.508 })).raw;

  // The lid-relative reading is the one that went flat: it cannot tell these apart.
  assert.ok(Math.abs(down.lidY - up.lidY) < 1e-9);
  // The socket-relative reading the mapping now uses does, and in the right order.
  assert.ok(down.y > middle.y && middle.y > up.y);
  assert.ok(down.y - up.y > 0.4);
});

test('the vertical channel still reads a lid that stays put', () => {
  const up = extractFaceMeasurement(buildFace({ irisY: 0.492, lidFollowsEye: false })).raw;
  const down = extractFaceMeasurement(buildFace({ irisY: 0.508, lidFollowsEye: false })).raw;
  assert.ok(down.lidY > up.lidY);
  assert.ok(down.y > up.y);
});

// Rotation about the vertical axis, applied to the rigid landmarks the pose reads.
function turnedFace(radians) {
  const landmarks = buildFace();
  return landmarks.map((point) => {
    const x = point.x - 0.5;
    const z = point.z;
    return {
      x: 0.5 + x * Math.cos(radians) + z * Math.sin(radians),
      y: point.y,
      z: -x * Math.sin(radians) + z * Math.cos(radians),
    };
  });
}

test('head pose reads yaw from the rigid landmarks', () => {
  const straight = headPose(turnedFace(0));
  assert.ok(Math.abs(straight.yaw) < 1e-9);
  const turns = [0.1, 0.2, 0.35].map((angle) => headPose(turnedFace(angle)).yaw);
  const mirrored = headPose(turnedFace(-0.2)).yaw;
  // Which way the sign runs is a handedness convention that calibration absorbs.
  // What has to hold is that yaw grows steadily with the turn and mirrors cleanly.
  const magnitudes = turns.map(Math.abs);
  assert.ok(magnitudes[0] < magnitudes[1] && magnitudes[1] < magnitudes[2], `not monotonic: ${turns}`);
  assert.ok(turns.every((value) => Math.sign(value) === Math.sign(turns[0])), `sign flips: ${turns}`);
  assert.ok(Math.sign(mirrored) === -Math.sign(turns[1]));
  assert.ok(Math.abs(mirrored + turns[1]) < 1e-9);
  // Roughly sin(angle): a 0.35rad turn should read near 0.34, not a fraction of it.
  assert.ok(Math.abs(magnitudes[2] - Math.sin(0.35)) < 0.02);
});

test('a face with no depth still yields a usable measurement', () => {
  const flat = buildFace().map((point) => ({ x: point.x, y: point.y }));
  const measurement = extractFaceMeasurement(flat);
  assert.ok(measurement);
  assert.ok(Number.isFinite(measurement.raw.y));
});

test('lower smoothing levels follow a moving gaze more closely', () => {
  const track = (level) => {
    const smoother = new GazeSmoother({ level });
    let last = null;
    for (let step = 0; step <= 10; step += 1) last = smoother.update({ x: 300 + step * 20, y: 400 }, step * 16);
    return last.point.x;
  };
  const target = 500;
  const lag = (level) => target - track(level);
  assert.ok(lag('raw') < lag('low'), 'raw should lag least');
  assert.ok(lag('low') < lag('medium'));
  assert.ok(lag('medium') < lag('high'));
  // The shipped default has to actually keep up, not merely beat the old setting.
  assert.ok(lag('low') < 40, `default level lags ${lag('low')}px behind`);
});

// A deterministic stand-in for a noisy channel, so the choice below is reproducible.
function pseudoNoise(seed) {
  return ((Math.sin(seed * 12.9898) * 43758.5453) % 1) * 0.3;
}

function gridSamples({ informative }) {
  const levels = [0.38, 0.44, 0.5, 0.56, 0.62];
  const samples = [];
  for (let row = 0; row < levels.length; row += 1) {
    for (let column = 0; column < levels.length; column += 1) {
      const vertical = levels[row];
      const noise = 0.5 + pseudoNoise(row * 5 + column + 1);
      samples.push({
        raw: {
          x: levels[column],
          y: informative === 'socket' ? vertical : noise,
          lidY: informative === 'lid' ? vertical : noise,
        },
        target: { x: 120 + (levels[column] - 0.5) * 4000, y: 100 + (vertical - 0.5) * 2200 },
      });
    }
  }
  return samples;
}

test('calibration keeps whichever vertical reading actually predicts the targets', () => {
  for (const informative of ['socket', 'lid']) {
    const samples = gridSamples({ informative });
    const mapping = fitBestGazeMapping(samples);
    assert.equal(mapping.verticalSource, informative);
    assert.ok(axisError(mapping, samples).y < 40, `${informative} fit is loose`);
  }
});

test('accuracy is reported per axis so a flat vertical map cannot hide', () => {
  const samples = gridSamples({ informative: 'socket' });
  const flattened = samples.map((sample) => ({ ...sample, raw: { ...sample.raw, y: 0.5 } }));
  const mapping = fitGazeMapping(flattened);
  const error = axisError(mapping, samples);
  // Horizontal still fits; vertical cannot, and the two numbers say which is which.
  assert.ok(error.x < 40, `horizontal should still fit, got ${error.x}`);
  // A flat map can only ever predict the middle of the vertical span, so its error
  // is the spread of the targets themselves — here about 187px.
  assert.ok(error.y > 150, `vertical should be visibly broken, got ${error.y}`);
  assert.ok(error.y > error.x * 4, `the two axes should not look alike: ${error.x} vs ${error.y}`);
});

test('fixation spread separates a parked eye from one still travelling', () => {
  const parked = [
    { x: 0.500, y: 0.500 }, { x: 0.502, y: 0.499 }, { x: 0.499, y: 0.501 },
    { x: 0.501, y: 0.500 }, { x: 0.500, y: 0.502 }, { x: 0.498, y: 0.500 },
    { x: 0.501, y: 0.499 },
  ];
  // A saccade in progress: successive readings march in one direction.
  const travelling = parked.map((point, index) => ({ x: point.x + index * 0.012, y: point.y - index * 0.009 }));
  // 0.012 is the parked tolerance the calibration uses, and twice that is where it
  // abandons a batch. The drift above covers about one calibration column, which is
  // the smallest movement that has to be caught: anything looser lets a slow slide
  // off the dot pass as a fixation.
  assert.ok(fixationSpread(parked) < 0.012, `parked reads ${fixationSpread(parked)}`);
  assert.ok(fixationSpread(travelling) > 0.012 * 2, `travelling reads ${fixationSpread(travelling)}`);
});

test('held-out error exceeds in-sample error, and is what picks the vertical source', () => {
  const samples = gridSamples({ informative: 'socket' });
  const mapping = fitBestGazeMapping(samples);
  assert.equal(mapping.verticalSource, 'socket');
  const inSample = calibrationError(mapping, samples);
  // The honest number is the larger one; reporting the flattering one is the trap.
  assert.ok(mapping.heldOutError >= inSample, `${mapping.heldOutError} vs ${inSample}`);
  assert.ok(crossValidatedError(samples, 'socket') < crossValidatedError(samples, 'lid'));
});

const traceRules = { targetError: 90, improvementFloor: 6 };

function runTraceSequence(errors) {
  let state = { bestError: Infinity, stalls: 0 };
  const passes = [];
  for (const averageError of errors) {
    const verdict = evaluateTracePass({ averageError, ...state }, traceRules);
    state = { bestError: verdict.bestError, stalls: verdict.stalls };
    passes.push(verdict);
    if (verdict.stop) break;
  }
  return { passes, ...state };
}

test('the trace repeats until it measures under the target', () => {
  const { passes, bestError } = runTraceSequence([240, 170, 120, 84, 60]);
  assert.equal(passes.length, 4, 'should stop on the pass that first beats the target');
  assert.ok(passes.at(-1).reached);
  assert.equal(bestError, 84);
});

test('a trace that never reaches the target still stops once it stops improving', () => {
  const { passes, bestError } = runTraceSequence([200, 150, 149, 148, 100]);
  // Two passes running that moved the number by less than the floor, so it gives up
  // rather than spending another twenty seconds per pass to shave a pixel.
  assert.equal(passes.length, 4);
  assert.ok(!passes.at(-1).reached);
  assert.equal(bestError, 148);
});

test('a single pass under the target does not trigger a second one', () => {
  const { passes } = runTraceSequence([70, 200]);
  assert.equal(passes.length, 1);
  assert.ok(passes[0].reached);
});

test('a worse pass never replaces a better best', () => {
  const { bestError } = runTraceSequence([120, 300, 290]);
  assert.equal(bestError, 120);
});

// Twenty-five samples on a 5x5 grid, with control over how much of the vertical
// target actually reaches the reading and how noisy that reading is.
function verticalGrid({ signal, noise }) {
  const samples = [];
  let seed = 1;
  const jitter = () => { seed += 1; return pseudoNoise(seed) / 0.3 * noise; };
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      samples.push({
        raw: { x: 0.4 + column * 0.05, y: 0.5 + (row - 2) * signal + jitter() },
        target: { x: 100 + column * 250, y: 100 + row * 160 },
      });
    }
  }
  return samples;
}

test('vertical separation tells a real signal from rows that overlap', () => {
  const strong = verticalSeparation(verticalGrid({ signal: 0.05, noise: 0.004 }));
  assert.ok(strong.ratio > 1.5, `strong signal scored ${strong.ratio}`);
  assert.ok(strong.monotonic);
  assert.equal(strong.rows.length, 5);

  // The failure this is built to name: readings that barely move between rows while
  // wandering as much within one row. No fit can recover what was never measured.
  const drowned = verticalSeparation(verticalGrid({ signal: 0.002, noise: 0.02 }));
  assert.ok(drowned.ratio < 1.5, `drowned signal scored ${drowned.ratio}`);
});

test('separation flags rows that move but not in screen order', () => {
  const samples = verticalGrid({ signal: 0.05, noise: 0.002 });
  const scrambled = samples.map((sample) => ({
    ...sample,
    raw: { ...sample.raw, y: sample.target.y === 420 ? 0.9 : sample.raw.y },
  }));
  assert.equal(verticalSeparation(scrambled).monotonic, false);
});

test('the lid aperture can carry vertical gaze when the iris reading cannot', () => {
  // An eye whose iris barely moves vertically, but whose lid tracks it plainly.
  const samples = verticalGrid({ signal: 0.001, noise: 0.006 }).map((sample) => ({
    ...sample,
    raw: { ...sample.raw, aperture: 0.3 - (sample.target.y - 420) * 0.00022 },
  }));
  const withAperture = crossValidatedError(samples, 'socket', true);
  const without = crossValidatedError(samples, 'socket', false);
  assert.ok(withAperture < without * 0.6, `${withAperture} vs ${without}`);
  // And the chooser has to actually pick it up rather than needing to be told.
  assert.equal(fitBestGazeMapping(samples).aperture, true);
});

test('aperture terms are dropped when they carry nothing about vertical gaze', () => {
  // The aperture here varies by column only, so it is a real signal that says
  // nothing whatever about the row — the case where the extra freedom can do no
  // good and can only find noise to fit.
  const samples = verticalGrid({ signal: 0.05, noise: 0.003 }).map((sample) => ({
    ...sample,
    raw: { ...sample.raw, aperture: 0.3 + pseudoNoise(Math.round(sample.target.x)) * 0.05 },
  }));
  const mapping = fitBestGazeMapping(samples);
  assert.equal(mapping.aperture, false);
  assert.ok(crossValidatedError(samples, mapping.verticalSource, false)
    <= crossValidatedError(samples, mapping.verticalSource, true));
});

// A face whose eyes rotate about a real eyeball centre, rendered as landmarks the
// way MediaPipe would report them, so the geometric model can be checked against
// the angle it is supposed to recover.
const MM_PER_UNIT = 0.0005; // normalized units per mm at this synthetic distance
function eyeModelFace({ yaw = 0, pitch = 0, scale = 1, roll = 0 } = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const mm = (value) => value * MM_PER_UNIT * scale;
  const rotate = (px, py) => ({
    x: 0.5 + (px - 0.5) * Math.cos(roll) - (py - 0.5) * Math.sin(roll),
    y: 0.5 + (px - 0.5) * Math.sin(roll) + (py - 0.5) * Math.cos(roll),
  });
  const put = (index, px, py, z = 0) => { const r = rotate(px, py); landmarks[index] = { ...r, z }; };
  for (const [centre, rim, cornerA, cornerB, lidTop, lidBottom, cx] of [
    [468, [469, 470, 471, 472], 33, 133, 159, 145, 0.43],
    [473, [474, 475, 476, 477], 362, 263, 386, 374, 0.57],
  ]) {
    put(cornerA, cx - mm(15), 0.5);
    put(cornerB, cx + mm(15), 0.5);
    put(lidTop, cx, 0.5 - mm(5));
    put(lidBottom, cx, 0.5 + mm(5));
    // Iris centre displaced on the eyeball sphere by the gaze angle.
    const ix = cx + mm(10.5 * Math.sin(yaw));
    const iy = 0.5 + mm(10.5 * Math.sin(pitch));
    put(centre, ix, iy);
    const r = mm(11.7 / 2);
    put(rim[0], ix - r, iy); put(rim[1], ix, iy - r);
    put(rim[2], ix + r, iy); put(rim[3], ix, iy + r);
  }
  put(168, 0.5, 0.47, 0.02);
  put(152, 0.5, 0.62, 0);
  return landmarks;
}

test('the eye model recovers the gaze angle it was given', () => {
  for (const [yaw, pitch] of [[0, 0], [0.2, -0.15], [-0.25, 0.3]]) {
    const raw = extractFaceMeasurement(eyeModelFace({ yaw, pitch })).raw;
    assert.ok(Math.abs(raw.modelX - yaw) < 0.02, `yaw ${raw.modelX} vs ${yaw}`);
    assert.ok(Math.abs(raw.modelY - pitch) < 0.02, `pitch ${raw.modelY} vs ${pitch}`);
  }
});

test('the eye model reads the same angle when the face moves closer', () => {
  // The whole point of taking scale from the iris: sitting closer enlarges every
  // landmark offset AND the measured iris, and the two cancel.
  const near = extractFaceMeasurement(eyeModelFace({ yaw: 0.22, pitch: -0.18, scale: 1.6 })).raw;
  const far = extractFaceMeasurement(eyeModelFace({ yaw: 0.22, pitch: -0.18, scale: 0.7 })).raw;
  assert.ok(Math.abs(near.modelX - far.modelX) < 0.01, `${near.modelX} vs ${far.modelX}`);
  assert.ok(Math.abs(near.modelY - far.modelY) < 0.01, `${near.modelY} vs ${far.modelY}`);
  // And it reports a real distance, which the ratio reading never could.
  assert.ok(near.distanceMm > 0 && far.distanceMm > near.distanceMm);
});

test('a tilted head does not leak into the eye model angles', () => {
  const level = extractFaceMeasurement(eyeModelFace({ yaw: 0.2, pitch: 0.1 })).raw;
  const tilted = extractFaceMeasurement(eyeModelFace({ yaw: 0.2, pitch: 0.1, roll: 0.35 })).raw;
  assert.ok(Math.abs(level.modelX - tilted.modelX) < 0.02, `${level.modelX} vs ${tilted.modelX}`);
  assert.ok(Math.abs(level.modelY - tilted.modelY) < 0.02, `${level.modelY} vs ${tilted.modelY}`);
});

test('calibration picks the eye model when it predicts targets better', () => {
  const samples = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const yaw = (column - 2) * 0.12;
      const pitch = (row - 2) * 0.09;
      // Head distance wanders between dots, which is exactly the case the ratio
      // reading handles worst and the metric model shrugs off.
      const scale = 1 + ((row * 5 + column) % 4) * 0.18;
      const raw = extractFaceMeasurement(eyeModelFace({ yaw, pitch, scale })).raw;
      samples.push({ raw, target: { x: 640 + yaw * 2600, y: 400 + pitch * 2400 } });
    }
  }
  const mapping = fitBestGazeMapping(samples);
  assert.equal(mapping.featureSource, 'model');
  assert.ok(mapping.heldOutError < 30, `held out ${mapping.heldOutError}`);
  const ratioScore = mapping.candidateScores.find((c) => c.featureSource === 'ratio').score;
  assert.ok(mapping.heldOutError < ratioScore, `${mapping.heldOutError} vs ratio ${ratioScore}`);
});
