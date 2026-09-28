import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, ".uploads");
await fs.mkdir(uploadDir, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

const sessions = new Map();
const oauthStates = new Map();
const OAUTH_SCOPES = "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever";
const APP_URL = process.env.APP_URL || "https://chord-studio-frl5.onrender.com";

function cookieToken(req) {
  const raw = String(req.headers.cookie || "");
  const m = raw.match(/(?:^|;\\s*)chord_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
function authSession(req) { return sessions.get(cookieToken(req)) || null; }
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", "chord_session=" + encodeURIComponent(token) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
}
function clearSessionCookie(res) { res.setHeader("Set-Cookie", "chord_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"); }
function requireGoogleOAuth(res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CLOUD_PROJECT) {
    res.status(503).json({ error: "Google OAuth עדיין לא הוגדר בשרת. חסרים GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET או GOOGLE_CLOUD_PROJECT." });
    return false;
  }
  return true;
}


const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 }
});

const MODEL = "gemini-3.8-flash";

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    artist: { type: "string" },
    key: { type: "string" },
    bpm: { type: "number" },
    duration: { type: "number" },
    detectedLanguage: { type: "string" },
    confidence: { type: "number" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          section: { type: "string" },
          words: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
                chord: { type: ["string", "null"] },
                chordOffset: { type: ["integer", "null"] }
              },
              required: ["id", "text", "start", "end", "chord"]
            }
          }
        },
        required: ["id", "section", "words"]
      }
    },
    chords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          chord: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["start", "end", "chord", "confidence"]
      }
    }
  },
  required: ["title", "artist", "key", "bpm", "duration", "detectedLanguage", "confidence", "lines", "chords"]
};

const PRIMARY_PROMPT = [
  "You are the music-analysis engine inside a professional song-to-chords-and-lyrics editor.",
  "Analyze the attached full song audio as precisely as possible.",
  "Return ONLY structured JSON matching the supplied schema.",
  "",
  "Transcribe the lyrics faithfully in the sung language. Do not invent missing words.",
  "For every lyric word provide real start and end seconds on the original audio timeline.",
  "Detect the harmonic chord progression from the music, with start/end seconds for every meaningful chord event.",
  "Prefer standard chord names such as Bb, F#m7, Cmaj7, G/B.",
  "Determine the overall key and BPM when possible.",
  "Preserve section boundaries such as Intro, Verse, Pre-Chorus, Chorus, Bridge and Outro when they can be inferred.",
  "",
  "Critical alignment rule: a lyric word may have a chord anchor only when the chord starts at or very near the start of that sung word. This anchor is used to draw the chord directly above that word.",
  "Re-check every chord change against the actual audio, especially around vocal entrances.",
  "Re-check word timestamps around every chord change.",
  "Never fabricate timestamps. When uncertain, prefer omission over invented content.",
  "Confidence must be a number from 0 to 1."
].join("\\n");

const VERIFY_PREFIX = [
  "You are the second, independent verification pass for a professional chord-and-lyrics extraction system.",
  "The attached audio is the source of truth.",
  "Audit the candidate JSON below and return the COMPLETE corrected object using the supplied schema.",
  "",
  "Correct lyric words or timestamps that do not match the audio.",
  "Correct chord names and chord change times when the audio disagrees.",
  "Keep all events chronological and keep all times inside the song duration.",
  "For a chord-to-word anchor, only use a lyric word when the chord starts at or very near that word's start. When possible, chordOffset should identify the character index inside the word where the harmonic change lands; otherwise use 0.",
  "Do not invent lyrics. If uncertainty remains, omit unsupported content or use the safer less-specific chord.",
  "Candidate JSON:"
].join("\\n");

function cleanAnalysis(value) {
  const data = value && typeof value === "object" ? value : {};
  const duration = Number(data.duration) > 0 ? Number(data.duration) : 0;
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const chords = Array.isArray(data.chords) ? data.chords : [];

  const outLines = lines.map(function(line, i) {
    const words = Array.isArray(line.words) ? line.words : [];
    return {
      id: String(line.id || "line-" + i),
      section: String(line.section || ""),
      words: words.filter(function(w) {
        return String(w && w.text || "").trim();
      }).map(function(w, j) {
        const start = Math.max(0, Number(w.start) || 0);
        const end = Math.max(start, Number(w.end) || start);
        return {
          id: String(w.id || i + "-" + j),
          text: String(w.text || "").trim(),
          start: start,
          end: end,
          chord: w.chord == null ? null : String(w.chord).trim() || null,
            chordOffset: w.chordOffset == null ? null : Math.max(0, Math.floor(Number(w.chordOffset) || 0))
        };
      })
    };
  });

  const outChords = chords.map(function(c) {
    return {
      start: Math.max(0, Number(c.start) || 0),
      end: Math.max(0, Number(c.end) || 0),
      chord: String(c.chord || "").trim(),
      confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0))
    };
  }).filter(function(c) {
    return c.chord;
  }).sort(function(a, b) {
    return a.start - b.start;
  });

  for (let i = 0; i < outChords.length; i += 1) {
    const nextStart = outChords[i + 1] ? outChords[i + 1].start : outChords[i].end;
    if (duration) outChords[i].end = Math.min(duration, Math.max(outChords[i].start, nextStart));
    else outChords[i].end = Math.max(outChords[i].start, outChords[i].end);
  }

  for (const line of outLines) {
    for (const word of line.words) {
      if (word.chord) continue;
      let best = null;
      for (const chord of outChords) {
        const distance = Math.abs(chord.start - word.start);
        if (!best || distance < best.distance) best = { chord: chord, distance: distance };
      }
      if (best && best.distance <= 0.85) word.chord = best.chord.chord;
    }
  }

  return {
    title: String(data.title || ""),
    artist: String(data.artist || ""),
    key: String(data.key || ""),
    bpm: Number(data.bpm) || 0,
    duration: duration,
    detectedLanguage: String(data.detectedLanguage || ""),
    confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
    lines: outLines,
    chords: outChords
  };
}

async function analyzeWithGemini(ai, fileUri, mimeType, prompt) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: prompt },
        { fileData: { fileUri: fileUri, mimeType: mimeType } }
      ]
    }],
    config: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: "high" }
    }
  });
  if (!response.text) throw new Error("Gemini returned an empty response");
  return JSON.parse(response.text);
}

app.get("/api/health", function(_req, res) {
  res.json({
    ok: true,
    model: MODEL,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.post("/api/analyze", upload.single("audio"), async function(req, res) {
  let uploadedName = null;
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: "חסר GEMINI_API_KEY ב־Render. הוסף אותו ב־Environment Variables."
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: "לא התקבל קובץ אודיו" });
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  try {
    const uploaded = await ai.files.upload({
      file: req.file.path,
      config: { mimeType: req.file.mimetype || "audio/mpeg" }
    });
    uploadedName = uploaded.name;

    const first = cleanAnalysis(
      await analyzeWithGemini(ai, uploaded.uri, uploaded.mimeType || req.file.mimetype, PRIMARY_PROMPT)
    );

    const verified = cleanAnalysis(
      await analyzeWithGemini(
        ai,
        uploaded.uri,
        uploaded.mimeType || req.file.mimetype,
        VERIFY_PREFIX + "\\n" + JSON.stringify(first)
      )
    );

    res.json(verified);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error && error.message ? "Gemini: " + error.message : "ניתוח השיר נכשל"
    });
  } finally {
    try { await fs.unlink(req.file.path); } catch {}
    try {
      if (uploadedName && ai.files && ai.files.delete) {
        await ai.files.delete({ name: uploadedName });
      }
    } catch {}
  }
});

const NOTES_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTES_FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const NOTE_INDEX = {
  C:0,"C#":1,Db:1,D:2,"D#":3,Eb:3,E:4,F:5,"F#":6,Gb:6,
  G:7,"G#":8,Ab:8,A:9,"A#":10,Bb:10,B:11
};

function transposeChord(chord, shift) {
  const raw = String(chord || "");
  const mainParts = raw.split("/");
  const rootMatch = mainParts[0].match(/^([A-G](?:#|b)?)(.*)$/);
  if (!rootMatch || NOTE_INDEX[rootMatch[1]] == null) return raw;
  const preferFlat = shift < 0;
  const notes = preferFlat ? NOTES_FLAT : NOTES_SHARP;
  const result = notes[((NOTE_INDEX[rootMatch[1]] + shift) % 12 + 12) % 12] + rootMatch[2];
  if (mainParts[1]) {
    const bassMatch = mainParts[1].match(/^([A-G](?:#|b)?)(.*)$/);
    if (bassMatch && NOTE_INDEX[bassMatch[1]] != null) {
      return result + "/" + notes[((NOTE_INDEX[bassMatch[1]] + shift) % 12 + 12) % 12] + bassMatch[2];
    }
  }
  return result;
}

function simplifyChord(chord, mode) {
  const raw = String(chord || "");
  if (!raw || mode === "off" || mode === "advanced") return raw;
  const slashIndex = raw.indexOf("/");
  const main = slashIndex > 0 ? raw.slice(0, slashIndex) : raw;
  const bass = slashIndex > 0 ? raw.slice(slashIndex + 1) : "";
  const m = main.match(/^([A-G](?:#|b)?)(.*)$/);
  if (!m) return raw;
  let suffix = m[2];
  if (mode === "simple") {
    suffix = /^m/i.test(suffix) ? "m" : "";
    return m[1] + suffix;
  }
  if (/^(maj7|maj9|maj11|maj13|M7|M9|M11|M13|7|9|11|13|add9|add11)$/i.test(suffix)) suffix = "";
  if (/^m(?:7|9|11|13)$/i.test(suffix) || /^min(?:7|9|11|13)?$/i.test(suffix)) suffix = "m";
  if (/^(dim7?|°7?|aug|\\+)$/i.test(suffix)) suffix = "";
  return m[1] + suffix + (bass ? "/" + bass : "");
}

function transformChord(chord, shift, mode) {
  const shifted = transposeChord(chord, shift);
  return mode === "off" || mode === "advanced" ? shifted : simplifyChord(shifted, mode);
}

function lineWordsForExport(line, shift, mode) {
  return (line.words || []).map(function(word) {
    return {
      text: word.text,
      chord: word.chord ? transformChord(word.chord, shift, mode) : ""
    };
  });
}

function noBorders() {
  const side = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  return { top: side, bottom: side, left: side, right: side };
}

function makeWordTable(words) {
  const chordCells = words.map(function(w) {
    return new TableCell({
      width: { size: Math.max(700, w.text.length * 450), type: WidthType.DXA },
      borders: noBorders(),
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: w.chord || "", font: "Arial", bold: true, size: 18, color: "2A8D88" })]
        })
      ]
    });
  });

  const wordCells = words.map(function(w) {
    return new TableCell({
      width: { size: Math.max(700, w.text.length * 450), type: WidthType.DXA },
      borders: noBorders(),
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: w.text + " ", font: "Arial", size: 24, color: "182433" })]
        })
      ]
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorders(),
    rows: [
      new TableRow({ children: chordCells }),
      new TableRow({ children: wordCells })
    ]
  });
}

app.post("/api/export/docx", async function(req, res) {
  try {
    const payload = req.body || {};
    const analysis = payload.analysis;
    const shift = Math.max(-12, Math.min(12, Number(payload.shift) || 0));
    const mode = payload.simplify || "off";
    if (!analysis) return res.status(400).json({ error: "חסר נתון ניתוח" });

    const key = analysis.key ? transposeChord(analysis.key, shift) : "—";
    const children = [];

    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: analysis.title || "דף אקורדים", font: "Arial", bold: true, size: 34, color: "102238" })]
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({
        text: (analysis.artist || "אמן לא זוהה") + " · סולם " + key + (analysis.bpm ? " · " + Math.round(analysis.bpm) + " BPM" : ""),
        font: "Arial", size: 17, color: "667589"
      })]
    }));

    for (const line of analysis.lines || []) {
      if (line.section) {
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: line.section, font: "Arial", bold: true, size: 14, color: "6A839B" })]
        }));
      }
      children.push(makeWordTable(lineWordsForExport(line, shift, mode)));
    }

    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ text: "נוצר באמצעות Chord Studio · Gemini 3.8 Flash", font: "Arial", size: 10, color: "8493A4" })]
    }));

    const doc = new Document({
      sections: [{
        properties: {
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } }
        },
        children: children
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    const safe = String(analysis.title || "song").replace(/[\\\\/:*?"<>|]/g, "_") + ".docx";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(safe));
    res.send(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "יצירת מסמך Word נכשלה" });
  }
});

app.use(express.static(publicDir));

const port = Number(process.env.PORT || 10000);
app.listen(port, "0.0.0.0", function() {
  console.log("Chord Studio listening on " + port);
});
