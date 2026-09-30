"""Chord Studio's independent Chordino audio-analysis service.

This service intentionally performs chord extraction only. Lyrics and word timing
are handled by Gemini in the Node application; the final Gemini pass reconciles
the transcript with this independent Chordino timeline.
"""
import asyncio
import csv
import io
import os
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, UploadFile

app = FastAPI(title="Chord Studio Chordino Engine", version="1.0.0")

SONIC_ANNOTATOR_BIN = os.getenv("SONIC_ANNOTATOR_BIN", "/usr/local/bin/sonic-annotator")
VAMP_PATH = os.getenv("VAMP_PATH", "/opt/vamp")
CHORDINO_TRANSFORM = os.getenv(
    "CHORDINO_TRANSFORM",
    "vamp:nnls-chroma:chordino:simplechord",
)
CHORDINO_TIMEOUT_SECONDS = max(
    30, int(os.getenv("CHORDINO_TIMEOUT_SECONDS", "180"))
)
CHORDINO_CONCURRENCY = max(
    1, int(os.getenv("CHORDINO_CONCURRENCY", "1"))
)
CHORDINO_SEMAPHORE = asyncio.Semaphore(CHORDINO_CONCURRENCY)


def _ffprobe_duration(path: str) -> float:
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        value = float((completed.stdout or "").strip())
        return max(0.0, value)
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def _run_chordino(path: str, duration: float) -> list[dict]:
    if not os.path.isfile(SONIC_ANNOTATOR_BIN):
        raise RuntimeError("Sonic Annotator binary is missing")
    if not os.path.isdir(VAMP_PATH):
        raise RuntimeError("Chordino Vamp plugin directory is missing")

    command = [
        SONIC_ANNOTATOR_BIN,
        "-d",
        CHORDINO_TRANSFORM,
        path,
        "-w",
        "csv",
        "--csv-stdout",
        "--csv-end-times",
        "--csv-fill-ends",
        "--csv-omit-filename",
    ]
    env = os.environ.copy()
    env["VAMP_PATH"] = VAMP_PATH

    try:
        completed = subprocess.run(
            command,
            env=env,
            capture_output=True,
            text=True,
            timeout=CHORDINO_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(
            f"Chordino exceeded {CHORDINO_TIMEOUT_SECONDS} seconds"
        ) from exc
    except OSError as exc:
        raise RuntimeError(f"Could not execute Sonic Annotator: {exc}") from exc

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip().replace("\n", " ")
        raise RuntimeError(
            "Sonic Annotator/Chordino failed"
            + (f": {stderr[-800:]}" if stderr else "")
        )

    events: list[dict] = []
    for row in csv.reader(io.StringIO(completed.stdout or "")):
        if len(row) < 3:
            continue

        # Sonic Annotator versions differ on whether the CSV writer accepts
        # --csv-omit-filename. Handle both forms so an unexpected filename
        # column never makes us silently discard the whole chord timeline.
        offset = 0
        try:
            float(row[0])
        except (TypeError, ValueError):
            offset = 1

        if len(row) < offset + 3:
            continue
        try:
            start = float(row[offset])
        except (TypeError, ValueError):
            continue
        try:
            end = float(row[offset + 1])
        except (TypeError, ValueError):
            end = 0.0
        label = str(row[-1] or "").strip()
        if not label:
            continue
        start = max(0.0, start)
        end = max(start, end)
        if duration > 0:
            start = min(start, duration)
            end = min(max(start, end), duration)
        events.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "chord": label,
            }
        )

    events.sort(key=lambda item: (item["start"], item["end"]))
    if not events:
        raise RuntimeError("Chordino returned no chord events")

    if duration > 0 and events[-1]["end"] <= events[-1]["start"]:
        events[-1]["end"] = round(duration, 3)

    # Smooth brief recognition flicker, then merge adjacent identical labels.
    min_event = max(0.10, float(os.getenv("CHORDINO_MIN_EVENT_SECONDS", "0.30")))
    merge_gap = max(0.0, float(os.getenv("CHORDINO_MERGE_GAP_SECONDS", "0.12")))
    smoothed = events[:]
    changed = True
    while changed and len(smoothed) > 1:
        changed = False
        for index, event in enumerate(smoothed):
            if event["end"] - event["start"] >= min_event:
                continue
            left = smoothed[index - 1] if index > 0 else None
            right = smoothed[index + 1] if index + 1 < len(smoothed) else None
            if left and right and left["chord"] == right["chord"]:
                left["end"] = max(left["end"], right["end"], event["end"])
                smoothed.pop(index + 1)
                smoothed.pop(index)
            elif left and right:
                target = left if (left["end"] - left["start"]) >= (right["end"] - right["start"]) else right
                target["end"] = max(target["end"], event["end"]) if target is left else target["end"]
                if target is right:
                    target["start"] = min(target["start"], event["start"])
                smoothed.pop(index)
            elif left:
                left["end"] = max(left["end"], event["end"])
                smoothed.pop(index)
            elif right:
                right["start"] = min(right["start"], event["start"])
                smoothed.pop(index)
            else:
                continue
            changed = True
            break

    merged: list[dict] = []
    for event in smoothed:
        if (
            merged
            and merged[-1]["chord"] == event["chord"]
            and event["start"] <= merged[-1]["end"] + merge_gap
        ):
            merged[-1]["end"] = max(merged[-1]["end"], event["end"])
        else:
            merged.append(event)

    # Make timeline boundaries explicit and continuous; use the midpoint for
    # overlapping detections and preserve the detector's start/end estimates.
    for index in range(len(merged) - 1):
        current, following = merged[index], merged[index + 1]
        boundary = round((current["end"] + following["start"]) / 2, 3)
        if following["start"] < current["end"]:
            current["end"] = boundary
            following["start"] = boundary
        elif following["start"] - current["end"] <= merge_gap:
            current["end"] = following["start"]
    if duration > 0:
        merged[0]["start"] = min(merged[0]["start"], 0.0)
        merged[-1]["end"] = round(duration, 3)
    return [event for event in merged if event["end"] - event["start"] >= 0.05]


def health_payload() -> dict:
    return {
        "ok": True,
        "engine": "sonic-annotator+chordino",
        "transform": CHORDINO_TRANSFORM,
        "chordinoConfigured": os.path.isfile(SONIC_ANNOTATOR_BIN)
        and os.path.isdir(VAMP_PATH),
    }


@app.get("/health")
def health():
    return health_payload()


@app.post("/analyze")
async def analyze(
    audio: UploadFile = File(...),
    authorization: str = Header(default=""),
):
    expected = os.getenv("LOCAL_AUDIO_ENGINE_TOKEN", "")
    if not expected or authorization != "Bearer " + expected:
        raise HTTPException(status_code=401, detail="Unauthorized")

    suffix = Path(audio.filename or "audio.wav").suffix or ".audio"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            temp_path = tmp.name
            while chunk := await audio.read(1024 * 1024):
                tmp.write(chunk)

        stat = os.stat(temp_path)
        if stat.st_size <= 0:
            raise HTTPException(status_code=400, detail="Audio file is empty")

        duration = _ffprobe_duration(temp_path)
        async with CHORDINO_SEMAPHORE:
            try:
                chords = await asyncio.to_thread(
                    _run_chordino, temp_path, duration
                )
            except TimeoutError as exc:
                raise HTTPException(status_code=504, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from exc

        return {
            "engine": "sonic-annotator+chordino",
            "source": "Chordino",
            "transform": CHORDINO_TRANSFORM,
            "duration": round(duration, 3),
            "chords": chords,
        }
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
