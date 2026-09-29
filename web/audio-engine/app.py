"""Standalone local audio-analysis prototype for Chord Studio.

Runs transcription with faster-whisper and estimates chord labels from chroma.
This service is intentionally separate from the production Node app until benchmarked.
"""
import os
import tempfile
from pathlib import Path

import librosa
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile, Header
from faster_whisper import WhisperModel

app = FastAPI(title="Chord Studio Local Audio Engine", version="0.1.0")
MODEL_SIZE = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
whisper_model = None
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def get_whisper():
    global whisper_model
    if whisper_model is None:
        whisper_model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    return whisper_model


def chord_templates():
    templates = []
    labels = []
    for root, name in enumerate(NOTES):
        for quality, intervals in (("", (0, 4, 7)), ("m", (0, 3, 7))):
            vector = np.zeros(12, dtype=np.float32)
            vector[(root + np.array(intervals)) % 12] = 1.0
            vector /= np.linalg.norm(vector)
            templates.append(vector)
            labels.append(name + quality)
    return np.stack(templates), labels


TEMPLATES, CHORD_LABELS = chord_templates()


def estimate_chords(y, sr, duration):
    # Chroma is a signal-based estimate, not a trained polyphonic transcription model.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=2048)
    hop_seconds = 2048 / sr
    window_frames = max(1, int(1.5 / hop_seconds))
    step_frames = max(1, int(0.5 / hop_seconds))
    result = []
    for start in range(0, chroma.shape[1], step_frames):
        end = min(chroma.shape[1], start + window_frames)
        if end <= start:
            continue
        profile = np.mean(chroma[:, start:end], axis=1)
        norm = np.linalg.norm(profile)
        if norm < 1e-6:
            continue
        scores = TEMPLATES @ (profile / norm)
        best = int(np.argmax(scores))
        t0 = start * hop_seconds
        t1 = min(duration, end * hop_seconds)
        if result and result[-1]["chord"] == CHORD_LABELS[best] and t0 - result[-1]["end"] < 0.08:
            result[-1]["end"] = round(t1, 3)
            result[-1]["confidence"] = round(float(max(result[-1]["confidence"], scores[best])), 3)
        else:
            result.append({"start": round(t0, 3), "end": round(t1, 3),
                           "chord": CHORD_LABELS[best], "confidence": round(float(scores[best]), 3)})
    return result


@app.get("/health")
def health():
    return {"ok": True, "engine": "faster-whisper+librosa-chroma", "model": MODEL_SIZE}


@app.post("/analyze")
async def analyze(audio: UploadFile = File(...), authorization: str = Header(default="")):
    expected = os.getenv("LOCAL_AUDIO_ENGINE_TOKEN", "")\n    if not expected or authorization != "Bearer " + expected:\n        raise HTTPException(status_code=401, detail="Unauthorized")\n    suffix = Path(audio.filename or "audio.wav").suffix or ".audio"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            while chunk := await audio.read(1024 * 1024):
                tmp.write(chunk)
        try:
            y, sr = librosa.load(temp_path, sr=22050, mono=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Unsupported or unreadable audio file") from exc
        if y.size == 0:
            raise HTTPException(status_code=400, detail="Audio file is empty")
        duration = float(len(y) / sr)
        model = get_whisper()
        segments, info = model.transcribe(y, language=None, word_timestamps=True, vad_filter=True)
        lines = []
        for segment in segments:
            words = []
            for word in (segment.words or []):
                token = (word.word or "").strip()
                if token:
                    words.append({"text": token, "start": round(float(word.start), 3),
                                  "end": round(float(word.end), 3), "chord": None})
            if words:
                lines.append({"id": f"line-{len(lines)+1}", "section": "unknown", "words": words})
        chords = estimate_chords(y, sr, duration)
        return {"engine": "local-prototype", "title": Path(audio.filename or "").stem,
                "artist": "", "key": "", "bpm": 0, "duration": round(duration, 3),
                "detectedLanguage": getattr(info, "language", "") or "",
                "confidence": 0, "lines": lines, "chords": chords,
                "notice": "Chord labels are estimates and require user review."}
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
