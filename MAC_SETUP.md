# Run EyeSpeak on a Mac

## What to send

Send the `EyeSpeak-Mac-Demo.zip` file. Do **not** put a Gemini API key in the zip, a screenshot, or a shared document. The person running the demo should set their own key in Terminal or receive it privately.

## Before the demo

- Install Node.js 20 or newer from [nodejs.org](https://nodejs.org/).
- Use Google Chrome.
- Keep an internet connection: the webcam tracker loads from MediaPipe's CDN and Speak uses Gemini.

## Start it

1. Unzip `EyeSpeak-Mac-Demo.zip`.
2. Open **Terminal**.
3. Run these commands, replacing the path if the zip was saved somewhere other than Downloads:

```bash
cd ~/Downloads/EyeSpeak-Mac-Demo/EyeSpeak
node --version
export GEMINI_API_KEY="paste-the-key-here"
node server.mjs
```

4. In Chrome, open `http://localhost:4173`.
5. First choose **Try with mouse** to confirm the app opens. Then reload, choose **Start eye control**, allow camera access, and complete both calibration stages.

Keep the Terminal window open while presenting. Stop the server with `Control-C` after the demo.

## Camera troubleshooting

- Close Zoom, Teams, FaceTime, and other browser tabs that may use the webcam.
- In Chrome, allow camera access for `localhost:4173`.
- In macOS, check **System Settings → Privacy & Security → Camera → Google Chrome**.
- Sit about an arm's length from the camera with even front lighting.

## Gemini troubleshooting

If Speak says Gemini is not configured, the server was started without `GEMINI_API_KEY`. Stop it with `Control-C`, run the `export GEMINI_API_KEY=...` line again, then run `node server.mjs`.
