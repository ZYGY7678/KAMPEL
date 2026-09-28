# Chord Studio

Professional song-to-chords-and-lyrics web app.

## Stack

- Node.js + Express
- Gemini 3.8 Flash
- Gemini Files API for audio
- Two-pass high-reasoning analysis and verification
- Native DOCX export
- Responsive RTL-first UI

## Required environment variable

GEMINI_API_KEY

The API key is only read by the server and is never sent to the browser.

## Render

The root repository includes render.yaml. The service uses web/ as rootDir, auto-deploys from the tracked branch, and exposes /api/health.

## Notes on accuracy

The system deliberately uses a two-pass Gemini pipeline. The first pass extracts word-level lyric timing, chord events, key and sections. The second pass audits the first pass against the same audio before the result is shown.

Absolute 100 percent automatic accuracy cannot be guaranteed for every recording. The editor therefore includes manual-safe controls, tone transposition and chord simplification so the result remains editable.

## Local

Run inside web/:

npm install
npm start

Open http://localhost:10000
