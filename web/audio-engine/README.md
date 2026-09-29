# Chord Studio local audio engine (prototype)

This is a separate service prototype; it does not replace the live Gemini flow yet.

## Run

Use Python 3.11 and install the packages in `requirements.txt`, then run:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

`POST /analyze` accepts multipart field `audio` and returns the initial Chord Studio analysis shape: timed Whisper words plus a chord timeline estimated from librosa CQT chroma. The Whisper model is downloaded on first use; set `WHISPER_MODEL`, `WHISPER_DEVICE`, and `WHISPER_COMPUTE_TYPE` to tune the runtime. Audio decoding may require FFmpeg.

## Important limitations

- This is an initial signal-processing baseline, not a replacement-quality transcription system. Chords are estimated as major/minor triads and may be wrong on dense arrangements, bass inversions, modulations, or noisy audio.
- Whisper word timestamps and Hebrew singing transcription need validation on representative songs. No confidence score or song/artist identification is inferred.
- The service requires its own Python runtime, model storage, CPU/RAM, and deployment. It is not yet wired into the Node upload route; production still uses the existing Gemini flow until integration and benchmark tests pass.
- Review the licenses of all dependencies and model weights before commercial deployment.
