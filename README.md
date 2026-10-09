# EyeSpeak

EyeSpeak is a webcam AAC hackathon prototype. It uses a nine-point gaze calibration to identify a large letter tile, then uses a dwell hold as the confirmation input. An orb sits on whichever tile you are looking at and fills; when it completes, that tile is selected.

- Look at a three-letter group such as `ABC` and **hold your gaze** on it to open it.
- Hold a letter to add it and return to the group board.
- Hold the **DELETE** bar under the group board to remove the previous letter.
- Hold the large **Speak** button to send the letter sequence to Gemini for sentence repair, show the repaired sentence, and read it aloud.

Blinks no longer select anything, but they still pause tracking while the eyelid is in motion, so blinking cannot drag the pointer off a tile. The pause is triggered by how *fast* the lids close, not only how far: the lids narrow whenever the eye rotates downward, so a purely level-based test reads the bottom of the screen as a half-blink and freezes tracking exactly where it is needed. A deep closure still pauses on level alone; a shallow narrowing pauses only if it arrived at blink speed, and otherwise becomes the new resting aperture. Dwell timing is `dwellMs` at the top of `public/app.mjs`; the screen still contains only the message, keyboard, and Speak button after setup.

## Tracking rate and smoothing

The app analyzes every frame the camera delivers rather than every screen repaint, so the tracking rate follows the camera instead of the display and does not fall off when the window moves to the background. It asks the camera for 60fps; most webcams cap at 30 and ignore the request.

How hard the gaze point is averaged is a matter of taste, so it is a named level rather than a constant: `raw`, `low`, `medium`, `high`, defined together in `SMOOTHING_PRESETS` in `public/gaze.mjs`. Each level sets the median window, the One Euro cutoffs, and how long a large jump waits to be confirmed — the three places lag accumulates. `low` is the default, and `high` is the older, heavier behavior.

- Press `[` and `]` while the app is running to move down and up the levels; a toast names the new one.
- Press `d` for a readout of camera fps, analyzed fps, inference time, the current level, head yaw/pitch/roll, and the calibration fit. It is off by default.

Calibration accuracy is reported **per axis** — `fit 41/63px held 88 socket` means 41px average error across, 63px up-down, and 88px on targets held out of the fit — because a map that tracks left-right while ignoring up-down is this project's recurring failure, and a single combined number hides exactly that. The trailing word is which method won. Up to six candidates are fitted and scored — the geometric eye model and the ratio reading, each with and without the lid-aperture terms, and the ratio reading in both its vertical forms: the socket-relative and lid-relative iris readings, each with and without the lid-aperture terms. Which is better depends on the person's eyes and camera angle, so calibration measures rather than deciding in advance.

The lid aperture is a vertical gaze cue in its own right, not only a blink signal. The upper lid rides down with the eye — which is exactly why the lid-relative iris *ratio* failed, since dividing one by the other cancels the movement out — but the same motion makes the aperture a large, direct reading of vertical gaze, far bigger than the iris displacement the socket measure sees. It is kept as its own term so the fit can weigh it against the iris, and dropped when held-out scoring says it is not earning its place.

`vsig 2.3` in the readout is the vertical signal check, and it is the number to look at first when up-down tracking disappoints. It groups the calibration samples by screen row and compares how far apart the rows' readings sit against how much a single row wanders on its own. Above about 1.5 the rows are genuinely distinguishable, so a poor result is a mapping or smoothing problem worth chasing. Near or below 1 the rows overlap: the eye is not telling the camera where it is looking vertically, and no amount of fitting can recover what was never measured — that calls for a camera angle or lighting change, not a code change. A trailing `!` means the rows separated but not in screen order, which describes something other than vertical gaze. The full per-row table is logged to the browser console at the end of every calibration.

The held-out number is the honest one, and it is the one that picks the vertical reading. Error measured on the same targets a map was fitted to always flatters it, and flatters the more flexible option most, so the choice is made by fitting on four fifths of the grid and scoring on the fifth that was withheld, five times over.

Gaze is read by a geometric eye model, the approach the more accurate open-source trackers are built on, with the ratio-based reading kept as a fallback candidate.

The iris rides on a sphere around the eyeball's centre of rotation, so its displacement from the eye's resting centre *is* the sine of the gaze angle — once that displacement is in millimetres. Real-world scale comes from the iris itself: the horizontal iris diameter is 11.7mm across almost everyone, which is the constant MediaPipe Iris uses for depth estimation, and the model measures the iris every frame. Leaning in or sitting back changes every landmark offset and the measured iris radius in the same proportion, so the two cancel; an eye-width ratio instead has to trust the eye-corner landmarks, which are soft tissue and far less crisply located than the iris rim. The displacement is taken along the head's own axes, so head tilt and turn do not leak into the reading — the landmark equivalent of the normalization step appearance-based trackers apply before regression. The output is an angle rather than a ratio, which also leaves the calibration polynomial much less nonlinearity to absorb, and it yields a real distance-to-camera reading as a by-product.

Gaze is read from a rigid 3D frame for the head — the eye corners, nose bridge, and chin — combined with where each iris sits in its socket. Vertical gaze is measured against the eye corners rather than the eyelids, because the upper lid rides down with the eyeball and leaves the iris near-centred in the aperture no matter where the eye points. Browsers are not given the TrueDepth/Face ID depth stream, so the head pose is recovered from the face mesh geometry instead.

## Calibration flow

Calibration repeats as a whole, not only its last stage. A **round** is the full twenty-five dots plus the trace passes that measure the result; a round that lands above the target is followed by another one, up to three. Each round's dots are fitted *alongside everything already gathered*, so every round is a better-supported fit measured again from scratch rather than a pick between separate attempts. Later rounds offset the grid by half a cell, so a repeat measures places on the screen the previous round never visited instead of re-measuring the same twenty-five spots. It stops early when the target is met, and stops when a round fails to beat the last one by a visible margin — at that point the limit is the signal, not the number of dots.

EyeSpeak first uses a 5x5 grid of twenty-five stationary dots to build a stable base gaze map. Five levels per axis is the point of it: the base map has six free parameters, so the previous nine dots barely determined them and one noisy dot could flatten vertical travel across the whole screen. The dots run in serpentine order, and the grid reaches nearer the screen edges so the corners of the board are interpolated rather than extrapolated.

Nothing about the sampling is on a clock. Each dot waits for the eye to actually arrive and hold still, takes readings for about a second while it stays still, and discards the batch and asks again if the gaze drifts off part way through. Sampling on a fixed timer is what corrupts a pass: a saccade to a new dot, plus the corrective one that follows it, runs well past a third of a second, so early readings are of an eye still in flight — and one dirty point bends the whole fitted surface, not only its own corner of it. A green ring fills around the dot while readings are actually being taken, so the wait beforehand reads as the app waiting for the eye rather than as the app doing nothing. Expect the full pass to take roughly a minute. It then switches to a full-screen trace pass: a white target moves along a dashed squiggle while the app draws its predicted gaze trail over the line. The target pauses at nine points so the app can collect steady samples, using the same wait-for-fixation rule as the dots.

**The trace repeats until it measures well**, up to three passes, rather than running once and hoping. Each pass walks a *different* path — a Lissajous figure from a different pair of sine frequencies — because re-running one fixed squiggle would let the fit memorise those same anchors and the error would fall without the map improving anywhere else on screen. A fresh path each time means the number being checked is always measured on points the current map has never been fitted to.

A pass refines the map only when the result preserves the base-dot calibration; otherwise the dot result stands. The loop stops when the measured error is under `traceTargetError` (90px), or when two passes running fail to improve it by at least `traceImprovementFloor` (6px) — at that point the limit is the tracking itself, not how much data has been thrown at it. It then restores the best *measured* map, not the newest one: a refit made at the end of a pass has not been tested on anything yet. The overlay reports the error after each pass and says whether the target was reached or the best pass was kept.

## Run it

```bash
cd eyespeak
export GEMINI_API_KEY="your-key-from-google-ai-studio"
node server.mjs
```

Open `http://localhost:4173` in Chrome. Click **Start eye control**, allow camera access, and complete the calibration dots. Use **Try with mouse** to rehearse the group-and-letter flow without the camera.

`GEMINI_API_KEY` applies only to the terminal window that starts EyeSpeak. The browser never receives the key. You can optionally set `GEMINI_MODEL` before starting the server; its default is `gemini-2.5-flash`.

## Gemini behavior

When Speak is pressed, the server sends the entered letters to Gemini's `generateContent` endpoint with instructions to repair spacing and likely misspellings while avoiding added meaning. The app sends no text to Gemini before Speak is pressed. If Gemini is unavailable or no key is configured, EyeSpeak leaves the entered text unchanged and shows an error.

This is a prototype, not a medical device. The model can make an incorrect inference from ambiguous letter sequences, so the repaired sentence remains visible before it is spoken.

## Validation

```bash
npm test
```

The project has no npm dependencies. MediaPipe Face Mesh loads from jsDelivr, so the first eye-control run needs internet access; Gemini repair needs internet access whenever Speak is used.

## References

Gaze estimation follows the geometric eye-model approach shared by the accurate open-source trackers: a 3D eyeball whose optical axis runs from the eyeball centre through the iris centre, as described in [OpenFace 2.0](https://ieeexplore.ieee.org/document/8373812) and the [3D eye model literature](https://sites.ecse.rpi.edu/~cvrl/3DFace_Eye/3D_eye.html). Metric scale comes from the constant iris diameter that [MediaPipe Iris](https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/) uses for depth estimation. Cancelling head pose before estimating gaze is the landmark-space form of the normalization in [Zhang, Sugano and Bulling's revisited data normalization](https://www.semanticscholar.org/paper/ed0cf5f577f5030ac68ab62fee1cf065349484cc). For reference, [WebGazer](https://webgazer.cs.brown.edu/), the most widely used browser tracker, reports around 4 degrees of error, and newer browser systems such as [WebEyeTrack](https://arxiv.org/abs/2508.19544) report roughly 2-3 degrees.

The Gemini server integration uses the official [`generateContent` API](https://ai.google.dev/api/generate-content) and reads its key from `GEMINI_API_KEY` as described in [Google's API-key documentation](https://ai.google.dev/gemini-api/docs/api-key).
