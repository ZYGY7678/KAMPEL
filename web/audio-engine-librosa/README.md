# Chord Studio — Librosa chord engine

Free Python chord-analysis service used as an optional engine by Chord Studio.

POST /analyze with multipart field `audio` and header:
`Authorization: Bearer <LOCAL_AUDIO_ENGINE_TOKEN>`

GET /health returns service status.

The default Chord Studio engine remains Chordino. This service is an additional selectable engine.
