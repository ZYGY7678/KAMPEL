import audio from "audio";

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeLabel(value) {
  const label = String(value || "").trim();
  if (!label || label === "N" || /^no[-_ ]?chord$/i.test(label)) return "";
  return label;
}

function normalizeEvents(raw, detectorWeight) {
  const events = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const chord = normalizeLabel(item && (item.label || item.chord));
    if (!chord) continue;

    const start = Math.max(0, Number(item.time) || Number(item.start) || 0);
    const duration = Math.max(0, Number(item.duration) || 0);
    const end = Math.max(start, start + duration);
    if (end <= start + 0.015) continue;

    const confidence = clamp01(item && item.confidence);
    events.push({ start, end, chord, confidence, weight: detectorWeight });
  }
  return events;
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function clampTime(value, duration) {
  const t = Math.max(0, Number(value) || 0);
  return duration > 0 ? Math.min(duration, t) : t;
}

function mergeAdjacent(events) {
  const out = [];
  for (const event of events) {
    if (!event || !event.chord || event.end <= event.start + 0.015) continue;
    const prev = out[out.length - 1];
    if (prev && prev.chord === event.chord && event.start <= prev.end + 0.06) {
      const prevLen = Math.max(0.001, prev.end - prev.start);
      const nextLen = Math.max(0.001, event.end - event.start);
      prev.end = Math.max(prev.end, event.end);
      prev.confidence = clamp01((prev.confidence * prevLen + event.confidence * nextLen) / (prevLen + nextLen));
    } else {
      out.push({ ...event });
    }
  }
  return out;
}

function stabiliseShortEvents(events) {
  if (events.length < 3) return events;
  const out = events.map(e => ({ ...e }));
  for (let i = 0; i < out.length; i += 1) {
    const current = out[i];
    const duration = current.end - current.start;
    if (duration >= 0.18) continue;

    const prev = out[i - 1];
    const next = out[i + 1];

    if (prev && next && prev.chord === next.chord) {
      prev.end = next.end;
      prev.confidence = Math.max(prev.confidence, current.confidence * 0.92);
      out.splice(i, 2);
      i -= 1;
      continue;
    }

    if (prev && (!next || prev.confidence >= next.confidence)) {
      prev.end = Math.max(prev.end, current.end);
      out.splice(i, 1);
      i -= 1;
      continue;
    }

    if (next) {
      next.start = Math.min(next.start, current.start);
      out.splice(i, 1);
      i -= 1;
    }
  }
  return mergeAdjacent(out);
}

function fuseDetectors(detectors, duration) {
  const boundaries = new Set([0]);
  const activeDetectors = detectors.filter(d => d.events.length);

  for (const detector of activeDetectors) {
    for (const event of detector.events) {
      boundaries.add(clampTime(event.start, duration));
      boundaries.add(clampTime(event.end, duration));
    }
  }
  if (duration > 0) boundaries.add(duration);

  const sorted = Array.from(boundaries)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const fused = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start + 0.015) continue;

    const candidates = new Map();

    for (const detector of activeDetectors) {
      let bestForDetector = null;
      let bestOverlap = 0;

      for (const event of detector.events) {
        if (event.end <= start || event.start >= end) continue;
        const ov = overlap(start, end, event.start, event.end);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          bestForDetector = event;
        }
      }

      if (!bestForDetector || bestOverlap <= 0) continue;

      const coverage = Math.min(1, bestOverlap / Math.max(0.001, end - start));
      const contribution = detector.weight * clamp01(bestForDetector.confidence) * (0.45 + 0.55 * coverage);
      const item = candidates.get(bestForDetector.chord) || {
        score: 0,
        supportWeight: 0,
        confidenceWeighted: 0,
        detectorCount: 0
      };
      item.score += contribution;
      item.supportWeight += detector.weight * coverage;
      item.confidenceWeighted += detector.weight * coverage * clamp01(bestForDetector.confidence);
      item.detectorCount += 1;
      candidates.set(bestForDetector.chord, item);
    }

    if (!candidates.size) continue;

    const ranked = Array.from(candidates.entries()).sort((a, b) => b[1].score - a[1].score);
    const [chord, winner] = ranked[0];
    const totalWeight = activeDetectors.reduce((sum, d) => sum + d.weight, 0);
    const agreement = totalWeight ? winner.supportWeight / totalWeight : 0;
    const meanConfidence = winner.supportWeight ? winner.confidenceWeighted / winner.supportWeight : 0;

    fused.push({
      start,
      end,
      chord,
      confidence: clamp01(meanConfidence * 0.60 + agreement * 0.40),
      agreement,
      detectorCount: winner.detectorCount
    });
  }

  let result = mergeAdjacent(fused);
  result = stabiliseShortEvents(result);

  // Do one last duration clamp and remove impossible/duplicate tails.
  result = result
    .map(event => ({
      start: clampTime(event.start, duration),
      end: clampTime(Math.max(event.start, event.end), duration),
      chord: event.chord,
      confidence: clamp01(event.confidence)
    }))
    .filter(event => event.chord && event.end > event.start + 0.015);

  for (let i = 0; i < result.length; i += 1) {
    const next = result[i + 1];
    if (next) result[i].end = Math.max(result[i].start, Math.min(result[i].end, next.start));
    else if (duration > 0) result[i].end = Math.min(duration, result[i].end);
  }

  return mergeAdjacent(result);
}

async function runStat(source, opts, weight, label, operationIdValue, logOperation) {
  const startedAt = Date.now();
  try {
    const raw = await source.stat("chords", opts);
    const events = normalizeEvents(raw, weight);
    if (typeof logOperation === "function") {
      logOperation(
        operationIdValue,
        "chord_pass_completed",
        label + " סיים ניתוח: " + events.length + " אירועי אקורד (" + (Date.now() - startedAt) + "ms)"
      );
    }
    return { label, weight, events };
  } catch (error) {
    if (typeof logOperation === "function") {
      logOperation(
        operationIdValue,
        "chord_pass_failed",
        label + " נכשל; עוברים לשאר המסלולים: " + String(error && error.message || error).slice(0, 280),
        "warning"
      );
    }
    return { label, weight, events: [] };
  }
}

export async function detectChordsLocally(filePath, operationIdValue, logOperation) {
  const startedAt = Date.now();
  if (typeof logOperation === "function") {
    logOperation(
      operationIdValue,
      "chord_detector_started",
      "מנוע האקורדים בשרת מתחיל ניתוח רב-מעברי של ההקלטה (NNLS + PCP ברזולוציות שונות)"
    );
  }

  try {
    const source = await audio(filePath);

    // Three independent passes intentionally use different temporal resolutions/methods.
    // NNLS is the primary pass for polyphonic mixtures; PCP is a complementary representation.
    const passes = await Promise.all([
      runStat(source, { frameSize: 8192, hopSize: 1024, method: "nnls" }, 1.00, "NNLS מדויק", operationIdValue, logOperation),
      runStat(source, { frameSize: 4096, hopSize: 512, method: "nnls" }, 0.88, "NNLS מהיר", operationIdValue, logOperation),
      runStat(source, { frameSize: 8192, hopSize: 1024, method: "pcp" }, 0.62, "PCP מאמת", operationIdValue, logOperation)
    ]);

    let duration = 0;
    try {
      const metadata = await source.stat(["duration"]);
      if (Array.isArray(metadata)) duration = Number(metadata[0]) || 0;
      else duration = Number(metadata) || 0;
    } catch {
      duration = Math.max(0, ...passes.flatMap(p => p.events.map(e => e.end)));
    }

    const usable = passes.filter(p => p.events.length);
    if (!usable.length) {
      throw new Error("אף אחד ממעברי זיהוי האקורדים לא החזיר תוצאה");
    }

    const events = fuseDetectors(usable, duration);
    if (!events.length) {
      throw new Error("מנוע האקורדים לא הצליח לבנות רצף יציב מהמעברים");
    }

    if (typeof logOperation === "function") {
      const agreement = events.reduce((sum, e) => sum + (Number(e.confidence) || 0), 0) / events.length;
      logOperation(
        operationIdValue,
        "chord_detector_completed",
        "מנוע האקורדים בשרת סיים שילוב רב-מעברי: " + events.length + " אירועים, דיוק פנימי משולב " + Math.round(clamp01(agreement) * 100) + "%, זמן כולל " + (Date.now() - startedAt) + "ms",
        "success"
      );
    }

    return events;
  } catch (error) {
    if (typeof logOperation === "function") {
      logOperation(
        operationIdValue,
        "chord_detector_failed",
        "מנוע האקורדים בשרת נכשל; פירוט: " + String(error && error.message || error).slice(0, 350),
        "error"
      );
    }
    return [];
  }
}
