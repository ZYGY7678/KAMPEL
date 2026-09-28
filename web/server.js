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

const operations = new Map();
const pendingVerifications = new Map();
function operationId(req) { return String(req.headers["x-operation-id"] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80); }
function logOperation(id, stage, message, level) {
 if (!id) return;
 const entry={time:new Date().toISOString(),stage,message,level:level||"info"};
 const list=operations.get(id)||[];list.push(entry);if(list.length>100)list.shift();operations.set(id,list);
 (level==="error"?console.error:console.info)("APP_OPERATION",JSON.stringify({operationId:id,...entry}));
}
const sessions = new Map();
const oauthStates = new Map();
const OAUTH_SCOPES = "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever";
const GEMINI_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever"
];
const APP_URL = process.env.APP_URL || "https://chord-studio-frl5.onrender.com";

function cookieToken(req) {
  const raw = String(req.headers.cookie || "");
  const m = raw.match(/(?:^|;\s*)chord_session=([^;]+)/);
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

const MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const MODEL = MODELS[0];
const INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024; // keep encoded request safely below Gemini audio inline request limit

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
                chord: { type: "string", nullable: true },
                chordOffset: { type: "integer", nullable: true }
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
    auth: "google-oauth",
    googleOAuthConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CLOUD_PROJECT)
  });
});

app.get("/auth/google", function(_req, res) {
  if (!requireGoogleOAuth(res)) return;
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: APP_URL + "/auth/google/callback",
    response_type: "code",
    scope: OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params.toString());
});

app.get("/auth/google/callback", async function(req, res) {
  const state = String(req.query.state || "");
  const code = String(req.query.code || "");
  const created = oauthStates.get(state);
  oauthStates.delete(state);
  if (!created || Date.now() - created > 10 * 60 * 1000 || !code) return res.status(400).send("Google authentication state expired or invalid");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: APP_URL + "/auth/google/callback",
        grant_type: "authorization_code"
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error_description || "Google token exchange failed");
    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + tokens.access_token }
    });
    const user = await userRes.json();
    if (!userRes.ok) throw new Error("Google user info failed");
    const sessionId = crypto.randomBytes(32).toString("hex");
    const grantedScopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);
    sessions.set(sessionId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      grantedScopes,
      user: { name: user.name || user.email || "Google user", email: user.email || "", picture: user.picture || "" }
    });
    setSessionCookie(res, sessionId);
    res.redirect("/");
  } catch (error) {
    console.error(error);
    res.status(500).send("Google authentication failed");
  }
});

app.get("/api/auth/me", function(req, res) {
  const session = authSession(req);
  if (!session) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    user: session.user,
    geminiScopeGranted: Array.isArray(session.grantedScopes) && GEMINI_REQUIRED_SCOPES.every(function(scope) { return session.grantedScopes.includes(scope); })
  });
});

app.post("/api/auth/logout", function(req, res) {
  const token = cookieToken(req);
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

async function refreshGoogleSession(session) {
  if (!session.refreshToken || session.expiresAt > Date.now() + 60000) return session;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: session.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error_description || "Google token refresh failed");
  session.accessToken = tokens.access_token;
  session.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  return session;
}

async function geminiFetch(session, url, options) {
  await refreshGoogleSession(session);
  if (!Array.isArray(session.grantedScopes) || !GEMINI_REQUIRED_SCOPES.every(function(scope) { return session.grantedScopes.includes(scope); })) {
    const error = new Error("Google authorization is missing the Gemini API cloud-platform scope. Please sign in with Google again and grant the requested Gemini permission.");
    error.code = "INSUFFICIENT_SCOPE";
    throw error;
  }
  const headers = Object.assign({}, options && options.headers || {}, {
    Authorization: "Bearer " + session.accessToken,
    "x-goog-user-project": process.env.GOOGLE_CLOUD_PROJECT
  });
  let response = await fetch(url, Object.assign({}, options || {}, { headers }));
  if (response.status === 401 && session.refreshToken) {
    session.expiresAt = 0;
    await refreshGoogleSession(session);
    headers.Authorization = "Bearer " + session.accessToken;
    response = await fetch(url, Object.assign({}, options || {}, { headers }));
  }
  return response;
}

async function geminiPreflight(session) {
  const response = await geminiFetch(
    session,
    "https://generativelanguage.googleapis.com/v1/models",
    { method: "GET" }
  );
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  const error = data && data.error ? data.error : null;
  const result = {
    ok: response.ok,
    status: response.status,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    scopes: Array.isArray(session.grantedScopes) ? session.grantedScopes.slice() : [],
    errorCode: error && error.code ? error.code : null,
    errorStatus: error && error.status ? error.status : null,
    errorMessage: error && error.message ? error.message : null
  };
  console.info("Gemini preflight", JSON.stringify(result));
  if (!response.ok) {
    const e = new Error(error && error.message ? error.message : "Gemini API preflight failed");
    e.geminiStatus = response.status;
    e.geminiCode = error && error.status ? error.status : "";
    throw e;
  }
  return data;
}

async function geminiModelPreflight(session, modelName) {
  const checkedModel = modelName || MODEL;
  const encodedModel = encodeURIComponent(checkedModel);
  const response = await geminiFetch(
    session,
    "https://generativelanguage.googleapis.com/v1beta/models/" + encodedModel,
    { method: "GET" }
  );
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  const error = data && data.error ? data.error : null;
  const result = {
    ok: response.ok,
    status: response.status,
    model: checkedModel,
    errorCode: error && error.code ? error.code : null,
    errorStatus: error && error.status ? error.status : null,
    errorMessage: error && error.message ? error.message : null
  };
  console.info("Gemini model preflight", JSON.stringify(result));
  if (!response.ok) {
    const e = new Error(error && error.message ? error.message : "Gemini model preflight failed");
    e.geminiStatus = response.status;
    e.geminiCode = error && error.status ? error.status : "";
    e.geminiApiCode = error && error.code ? error.code : null;
    throw e;
  }
  return data;
}

async function uploadGeminiFile(session, filePath, mimeType, displayName) {
  const stat = await fs.stat(filePath);
  const start = await geminiFetch(session, "https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(stat.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: displayName } })
  });
  if (!start.ok) throw new Error("Gemini file upload start failed: " + await start.text());
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return an upload URL");
  const bytes = await fs.readFile(filePath);
  const finish = await geminiFetch(session, uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: bytes
  });
  const data = await finish.json();
  if (!finish.ok || !data.file) throw new Error("Gemini file upload failed: " + JSON.stringify(data));
  return data.file;
}

async function analyzeWithGeminiApiKey(apiKey, audioBase64, mimeType, prompt, model) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audioBase64 } }] }], generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: "high" } } })
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error && data.error.message || "Gemini generation failed");
    error.geminiStatus = response.status; error.geminiCode = data.error && data.error.status || "";
    error.geminiApiCode = data.error && data.error.code || null;
    error.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0;
    throw error;
  }
  const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts ? data.candidates[0].content.parts.map(function(p){return p.text||"";}).join("") : "";
  if (!text) throw new Error("Gemini returned an empty response");
  return JSON.parse(text);
}

async function analyzeWithGeminiOAuthInline(session, audioBase64, mimeType, prompt, model) {
  const response = await geminiFetch(session, "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: audioBase64 } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        thinkingConfig: { thinkingLevel: "high" }
      }
    })
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error && data.error.message || "Gemini generation failed");
    error.geminiStatus = response.status;
    error.geminiCode = data.error && data.error.status || "";
    error.geminiApiCode = data.error && data.error.code || null;
    const retryAfter = Number(response.headers.get("retry-after"));
    error.retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : 0;
    throw error;
  }
  const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
    ? data.candidates[0].content.parts.map(function(p) { return p.text || ""; }).join("")
    : "";
  if (!text) throw new Error("Gemini returned an empty response");
  return JSON.parse(text);
}

async function analyzeWithGeminiRetry(session, audioBase64, mimeType, prompt, operationId, stage, apiKey) {
  const delays = [2000, 5000, 10000];
  let lastError = null;
  for (let modelIndex = 0; modelIndex < MODELS.length; modelIndex += 1) {
    const model = MODELS[modelIndex];
    for (let attempt = 0; ; attempt += 1) {
      try {
        logOperation(operationId, stage + "_model", "מנסה ניתוח באמצעות " + model + " (" + (modelIndex + 1) + " מתוך " + MODELS.length + ")");
        return await (apiKey ? analyzeWithGeminiApiKey(apiKey, audioBase64, mimeType, prompt, model) : analyzeWithGeminiOAuthInline(session, audioBase64, mimeType, prompt, model));
      } catch (error) {
        lastError = error;
        const message = String(error && error.message || error);
        const status = Number(error && error.geminiStatus) || null;
        const apiCode = String(error && error.geminiCode || "");
        logOperation(operationId, stage + "_api_error", JSON.stringify({model:model,status:status,apiCode:apiCode,message:message.slice(0,500)}), "error");
        const unavailableModel = status === 404 || apiCode === "NOT_FOUND";
        if (unavailableModel && modelIndex < MODELS.length - 1) {
          logOperation(operationId, stage + "_fallback", model + " לא נמצא או אינו זמין (HTTP " + status + "); עובר למודל הבא", "warn");
          break;
        }
        const retryable = status === 429 || status === 503 || apiCode === "RESOURCE_EXHAUSTED" || apiCode === "UNAVAILABLE" || /high demand|resource[_ ]exhausted|temporarily unavailable|try again later|overloaded/i.test(message);
        if (!retryable) throw error;
        // Respect Google's Retry-After / retryDelay instead of retrying on a fixed,
        // shorter schedule. Google may return either HTTP Retry-After or a delay
        // embedded in the human-readable error message.
        const retryAfterHeader = Number(error.retryAfterSeconds) || 0;
        const messageDelay = message.match(/retry in\\s+([0-9]+(?:\\.[0-9]+)?)\\s*s/i);
        const googleDelayMs = Math.max(retryAfterHeader * 1000, messageDelay ? Number(messageDelay[1]) * 1000 : 0);
        const isQuotaExhausted = apiCode === "RESOURCE_EXHAUSTED" || /quota exceeded|generate_content_free_tier_requests/i.test(message);
        if (attempt < delays.length) {
          const wait = Math.max(googleDelayMs, isQuotaExhausted ? 60000 : delays[attempt]);
          logOperation(operationId, stage + "_retry", model + " החזיר שגיאה זמנית (HTTP " + (status || "לא ידוע") + ", " + (apiCode || "ללא קוד") + "); ממתין " + Math.ceil(wait / 1000) + " שניות לפי מגבלת Google לפני ניסיון חוזר " + (attempt + 1) + " מתוך " + delays.length);
          await new Promise(function(resolve) { setTimeout(resolve, wait); });
          continue;
        }
        if (modelIndex < MODELS.length - 1) {
          logOperation(operationId, stage + "_fallback", model + " עדיין לא זמין; עובר למודל הבא");
          break;
        }
        throw lastError;
      }
    }
  }
  throw lastError || new Error("All Gemini models failed");
}

app.get("/api/gemini-diagnostic", async function(req, res) {
  const session = authSession(req);
  if (!session) return res.status(401).json({ error: "יש להתחבר עם Google לפני בדיקת Gemini." });
  if (!requireGoogleOAuth(res)) return;
  try {
    const models = await geminiPreflight(session);
    const modelChecks = await Promise.all(MODELS.map(async function(modelName) {
      try {
        const info = await geminiModelPreflight(session, modelName);
        return { model: modelName, ok: true, name: info && info.name || null, methods: info && info.supportedGenerationMethods || [] };
      } catch (error) {
        return { model: modelName, ok: false, status: error.geminiStatus || null, apiCode: error.geminiApiCode || error.geminiCode || null, error: String(error.message || error).slice(0, 400) };
      }
    }));
    res.json({
      ok: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      scopes: Array.isArray(session.grantedScopes) ? session.grantedScopes.slice() : [],
      model: MODEL,
      fallbackModels: MODELS,
      modelChecks: modelChecks,
      modelListCount: models && Array.isArray(models.models) ? models.models.length : null,
      listedModels: models && Array.isArray(models.models) ? models.models.map(function(item) { return item.name; }).filter(Boolean) : []
    });
  } catch (error) {
    console.error("Gemini diagnostic failed", error);
    res.status(502).json({
      ok: false,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      model: MODEL,
      status: error && error.geminiStatus ? error.geminiStatus : null,
      code: error && error.geminiCode ? error.geminiCode : null,
      apiCode: error && error.geminiApiCode ? error.geminiApiCode : null,
      error: error && error.message ? error.message : "Gemini diagnostic failed"
    });
  }
});

app.post("/api/verify/:id",async function(req,res){
  const session=authSession(req);
  const id=String(req.params.id||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80);
  const pending=pendingVerifications.get(id);
  if(!pending)return res.status(404).json({error:"לא נמצאה תוצאת ניתוח זמינה לאימות. הרץ ניתוח ראשוני מחדש."});
  if(!session&&!pending.apiKey)return res.status(401).json({error:"יש להתחבר מחדש כדי לאמת את השיר."});
  try{
    logOperation(id,"analysis_verify","האימות הנוסף התחיל לפי בקשת המשתמש");
    const verified=cleanAnalysis(await analyzeWithGeminiRetry(session,pending.audioBase64,pending.mimeType,VERIFY_PREFIX+"\\n"+JSON.stringify(pending.first),id,"analysis_verify",pending.apiKey));
    pendingVerifications.delete(id);
    logOperation(id,"verification_completed","האימות הסתיים; התוצאה המעודכנת מוכנה","success");
    res.json({analysis:verified,verified:true});
  }catch(error){
    logOperation(id,"verification_failed","האימות לא הושלם: "+String(error&&error.message||error).slice(0,350),"error");
    res.status(502).json({error:"האימות הנוסף נכשל, אך הניתוח הראשוני נשמר. "+String(error&&error.message||error),verificationFailed:true});
  }
});

app.get("/api/operations/:id",function(req,res){
 const id=String(req.params.id||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80);
 if(!authSession(req))return res.status(401).json({error:"לא מחובר"});
 res.setHeader("Cache-Control","no-store");res.json({operationId:id,events:operations.get(id)||[]});
});
app.post("/api/analyze",function(req,res,next){req.operationId=operationId(req);logOperation(req.operationId,"upload_receiving","השרת התחיל לקבל את קובץ האודיו");next();},upload.single("audio"),async function(req,res){
  const session = authSession(req);
  const apiKey = String(req.headers["x-gemini-api-key"] || "").trim();
  if (!session && !apiKey) return res.status(401).json({ error: "יש להתחבר עם Google או להזין מפתח Gemini API לפני ניתוח שיר." });
  if (!apiKey && !requireGoogleOAuth(res)) return;
  if (!req.file) {
    logOperation(req.operationId,"upload_failed","השרת לא קיבל קובץ בשדה audio","error");
    console.warn("Audio upload missing: multer did not receive field audio");
    return res.status(400).json({ error: "לא התקבל קובץ אודיו. נסה לבחור את הקובץ שוב." });
  }

  try {
    const stat = await fs.stat(req.file.path);
    console.info("Audio upload received", JSON.stringify({ size: stat.size, mimeType: req.file.mimetype || "audio/mpeg", originalName: path.basename(req.file.originalname || "audio") }));
    logOperation(req.operationId,"upload_received","הקובץ התקבל בשרת ("+stat.size+" בתים)","success");
    logOperation(req.operationId,"gemini_preflight","בודק גישה ל־Gemini ולפרויקט Google Cloud");
    if (!apiKey) await geminiPreflight(session);
    else logOperation(req.operationId,"gemini_preflight","נבחר מפתח API אישי; מדלג על בדיקת OAuth");
    logOperation(req.operationId,"model_check","בדיקת הרשאות הושלמה; זמינות כל מודל תיבדק לפי קוד התשובה בזמן הניסיון");
    if (!stat.size) throw new Error("הקובץ שהתקבל ריק. בחר קובץ אודיו אחר.");
    if (stat.size > INLINE_AUDIO_MAX_BYTES) {
      return res.status(413).json({
        error: "הקובץ גדול מדי למצב Google OAuth ללא מפתח Gemini. כרגע נתמכים קבצי אודיו עד 14MB."
      });
    }

    // Gemini's standard Files API upload endpoint rejects the user OAuth bearer
    // token used by this app. Send small audio inline to generateContent instead.
    logOperation(req.operationId,"audio_prepare","מכין את האודיו לשליחה למודל");
    const audioBase64 = (await fs.readFile(req.file.path)).toString("base64");
    const mimeType = req.file.mimetype || "audio/mpeg";

    logOperation(req.operationId,"analysis_primary","Gemini מבצע כעת ניתוח ראשוני של המילים והאקורדים");
    const first = cleanAnalysis(await analyzeWithGeminiRetry(
      session,
      audioBase64,
      mimeType,
      PRIMARY_PROMPT,
      req.operationId,
      "analysis_primary",
      apiKey
    ));

    pendingVerifications.set(req.operationId,{audioBase64:audioBase64,mimeType:mimeType,first:first,apiKey:apiKey,createdAt:Date.now()});
    logOperation(req.operationId,"primary_completed","הניתוח הראשוני הסתיים; דף השיר מוצג וניתן להפעיל אימות נוסף","success");
    res.json({analysis:first,verificationAvailable:true,operationId:req.operationId});
  } catch (error) {
    console.error("Gemini analysis failed", JSON.stringify({
      status: error && error.geminiStatus ? error.geminiStatus : null,
      code: error && error.geminiCode ? error.geminiCode : null,
      apiCode: error && error.geminiApiCode ? error.geminiApiCode : null,
      message: error && error.message ? error.message : String(error)
    }));
    if (error && (error.code === "INSUFFICIENT_SCOPE" || /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(String(error.message || "")))) {
      const token = cookieToken(req);
      if (token) sessions.delete(token);
      clearSessionCookie(res);
      return res.status(401).json({
        error: "הרשאת Gemini בחשבון Google חסרה או ישנה. התנתק והתחבר מחדש עם Google כדי לאשר את הרשאת Gemini."
      });
    }
    res.status(500).json({ error: error && error.message ? "Gemini: " + error.message : "ניתוח השיר נכשל" });
  } finally {
    try { await fs.unlink(req.file.path); } catch {}
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
