import audio from "audio";

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeLabel(value) {
  const label = String(value || "").trim();
  if (!label || label === "N") return "";
  return label;
}

export async function detectChordsLocally(filePath, operationIdValue, logOperation) {
  const startedAt = Date.now();
  if (typeof logOperation === "function") {
    logOperation(operationIdValue, "chord_detector_started", "מזהה האקורדים המקומי מתחיל ניתוח עצמאי של ההקלטה");
  }

  try {
    const source = await audio(filePath);
    const raw = await source.stat("chords", {
      frameSize: 4096,
      hopSize: 2048,
      method: "nnls"
    });

    const events = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const chord = normalizeLabel(item && (item.label || item.chord));
      if (!chord) continue;

      const start = Math.max(0, Number(item.time) || 0);
      const duration = Math.max(0, Number(item.duration) || 0);
      const end = Math.max(start, start + duration);
      const confidence = clamp01(item && item.confidence);

      const previous = events[events.length - 1];
      if (previous && previous.chord === chord && Math.abs(previous.end - start) < 0.12) {
        previous.end = Math.max(previous.end, end);
        previous._confidenceSum += confidence;
        previous._confidenceCount += 1;
      } else {
        events.push({
          start,
          end,
          chord,
          confidence,
          _confidenceSum: confidence,
          _confidenceCount: 1
        });
      }
    }

    for (const event of events) {
      event.confidence = clamp01(event._confidenceSum / Math.max(1, event._confidenceCount));
      delete event._confidenceSum;
      delete event._confidenceCount;
    }

    if (typeof logOperation === "function") {
      logOperation(
        operationIdValue,
        "chord_detector_completed",
        "מזהה האקורדים המקומי סיים; זוהו " + events.length + " אירועי אקורד בתוך " + (Date.now() - startedAt) + "ms"
      );
    }

    return events;
  } catch (error) {
    if (typeof logOperation === "function") {
      logOperation(
        operationIdValue,
        "chord_detector_failed",
        "מזהה האקורדים המקומי נכשל; ממשיכים עם Gemini בלבד; פירוט: " + String(error && error.message || error).slice(0, 300),
        "error"
      );
    }
    return [];
  }
}
