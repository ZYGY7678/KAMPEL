import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";
import Replicate from "replicate";
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
const usageReservations = new Map();
let usageStateCache = null;
let usageStateLoadPromise = null;
let usageWriteQueue = Promise.resolve();
const OAUTH_SCOPES = "openid email profile";
const APP_URL = process.env.APP_URL || "https://chord-studio-frl5.onrender.com";
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Asia/Jerusalem";
const DAILY_SONG_LIMIT = 1;
const PREMIUM_AMOUNT = 1500;
const PREMIUM_CURRENCY = "ils";
const PREMIUM_PRODUCT_NAME = "Chord Studio Premium";
const ADMIN_EMAIL = "zygy7678@gmail.com";
const PREMIUM_GRANTS_FILE = process.env.PREMIUM_GRANTS_FILE || path.join(uploadDir, "premium-grants.json");
let premiumGrantsCache = null;
async function loadPremiumGrants(){
 if(supabaseReady()){
   const rows=await sb("premium_grants?select=email,granted");
   const out={};
   for(const row of rows||[]) if(row&&row.granted===true) out[normalizeEmail(row.email)]=true;
   return out;
 }
 if(premiumGrantsCache)return premiumGrantsCache;
 try{const parsed=JSON.parse(await fs.readFile(PREMIUM_GRANTS_FILE,"utf8"));premiumGrantsCache=parsed&&typeof parsed==="object"?parsed:{};}
 catch{premiumGrantsCache={};}
 return premiumGrantsCache;
}
async function savePremiumGrants(){
 if(supabaseReady()) return;
 const tmp=PREMIUM_GRANTS_FILE+".tmp-"+process.pid;
 await fs.writeFile(tmp,JSON.stringify(premiumGrantsCache||{}),"utf8");
 await fs.rename(tmp,PREMIUM_GRANTS_FILE);
}
const USAGE_STATE_FILE = process.env.USAGE_STATE_FILE || path.join(uploadDir, "usage-state.json");
function supabaseReady(){return Boolean(process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY);}
function tokenHash(token){return crypto.createHash("sha256").update(String(token)).digest("hex");}
async function sb(endpoint,method="GET",body){if(!supabaseReady())throw new Error("Supabase service key is not configured");const base=process.env.SUPABASE_URL.replace(/\/+$/,"");const response=await fetch(base+"/rest/v1/"+endpoint,{method,headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+process.env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation,resolution=merge-duplicates"},body:body===undefined?undefined:JSON.stringify(body)});const raw=await response.text();let data;try{data=raw?JSON.parse(raw):[];}catch{data=[];}if(!response.ok)throw new Error("Supabase "+response.status+": "+JSON.stringify(data).slice(0,300));return data;}
async function ensureAccount(user){const email=normalizeEmail(user.email);const existing=await sb("app_accounts?select=account_id&email=eq."+encodeURIComponent(email)+"&limit=1");if(existing.length){await sb("app_accounts?account_id=eq."+encodeURIComponent(existing[0].account_id),"PATCH",{display_name:String(user.name||"").trim()||email,auth_provider:"google",updated_at:new Date().toISOString()});return existing[0].account_id;}const id=accountIdForUser(user);try{await sb("app_accounts","POST",{account_id:id,email:email,display_name:String(user.name||"").trim()||email,auth_provider:"google",is_admin:email===ADMIN_EMAIL,premium_granted:false});}catch(error){const raced=await sb("app_accounts?select=account_id&email=eq."+encodeURIComponent(email)+"&limit=1");if(!raced.length)throw error;return raced[0].account_id;}return id;}
function cookieToken(req){const raw=String(req.headers.cookie||""),m=raw.match(/(?:^|;\s*)chord_session=([^;]+)/);return m?decodeURIComponent(m[1]):"";}
async function authSession(req){const token=cookieToken(req);if(!token)return null;if(!supabaseReady())return sessions.get(token)||null;try{const rows=await sb("auth_sessions?select=account_id,expires_at&token_hash=eq."+tokenHash(token)+"&limit=1");if(!rows.length||new Date(rows[0].expires_at).getTime()<=Date.now())return null;const accounts=await sb("app_accounts?select=account_id,email,display_name&account_id=eq."+rows[0].account_id+"&limit=1");if(!accounts.length)return null;return{user:{id:accounts[0].account_id,accountId:accounts[0].account_id,name:accounts[0].display_name||accounts[0].email,email:accounts[0].email,picture:""},premium:false,premiumCheckedAt:0,createdAt:Date.now(),accountId:accounts[0].account_id};}catch(e){console.error("Supabase session lookup failed",String(e.message||e));return null;}}
function setSessionCookie(res,token){res.setHeader("Set-Cookie","chord_session="+encodeURIComponent(token)+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");}
function clearSessionCookie(res){res.setHeader("Set-Cookie","chord_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");}
function requireGoogleOAuth(res){if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET){res.status(503).json({error:"Google OAuth עדיין לא הוגדר בשרת. חסרים GOOGLE_CLIENT_ID או GOOGLE_CLIENT_SECRET."});return false;}return true;}
function normalizeEmail(email){return String(email||"").trim().toLowerCase();}
function accountIdForUser(user){if(user&&user.accountId)return String(user.accountId);const stable=String(user&&user.id||normalizeEmail(user&&user.email));return crypto.createHash("sha256").update("chord-studio-account:"+stable).digest("hex");}
function todayKey(){const parts=new Intl.DateTimeFormat("en-US",{timeZone:APP_TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()),map={};for(const part of parts)if(part.type!=="literal")map[part.type]=part.value;return map.year+"-"+map.month+"-"+map.day;}
function nextDailyReset(){const now=new Date(),fmt=new Intl.DateTimeFormat("en-US",{timeZone:APP_TIMEZONE,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}),parts=fmt.formatToParts(now),p={};for(const x of parts)if(x.type!=="literal")p[x.type]=Number(x.value);const next=new Date(Date.UTC(p.year,p.month-1,p.day+1)),target=Date.UTC(next.getUTCFullYear(),next.getUTCMonth(),next.getUTCDate());function offsetAt(date){const q={};for(const x of fmt.formatToParts(date))if(x.type!=="literal")q[x.type]=Number(x.value);return Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second)-Math.floor(date.getTime()/1000)*1000;}let reset=new Date(target-offsetAt(new Date(target)));reset=new Date(target-offsetAt(reset));return reset;}
function usageReservationKey(id,date){return String(id)+"|"+String(date);}
async function withUsageWriteLock(fn){const p=usageWriteQueue.then(fn,fn);usageWriteQueue=p.catch(function(){});return p;}
async function loadUsageState(){if(usageStateCache)return usageStateCache;if(usageStateLoadPromise)return usageStateLoadPromise;usageStateLoadPromise=(async function(){try{const raw=await fs.readFile(USAGE_STATE_FILE,"utf8"),parsed=JSON.parse(raw);usageStateCache=parsed&&typeof parsed==="object"?parsed:{users:{}};}catch{usageStateCache={users:{}};}if(!usageStateCache.users||typeof usageStateCache.users!=="object")usageStateCache.users={};usageStateLoadPromise=null;return usageStateCache;})();return usageStateLoadPromise;}
async function saveUsageState(){const state=usageStateCache||{users:{}},dir=path.dirname(USAGE_STATE_FILE),tmp=USAGE_STATE_FILE+".tmp-"+process.pid;await fs.mkdir(dir,{recursive:true});await fs.writeFile(tmp,JSON.stringify(state),"utf8");await fs.rename(tmp,USAGE_STATE_FILE);}
async function getDailyUsage(id){
 if(supabaseReady()){
   const rows=await sb("rpc/get_daily_song_usage","POST",{p_account_id:id,p_usage_date:todayKey(),p_daily_limit:DAILY_SONG_LIMIT});
   const row=Array.isArray(rows)?(rows[0]||{}):(rows||{});
   return {date:row.usage_date||todayKey(),used:Number(row.used)||0,reserved:Number(row.reserved)||0,remaining:Math.max(0,Number(row.remaining)||0)};
 }
 return withUsageWriteLock(async function(){const state=await loadUsageState(),date=todayKey(),entry=state.users[id],used=entry&&entry.date===date?Math.max(0,Number(entry.count)||0):0,res=usageReservations.has(usageReservationKey(id,date));return{date:date,used:used,remaining:Math.max(0,DAILY_SONG_LIMIT-used-(res?1:0)),reserved:res?1:0};});
}
async function reserveDailyUsage(id){
 if(supabaseReady()){
   const rows=await sb("rpc/reserve_daily_song","POST",{p_account_id:id,p_usage_date:todayKey(),p_daily_limit:DAILY_SONG_LIMIT});
   const row=Array.isArray(rows)?(rows[0]||{}):(rows||{});
   if(row.allowed!==true)return {allowed:false,date:row.usage_date||todayKey(),reason:row.reason||"limit",remaining:Number(row.remaining)||0};
   const reservationKey=String(row.reservation_id||"");
   if(!reservationKey)throw new Error("Supabase quota reservation did not return an id");
   return {allowed:true,date:row.usage_date||todayKey(),remaining:Number(row.remaining)||0,reservationKey:reservationKey};
 }
 return withUsageWriteLock(async function(){const date=todayKey(),key=usageReservationKey(id,date);if(usageReservations.has(key))return{allowed:false,date:date,reason:"pending"};const state=await loadUsageState(),entry=state.users[id],used=entry&&entry.date===date?Math.max(0,Number(entry.count)||0):0;if(used>=DAILY_SONG_LIMIT)return{allowed:false,date:date,reason:"limit"};usageReservations.set(key,Date.now());return{allowed:true,date:date,remaining:Math.max(0,DAILY_SONG_LIMIT-used-1),reservationKey:key};});
}
async function commitDailyUsage(id,date,reservationKey){
 if(supabaseReady()){
   const rows=await sb("rpc/commit_daily_song","POST",{p_account_id:id,p_usage_date:date,p_reservation_id:reservationKey});
   const row=Array.isArray(rows)?(rows[0]||{}):(rows||{});
   if(row.ok!==true)throw new Error("Supabase quota commit failed");
   return row;
 }
 return withUsageWriteLock(async function(){const state=await loadUsageState(),cur=state.users[id],count=cur&&cur.date===date?Math.max(0,Number(cur.count)||0):0;state.users[id]={date:date,count:Math.min(DAILY_SONG_LIMIT,count+1)};await saveUsageState();usageReservations.delete(usageReservationKey(id,date));});
}
async function releaseDailyUsage(id,key){
 if(!key)return;
 if(supabaseReady()){
   try{await sb("rpc/release_daily_song","POST",{p_account_id:id,p_reservation_id:key});}catch(e){console.error("Supabase quota release failed",String(e.message||e));}
   return;
 }
 usageReservations.delete(key);
}
async function saveAnalysisHistory(accountId,analysis){const rows=await sb("analysis_history","POST",{account_id:accountId,title:String(analysis&&analysis.title||""),artist:String(analysis&&analysis.artist||""),analysis:analysis});const row=Array.isArray(rows)?rows[0]:rows;return row&&row.id?String(row.id):"";}
async function updateAnalysisHistory(id,accountId,analysis){if(!id)return;await sb("analysis_history?id=eq."+encodeURIComponent(id)+"&account_id=eq."+encodeURIComponent(accountId),"PATCH",{title:String(analysis&&analysis.title||""),artist:String(analysis&&analysis.artist||""),analysis:analysis});}
async function stripeRequest(endpoint,method,params){if(!process.env.STRIPE_SECRET_KEY){const e=new Error("Stripe עדיין לא הוגדר בשרת.");e.code="STRIPE_NOT_CONFIGURED";throw e;}let url="https://api.stripe.com"+endpoint;const headers={Authorization:"Bearer "+process.env.STRIPE_SECRET_KEY};let body;if(method==="GET"){const q=params?new URLSearchParams(params).toString():"";if(q)url+="?"+q;}else if(params){headers["Content-Type"]="application/x-www-form-urlencoded";body=new URLSearchParams(params).toString();}const resp=await fetch(url,{method:method||"GET",headers:headers,body:body}),raw=await resp.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch{}if(!resp.ok){const e=new Error(data&&data.error&&data.error.message||"Stripe request failed");e.stripeStatus=resp.status;throw e;}return data;}
async function stripeHasPaidPremium(id){if(!process.env.STRIPE_SECRET_KEY)return false;const safe=String(id).replace(/"/g,'\"'),query='metadata["chord_studio_premium"]:"1" AND metadata["account_id"]:"'+safe+'" AND status:"succeeded" AND currency:"'+PREMIUM_CURRENCY+'" AND amount:'+PREMIUM_AMOUNT,data=await stripeRequest("/v1/payment_intents/search","GET",{query:query,limit:"1"});return Boolean(data&&Array.isArray(data.data)&&data.data.some(function(item){return item&&item.status==="succeeded"&&Number(item.amount)===PREMIUM_AMOUNT&&String(item.currency||"").toLowerCase()===PREMIUM_CURRENCY&&item.metadata&&item.metadata.chord_studio_premium==="1"&&item.metadata.account_id===id;}));}
async function isPremiumSession(session){if(!session)return false;if(session.premium===true)return true;const grants=await loadPremiumGrants();if(grants[normalizeEmail(session.user.email)]===true)return true;if(!process.env.STRIPE_SECRET_KEY)return false;if(session.premiumCheckedAt&&Date.now()-session.premiumCheckedAt<30000)return Boolean(session.premium);try{session.premium=await stripeHasPaidPremium(accountIdForUser(session.user));}catch(e){console.error("Stripe premium check failed",String(e&&e.message||e));session.premium=false;}session.premiumCheckedAt=Date.now();return Boolean(session.premium);}
async function geminiApiKeyPreflight(key){const resp=await fetch("https://generativelanguage.googleapis.com/v1beta/models?key="+encodeURIComponent(key),{method:"GET"}),raw=await resp.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch{}if(!resp.ok){const e=new Error(data&&data.error&&data.error.message||"מפתח Gemini API אינו תקין או אינו מורשה.");e.geminiStatus=resp.status;e.geminiCode=data&&data.error&&data.error.status||"";e.geminiApiCode=data&&data.error&&data.error.code||null;throw e;}return data;}


const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 }
});

const MODEL = "gemini-flash-lite-latest";
const INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024; // keep encoded request safely below Gemini audio inline request limit

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    artist: { type: "string" },
    capo: { type: "integer", nullable: true },
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
  "Analyze the entire attached audio from the first audible sample to the final audible sample. Do not analyze only a preview or the opening section.",
  "The uploaded filename is provided separately as a clue for identifying the song title and artist. Use it carefully; do not treat an unverified filename as proof and do not invent metadata.",
  "Return ONLY structured JSON matching the supplied schema.",
  "",
  "Perform a careful, high-effort transcription of the COMPLETE recording. Internally make multiple listening passes: first map song sections and vocal entrances, then transcribe every sung word in order, then re-check the entire vocal track against the audio. Include every verse, chorus, bridge, repeated section, intro/outro vocal, ad-lib and ending; never summarize or silently skip repeated lines. Distinguish lead vocals from backing vocals and instruments. Preserve the exact sung language and wording; do not replace unusual but audible words with familiar phrases. If a word is genuinely unclear, omit only that word and do not guess.",
  "Return all detected lyric lines and the COMPLETE chord timeline for the full duration, including lyric-free instrumental passages. The chords array is independent of lyric words: never omit chords only because nobody is singing at that moment. In particular, detect and return the harmony of every instrumental transition/מעבר between verse, chorus and bridge, every interlude/turnaround, intro, and outro. Ensure the final word and final chord events are covered through the end of the recording.",
  "For every lyric word provide real start and end seconds on the original audio timeline.",
  "For Hebrew, listen closely to consonants, syllable boundaries, grammatical context and the singer’s pronunciation. Add niqqud only when the pronunciation is supported by the audio; preserve exact words and natural punctuation. Re-check similar-sounding Hebrew words carefully and never choose a word merely because it makes a more familiar sentence.",
  "Chord rhythm and density: in a regular 4/4 passage, use one chord event per complete four-beat measure (four regular beats), not one chord per beat. Estimate beat duration from BPM and place the chord at the start of the measure or where the harmony audibly changes. Do not create extra chord changes merely because a beat or lyric word occurs. Only in genuinely exceptional passages where the harmony audibly changes unusually within the measure or clearly departs from the regular four-beat pattern, include the sequence of distinct chords at their actual change times. Treat these exceptions as rare and audio-evidenced, not as a default. If the same chord sustains across measures, do not repeat its label on every beat or word; preserve a new event only when a distinct chord change or meaningful re-entry is heard.",
  "Prefer standard chord names such as Bb, F#m7, Cmaj7, G/B.",
  "Determine the overall key and BPM when possible. Also identify the capo fret used in the recording, if a capo is audible or indicated by the arrangement; return capo as an integer from 0 to 12, using 0 when no capo is used and null only when it cannot be determined. Do not confuse capo position with song key.",
  "Preserve section boundaries and label them explicitly. For verses use the order of the song: first verse = בית א, second verse = בית ב, third verse = בית ג, and so on. Label every chorus/refrain as פזמון. Preserve other section types such as Intro, Pre-Chorus, Bridge and Outro. For instrumental transitions with no lyrics, do NOT omit their chords from the independent chords array; the UI will display those chord events as a dedicated מעבר block, so an empty lyric line is not required.",
  "",
  "Critical chord display rule: place a chord label only ONCE, at the first suitable sung word at or immediately after that chord change. Never repeat the same sustained chord above every subsequent word. Leave chord=null on words while the same chord continues; add a new anchor only when the harmony changes to a different chord. If the same chord returns after a different chord, anchor it again at its new entrance. Keep the complete chord timeline in the chords array independently of word anchors.",
  "Re-check every chord change against the actual audio, especially around vocal entrances. Scan the entire audio timeline in order, not just selected excerpts.",
  "Re-check word timestamps around every chord change.",
  "Never fabricate timestamps. When uncertain, prefer omission over invented content.",
  "Confidence must be a number from 0 to 1."
].join("\\n");

const VERIFY_PREFIX = [
  "You are the second, independent verification pass for a professional chord-and-lyrics extraction system.",
  "The attached audio is the source of truth.",
  "Audit the candidate JSON below and return the COMPLETE corrected object using the supplied schema.",
  "",
  "Correct lyric words, Hebrew niqqud/punctuation, or timestamps that do not match the audio.",
  "For Hebrew, keep vowel-point niqqud according to the sung pronunciation when it is confidently supported by what is heard; do not invent niqqud. Preserve natural punctuation when supported by phrasing.",
  "Verify the capo position too: return capo as an integer from 0 to 12, use 0 when no capo is used, and null only when uncertain. Do not confuse capo position with song key. Correct chord names and chord change times when the audio disagrees. In regular 4/4 sections, prefer one chord per four-beat measure rather than one per beat; include multiple distinct chords within a measure only for clearly audible exceptional harmonic changes.",
  "Audit the COMPLETE chord timeline, including all lyric-free instrumental transitions/מעברים, interludes, turnarounds, intros and outros. Chords must not disappear just because there are no lyric words. Every meaningful audible harmonic change in a transition must remain in the chords array.",
  "Keep all events chronological and keep all times inside the song duration.",
  "For a chord-to-word anchor, only use a lyric word when the chord starts at or very near that word's start. Place each chord label once per chord event, not on every word where the chord sustains. Leave other words chord=null. If a chord repeats after a different chord, create a fresh anchor. When possible, chordOffset should identify the character index inside the word where the harmonic change lands; otherwise use 0.",
  "Verify coverage from 0 seconds through the exact end of the audio. Include all lyrics and chord events across every section; never return only the first portion due to convenience. If output limits are approached, prioritize complete chronological coverage and concise word-level entries rather than omitting later sections.",
  "Do not invent lyrics. If uncertainty remains, omit unsupported content or use the safer less-specific chord.",
  "Candidate JSON:"
].join("\\n");

function filenameHint(filename) {
  return path.basename(String(filename || "")).trim();
}

async function extractAudioMetadata(filePath) {
  try {
    const metadata = await parseFile(filePath, { skipCovers: true });
    const common = metadata && metadata.common ? metadata.common : {};
    return {
      title: String(common.title || "").trim(),
      artist: String(common.artist || "").trim(),
      album: String(common.album || "").trim(),
      albumArtist: String(common.albumartist || "").trim(),
      track: common.track && common.track.no ? Number(common.track.no) : null,
      year: common.year ? Number(common.year) : null
    };
  } catch (error) {
    console.warn("Audio metadata read failed", String(error && error.message || error).slice(0, 250));
    return {};
  }
}

function metadataPromptBlock(filename, audioMetadata) {
  const safeMeta = {
    filename: filenameHint(filename),
    embeddedTags: audioMetadata || {}
  };
  return [
    "",
    "SONG IDENTIFICATION HINTS FROM THE UPLOADED FILE:",
    JSON.stringify(safeMeta),
    "Use these file-level hints together with what you hear in the attached audio.",
    "Identify the actual song title and the actual singer/artist. The embedded tags and filename are clues, not proof: correct them when they conflict with the audio or when they clearly describe a different recording. Do not copy a malformed filename into the title field.",
    "Return the best-supported title and artist in the analysis.title and analysis.artist fields. Never return placeholder text such as 'שיר ללא שם' when the audio or supplied file metadata gives a usable identification."
  ].join("\n");
}

function sectionKind(section) {
  const s = String(section || "").trim().toLowerCase();
  if (/pre[- ]?chorus|קדם[- ]?פזמון/.test(s)) return "prechorus";
  if (/chorus|refrain|פזמון/.test(s)) return "chorus";
  if (/bridge|גשר/.test(s)) return "bridge";
  if (/intro|opening|פתיחה/.test(s)) return "intro";
  if (/outro|ending|סיום/.test(s)) return "outro";
  if (/transition|interlude|turnaround|מעבר|אינטרלוד/.test(s)) return "transition";
  if (/verse|בית/.test(s)) return "verse";
  return "other";
}

function hebrewVerseLabel(n) {
  const letters = ["א","ב","ג","ד","ה","ו","ז","ח","ט","י","יא","יב","יג","יד","טו"];
  return letters[n - 1] ? "בית " + letters[n - 1] : "בית " + n;
}

function normalizeSectionLabels(lines) {
  let verseCount = 0;
  let previousKind = "";
  return (lines || []).map(function(line) {
    const raw = String(line.section || "").trim();
    const kind = sectionKind(raw);
    let section = raw;
    if (kind === "verse") {
      const explicit = raw.match(/(?:verse|בית)\s*(?:no\.\s*)?([0-9]+)/i);
      if (previousKind !== "verse") verseCount += 1;
      if (explicit) verseCount = Math.max(verseCount, Number(explicit[1]) || verseCount);
      section = hebrewVerseLabel(verseCount);
    } else if (kind === "chorus") {
      section = "פזמון";
    } else if (kind === "transition") {
      section = "מעבר";
    }
    previousKind = kind;
    return Object.assign({}, line, { section: section });
  });
}

function cleanAnalysis(value) {
  const data = value && typeof value === "object" ? value : {};
  const duration = Number(data.duration) > 0 ? Number(data.duration) : 0;
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const chords = Array.isArray(data.chords) ? data.chords : [];

  const rawLines = lines.map(function(line, i) {
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

  const outLines = normalizeSectionLabels(rawLines);

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


  return {
    title: String(data.title || ""),
    artist: String(data.artist || ""),
    capo: data.capo == null || !Number.isFinite(Number(data.capo)) ? null : Math.max(0, Math.min(12, Math.floor(Number(data.capo)))),
    key: String(data.key || ""),
    bpm: Number(data.bpm) || 0,
    duration: duration,
    detectedLanguage: String(data.detectedLanguage || ""),
    confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
    lines: outLines,
    chords: outChords
  };
}

app.get("/api/health",function(_req,res){res.json({ok:true,model:MODEL,auth:"google-and-email-password",googleOAuthConfigured:Boolean(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),stripeConfigured:Boolean(process.env.STRIPE_SECRET_KEY),replicateConfigured:Boolean(process.env.REPLICATE_API_TOKEN),supabaseConfigured:supabaseReady(),persistence:supabaseReady()?"supabase":"local-fallback",apiKeyRequired:true,dailyLimit:DAILY_SONG_LIMIT});});

app.get("/auth/google",function(_req,res){if(!requireGoogleOAuth(res))return;const state=crypto.randomBytes(24).toString("hex");oauthStates.set(state,Date.now());const params=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:APP_URL+"/auth/google/callback",response_type:"code",scope:OAUTH_SCOPES,state:state});res.redirect("https://accounts.google.com/o/oauth2/v2/auth?"+params.toString());});
app.get("/auth/google/callback",async function(req,res){const state=String(req.query.state||""),code=String(req.query.code||""),created=oauthStates.get(state);oauthStates.delete(state);if(!created||Date.now()-created>10*60*1000||!code)return res.status(400).send("Google authentication state expired or invalid");try{const tokenRes=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code:code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:APP_URL+"/auth/google/callback",grant_type:"authorization_code"})}),tokens=await tokenRes.json();if(!tokenRes.ok||!tokens.access_token)throw new Error(tokens.error_description||"Google token exchange failed");const userRes=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",{headers:{Authorization:"Bearer "+tokens.access_token}}),user=await userRes.json();if(!userRes.ok||!user.sub||user.email_verified!==true)throw new Error("Google user info failed or email is not verified");const sessionId=crypto.randomBytes(32).toString("hex"),userData={id:String(user.sub),name:user.name||user.email||"Google user",email:normalizeEmail(user.email),picture:user.picture||""};if(supabaseReady()){const accountId=await ensureAccount(userData);userData.accountId=accountId;await sb("auth_sessions","POST",{token_hash:tokenHash(sessionId),account_id:accountId,expires_at:new Date(Date.now()+2592000000).toISOString()});}else{sessions.set(sessionId,{user:userData,premium:false,premiumCheckedAt:0,createdAt:Date.now()});}setSessionCookie(res,sessionId);res.redirect("/");}catch(error){console.error(error);res.status(500).send("Google authentication failed");}});
app.post("/api/auth/register",async function(req,res){const name=String(req.body&&req.body.name||"").trim(),email=normalizeEmail(req.body&&req.body.email),password=String(req.body&&req.body.password||"");if(name.length<2||name.length>80)return res.status(400).json({error:"השם חייב להכיל בין 2 ל־80 תווים"});if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email))return res.status(400).json({error:"כתובת אימייל לא תקינה"});if(password.length<8||password.length>200)return res.status(400).json({error:"הסיסמה חייבת להכיל לפחות 8 תווים"});if(!supabaseReady())return res.status(503).json({error:"שמירת חשבונות דורשת חיבור למסד הנתונים"});try{const exists=await sb("app_accounts?select=account_id&email=eq."+encodeURIComponent(email)+"&limit=1");if(exists.length)return res.status(409).json({error:"כבר קיים חשבון עם כתובת האימייל הזו. נסה להתחבר"});const accountId=accountIdForUser({email}),salt=crypto.randomBytes(16).toString("hex"),hash=crypto.scryptSync(password,salt,64).toString("hex"),passwordHash="scrypt$"+salt+"$"+hash;await sb("app_accounts","POST",{account_id:accountId,email,display_name:name,password_hash:passwordHash,auth_provider:"email",is_admin:email===ADMIN_EMAIL,premium_granted:false});const token=crypto.randomBytes(32).toString("hex");await sb("auth_sessions","POST",{token_hash:tokenHash(token),account_id:accountId,expires_at:new Date(Date.now()+2592000000).toISOString()});setSessionCookie(res,token);res.json({ok:true});}catch(error){console.error("Account registration failed",String(error.message||error));res.status(500).json({error:"לא הצלחנו ליצור חשבון כרגע"});}});
app.post("/api/auth/login",async function(req,res){const email=normalizeEmail(req.body&&req.body.email),password=String(req.body&&req.body.password||"");if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)||!password)return res.status(400).json({error:"יש להזין אימייל וסיסמה תקינים"});if(!supabaseReady())return res.status(503).json({error:"שמירת חשבונות דורשת חיבור למסד הנתונים"});try{const rows=await sb("app_accounts?select=account_id,email,display_name,password_hash&email=eq."+encodeURIComponent(email)+"&limit=1");const account=rows[0];if(!account||!account.password_hash)return res.status(401).json({error:"האימייל או הסיסמה שגויים"});const parts=String(account.password_hash).split("$");if(parts.length!==3||parts[0]!=="scrypt")return res.status(401).json({error:"האימייל או הסיסמה שגויים"});const candidate=crypto.scryptSync(password,parts[1],64),stored=Buffer.from(parts[2],"hex");if(stored.length!==candidate.length||!crypto.timingSafeEqual(stored,candidate))return res.status(401).json({error:"האימייל או הסיסמה שגויים"});const token=crypto.randomBytes(32).toString("hex");await sb("auth_sessions","POST",{token_hash:tokenHash(token),account_id:account.account_id,expires_at:new Date(Date.now()+2592000000).toISOString()});setSessionCookie(res,token);res.json({ok:true});}catch(error){console.error("Account login failed",String(error.message||error));res.status(500).json({error:"לא הצלחנו להתחבר כרגע"});}});
app.get("/api/auth/me",async function(req,res){const session=await authSession(req);if(!session)return res.json({authenticated:false,premium:false,plan:"standard",dailyRemaining:null,dailyUsed:null,paymentConfigured:Boolean(process.env.STRIPE_SECRET_KEY),apiKeyRequired:true});const premium=await isPremiumSession(session),usage=premium?{remaining:null,used:null}:await getDailyUsage(accountIdForUser(session.user));res.json({authenticated:true,user:session.user,isAdmin:normalizeEmail(session.user.email)===ADMIN_EMAIL,premium:premium,plan:premium?"premium":"standard",dailyRemaining:premium?null:usage.remaining,dailyUsed:premium?null:usage.used,dailyResetAt:premium?null:nextDailyReset().toISOString(),paymentConfigured:Boolean(process.env.STRIPE_SECRET_KEY),apiKeyRequired:true});});
app.get("/api/admin/users",async function(req,res){const session=await authSession(req);if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});try{const grants=await loadPremiumGrants();res.json({users:Object.keys(grants).filter(id=>grants[id]===true)});}catch(error){console.error(error);res.status(503).json({error:"לא ניתן לטעון את רשימת הרשאות Premium"});}});
app.post("/api/admin/premium",async function(req,res){const session=await authSession(req);if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});const email=normalizeEmail(req.body&&req.body.email),enabled=Boolean(req.body&&req.body.enabled);if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:"כתובת אימייל לא תקינה"});if(supabaseReady()){await sb("premium_grants?on_conflict=email","POST",{email:email,granted:enabled,updated_at:new Date().toISOString()});const account=await sb("app_accounts?select=account_id&email=eq."+encodeURIComponent(email)+"&limit=1");if(account.length)await sb("app_accounts?email=eq."+encodeURIComponent(email),"PATCH",{premium_granted:enabled,updated_at:new Date().toISOString()});}else{const grants=await loadPremiumGrants();if(enabled)grants[email]=true;else delete grants[email];await savePremiumGrants();}res.json({ok:true,email:email,premium:enabled});});
app.get("/api/history",async function(req,res){const session=await authSession(req);if(!session)return res.status(401).json({error:"לא מחובר"});if(!supabaseReady())return res.json({history:[]});try{const accountId=accountIdForUser(session.user),rows=await sb("analysis_history?select=id,title,artist,analysis,created_at&account_id=eq."+encodeURIComponent(accountId)+"&order=created_at.desc&limit=50");res.setHeader("Cache-Control","no-store");res.json({history:rows||[]});}catch(error){console.error(error);res.status(503).json({error:"לא ניתן לטעון היסטוריית ניתוחים"});}});
app.post("/api/auth/logout",async function(req,res){const token=cookieToken(req);if(token){sessions.delete(token);if(supabaseReady())try{await sb("auth_sessions?token_hash=eq."+tokenHash(token),"DELETE");}catch(e){console.error("Session revoke failed",String(e.message||e));}}clearSessionCookie(res);res.json({ok:true});});
app.post("/api/premium/checkout",async function(req,res){const session=await authSession(req);if(!session)return res.status(401).json({error:"יש להתחבר עם Google לפני רכישת Premium."});const accountId=accountIdForUser(session.user);if(await isPremiumSession(session))return res.json({alreadyPremium:true});if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:"מערכת התשלום עדיין לא הוגדרה בשרת."});try{const checkout=await stripeRequest("/v1/checkout/sessions","POST",{mode:"payment",locale:"he",success_url:APP_URL+"/?premium=success&session_id={CHECKOUT_SESSION_ID}",cancel_url:APP_URL+"/?premium=cancel",customer_email:normalizeEmail(session.user.email),client_reference_id:accountId,"line_items[0][price_data][currency]":PREMIUM_CURRENCY,"line_items[0][price_data][product_data][name]":PREMIUM_PRODUCT_NAME,"line_items[0][price_data][product_data][description]":"גישה מלאה ל-Chord Studio, ללא מגבלת שירים יומית ועם הפרדת קול הזמר","line_items[0][price_data][unit_amount]":String(PREMIUM_AMOUNT),"line_items[0][quantity]":"1","metadata[chord_studio_premium]":"1","metadata[account_id]":accountId,"payment_intent_data[metadata][chord_studio_premium]":"1","payment_intent_data[metadata][account_id]":accountId});if(!checkout||!checkout.url)throw new Error("Stripe לא החזיר קישור לתשלום.");res.json({url:checkout.url});}catch(error){console.error("Stripe checkout failed",String(error&&error.stack||error));res.status(502).json({error:"יצירת התשלום נכשלה: "+String(error&&error.message||error).slice(0,250)});}});
app.get("/api/premium/confirm",async function(req,res){const session=await authSession(req),sessionId=String(req.query.session_id||"").trim();if(!session)return res.status(401).json({error:"יש להתחבר עם Google לפני אישור התשלום."});if(!sessionId)return res.status(400).json({error:"חסר מזהה תשלום."});if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:"מערכת התשלום עדיין לא הוגדרה בשרת."});try{const checkout=await stripeRequest("/v1/checkout/sessions/"+encodeURIComponent(sessionId),"GET");const accountId=accountIdForUser(session.user),paid=checkout&&checkout.status==="complete"&&checkout.payment_status==="paid"&&Number(checkout.amount_total)===PREMIUM_AMOUNT&&String(checkout.currency||"").toLowerCase()===PREMIUM_CURRENCY&&checkout.metadata&&checkout.metadata.account_id===accountId&&checkout.metadata.chord_studio_premium==="1";if(!paid)return res.status(403).json({error:"התשלום לא אומת עבור חשבון Google הזה."});session.premium=true;session.premiumCheckedAt=Date.now();res.json({ok:true,premium:true});}catch(error){console.error("Stripe payment confirmation failed",String(error&&error.stack||error));res.status(502).json({error:"אימות התשלום נכשל: "+String(error&&error.message||error).slice(0,250)});}});
async function requireUploadAccess(req,res,options){req.operationId=operationId(req);logOperation(req.operationId,"access_check_started","השרת בודק חשבון, מנוע ניתוח ומכסה יומית");const session=await authSession(req);if(!session){res.status(401).json({error:"יש להתחבר עם חשבון לפני העלאת קובץ."});return false;}const localEngineEnabled=Boolean(process.env.LOCAL_AUDIO_ENGINE_URL&&process.env.LOCAL_AUDIO_ENGINE_TOKEN);const apiKeys=[String(req.headers["x-gemini-api-key"]||"").trim(),String(req.headers["x-gemini-api-key-2"]||"").trim()].filter(Boolean);if(!localEngineEnabled&&!apiKeys.length){res.status(401).json({error:"חייבים להזין לפחות מפתח Gemini API אחד לפני העלאת קובץ."});return false;}const premium=await isPremiumSession(session);if(options&&options.premiumRequired&&!premium){res.status(403).json({error:"התכונה הזו זמינה רק במצב Premium. שדרג את החשבון כדי להשתמש בה."});return false;}let usageReservation=null;if(options&&options.consumeDaily&&!premium){const quota=await reserveDailyUsage(accountIdForUser(session.user));if(!quota.allowed){res.status(429).json({error:"הגעת למכסה של שיר אחד ליום במצב רגיל. מצב Premium פותח את המגבלה.",dailyRemaining:0,dailyResetAt:nextDailyReset().toISOString()});return false;}usageReservation=quota;}let validKeys=apiKeys;if(options&&options.validateGeminiKey&&!localEngineEnabled){validKeys=[];let lastError=null;for(const key of apiKeys){try{await geminiApiKeyPreflight(key);validKeys.push(key);}catch(error){lastError=error;}}if(!validKeys.length){if(usageReservation)await releaseDailyUsage(accountIdForUser(session.user),usageReservation.reservationKey);res.status(400).json({error:"אף אחד ממפתחות Gemini API שהוזנו אינו תקין: "+String(lastError&&lastError.message||"בדוק את המפתחות").slice(0,300)});return false;}}req.auth={session:session,apiKey:validKeys[0]||"",apiKeys:validKeys,premium:premium,usageReservation:usageReservation,localEngine:localEngineEnabled};req.operationId=operationId(req);logOperation(req.operationId,"access_granted",premium?"חשבון ומפתחות API אומתו; ניתן להעלות את הקובץ":"חשבון, מפתח API ומכסת היום אומתו; ניתן להעלות את הקובץ","success");return true;}

async function analyzeWithGemini(apiKey,audioBase64,mimeType,prompt,operationIdValue,stage){
 const startedAt=Date.now();
 logOperation(operationIdValue,"gemini_request_started","שולחים בקשת Gemini אחת; שלב "+stage+", מודל "+MODEL);
 try{
   const controller=new AbortController();
   const timeoutMs=Math.max(30000,Number(process.env.GEMINI_TIMEOUT_MS)||240000);
   const timeout=setTimeout(function(){controller.abort();},timeoutMs);
   let response;
   try{
     response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(MODEL)+":generateContent",{
       method:"POST",
       headers:{
         "Content-Type":"application/json",
         "x-goog-api-key":apiKey
       },
       body:JSON.stringify({
         contents:[{
           role:"user",
           parts:[
             {text:prompt},
             {inline_data:{mime_type:mimeType,data:audioBase64}}
           ]
         }],
         generationConfig:{
           responseMimeType:"application/json",
           responseSchema:SCHEMA
         }
       }),
       signal:controller.signal
     });
   }finally{
     clearTimeout(timeout);
   }
   const raw=await response.text();
   let data={};
   try{data=raw?JSON.parse(raw):{};}
   catch(parseError){
     const e=new Error("Gemini החזיר גוף תשובה שאינו JSON תקין");
     e.geminiStatus=response.status;e.geminiCode="INVALID_JSON";e.responsePreview=raw.slice(0,500);throw e;
   }
   if(!response.ok){
     const error=new Error(data&&data.error&&data.error.message||"Gemini generation failed");
     error.geminiStatus=response.status;
     error.geminiCode=data&&data.error&&data.error.status||"";
     error.geminiApiCode=data&&data.error&&data.error.code||null;
     error.retryAfterSeconds=Number(response.headers.get("retry-after"))||0;
     throw error;
   }
   const outputText=data.candidates&&data.candidates[0]&&data.candidates[0].content&&Array.isArray(data.candidates[0].content.parts)
     ?data.candidates[0].content.parts.map(function(part){return part&&part.text||"";}).join("")
     :"";
   if(!outputText){
     const e=new Error("Gemini returned an empty response");
     e.geminiStatus=response.status;e.geminiCode="EMPTY_RESPONSE";throw e;
   }
   let parsed;
   try{parsed=JSON.parse(outputText);}
   catch(parseError){
     const e=new Error("Gemini החזיר תוכן שאינו JSON תקין: "+String(parseError.message||parseError).slice(0,180));
     e.geminiStatus=response.status;e.geminiCode="INVALID_MODEL_JSON";throw e;
   }
   logOperation(operationIdValue,"gemini_response_received","Gemini החזיר תשובה תקינה; שלב "+stage+", מודל "+MODEL+", HTTP "+response.status+", משך "+(Date.now()-startedAt)+"ms");
   return parsed;
 }catch(error){
   const message=error&&error.name==="AbortError"?"הבקשה ל־Gemini חרגה ממגבלת הזמן":"בקשת Gemini נכשלה";
   logOperation(operationIdValue,"gemini_request_failed",message+"; שלב "+stage+", מודל "+MODEL+", HTTP "+(error&&error.geminiStatus||"לא התקבל")+", קוד "+(error&&error.geminiCode||"לא ידוע")+", משך "+(Date.now()-startedAt)+"ms, פירוט: "+String(error&&error.message||error).slice(0,350),"error");
   throw error;
 }
}

app.post("/api/verify/:id",async function(req,res){
 const session=await authSession(req),apiKey=String(req.headers["x-gemini-api-key"]||"").trim(),id=String(req.params.id||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80),pending=pendingVerifications.get(id);
 if(!session)return res.status(401).json({error:"יש להתחבר עם Google לפני האימות."});
 if(!apiKey)return res.status(401).json({error:"יש להזין מפתח Gemini API לפני האימות."});
 if(!pending)return res.status(404).json({error:"לא נמצאה תוצאת ניתוח זמינה לאימות. הרץ ניתוח ראשוני מחדש."});
 try{
   const verifyPrompt=VERIFY_PREFIX+metadataPromptBlock(pending.filename,pending.audioMetadata)+"\nCandidate JSON:\n"+JSON.stringify(pending.first);
   const verified=cleanAnalysis(await analyzeWithGemini(apiKey,pending.audioBase64,pending.mimeType,verifyPrompt,id,"analysis_verify"));
   if(supabaseReady()&&pending.historyId)await updateAnalysisHistory(pending.historyId,accountIdForUser(session.user),verified);
   pendingVerifications.delete(id);
   res.json({analysis:verified,verified:true});
 }catch(error){
   res.status(502).json({error:"האימות הנוסף נכשל, אך הניתוח הראשוני נשמר. "+String(error&&error.message||error),verificationFailed:true});
 }
});

app.get("/api/operations/:id",async function(req,res){
 const id=String(req.params.id||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80);
 if(!await authSession(req))return res.status(401).json({error:"לא מחובר"});
 res.setHeader("Cache-Control","no-store");res.json({operationId:id,events:operations.get(id)||[]});
});
app.post("/api/analyze",async function(req,res){
 const startedAt=Date.now();req.operationId=operationId(req);
 logOperation(req.operationId,"request_received","התקבלה בקשת ניתוח מהדפדפן");
 let currentStage="access_check";
 try{
  const access=await requireUploadAccess(req,res,{consumeDaily:true,validateGeminiKey:true});
  if(access!==true){logOperation(req.operationId,"access_denied","השרת עצר את הבקשה בשלב בדיקת הרשאות; HTTP "+res.statusCode,"error");return;}
  currentStage="upload";
  logOperation(req.operationId,"upload_receiving","השרת התחיל לקבל את קובץ האודיו");
  upload.single("audio")(req,res,async function(uploadError){
   const usageReservation=req.auth&&req.auth.usageReservation;
   if(uploadError){
    if(usageReservation)await releaseDailyUsage(accountIdForUser(req.auth.session.user),usageReservation.reservationKey);
    const tooLarge=uploadError.code==="LIMIT_FILE_SIZE";
    logOperation(req.operationId,tooLarge?"file_too_large":"upload_failed","שגיאה בקבלת הקובץ: "+String(uploadError.message||uploadError).slice(0,300),"error");
    return res.status(tooLarge?413:400).json({error:tooLarge?"הקובץ גדול מדי (מקסימום 200MB).":"העלאת הקובץ נכשלה: "+String(uploadError.message||uploadError).slice(0,200)});
   }
   if(!req.file){
    if(usageReservation)await releaseDailyUsage(accountIdForUser(req.auth.session.user),usageReservation.reservationKey);
    logOperation(req.operationId,"upload_failed","השרת סיים לקבל את הבקשה אך לא מצא בה קובץ audio","error");
    return res.status(400).json({error:"לא התקבל קובץ אודיו. נסה לבחור את הקובץ שוב."});
   }
   try{
    currentStage="file_validation";logOperation(req.operationId,"file_received","קובץ התקבל; בודקים גודל וסוג");
    const stat=await fs.stat(req.file.path);
    logOperation(req.operationId,"file_stats","גודל הקובץ "+stat.size+" בתים; MIME "+String(req.file.mimetype||"לא צוין"));
    if(!stat.size)throw new Error("הקובץ שהתקבל ריק. בחר קובץ אודיו אחר.");
    if(stat.size>INLINE_AUDIO_MAX_BYTES)throw new Error("הקובץ גדול מדי לניתוח ב-Gemini (מקסימום 14MB).");
    currentStage="audio_read";logOperation(req.operationId,"audio_read_started","קוראים את הקובץ ומכינים אותו לשליחה ל־Gemini");
    const audioBase64=(await fs.readFile(req.file.path)).toString("base64"),mimeType=req.file.mimetype||"audio/mpeg",filenameHintValue=filenameHint(req.file.originalname||"");
    logOperation(req.operationId,"audio_read_completed","הקובץ נקרא בהצלחה; גודל מקודד "+audioBase64.length+" תווים");
    currentStage="metadata";logOperation(req.operationId,"metadata_started","מחלצים פרטי אודיו כגון משך, קצב דגימה ומידע מוטמע");
    const audioMetadata=await extractAudioMetadata(req.file.path);
    logOperation(req.operationId,"metadata_completed","חילוץ פרטי האודיו הסתיים; "+(audioMetadata?"נמצאו פרטים":"לא נמצאו פרטים מוטמעים"));
    currentStage="analysis_primary";logOperation(req.operationId,"analysis_primary_started","מתחיל ניתוח ראשוני: זיהוי שיר, תמלול מילים, אקורדים ותזמון");
    let rawAnalysis=await analyzeWithGemini(req.auth.apiKey,audioBase64,mimeType,PRIMARY_PROMPT+metadataPromptBlock(filenameHintValue,audioMetadata),req.operationId,"analysis_primary");
    let first=cleanAnalysis(rawAnalysis);
    logOperation(req.operationId,"analysis_primary_completed","הניתוח הראשוני הושלם; זוהו "+(first.lines||[]).length+" שורות, "+(first.chords||[]).length+" אקורדים");
    logOperation(req.operationId,"analysis_ready","הניתוח הראשוני מוכן; ניתן להציג את המילים והאקורדים ולהפעיל אימות נוסף לפי בחירה");
    currentStage="history_save";
    let historyId="";
    if(supabaseReady()){logOperation(req.operationId,"history_save_started","שומרים את הניתוח בהיסטוריית החשבון");historyId=await saveAnalysisHistory(accountIdForUser(req.auth.session.user),first);logOperation(req.operationId,"history_save_completed","הניתוח נשמר בהיסטוריה"+(historyId?" (מזהה "+historyId+")":""));}
    pendingVerifications.set(req.operationId,{audioBase64:audioBase64,mimeType:mimeType,first:first,historyId:historyId,filename:filenameHintValue,audioMetadata:audioMetadata,createdAt:Date.now()});
    currentStage="quota_commit";
    if(usageReservation){logOperation(req.operationId,"quota_commit_started","מעדכנים את ניצול המכסה היומית לאחר ניתוח שהושלם");await commitDailyUsage(accountIdForUser(req.auth.session.user),usageReservation.date,usageReservation.reservationKey);logOperation(req.operationId,"quota_commit_completed","המכסה היומית עודכנה");}
    currentStage="response";logOperation(req.operationId,"completed","הניתוח הושלם ונשלחת תוצאה לדפדפן; משך כולל "+(Date.now()-startedAt)+"ms","success");
    res.json({analysis:first,verificationAvailable:true,operationId:req.operationId});
   }catch(error){
    if(usageReservation)await releaseDailyUsage(accountIdForUser(req.auth.session.user),usageReservation.reservationKey);
    let detail=String(error&&error.message||error);if(req.auth&&req.auth.apiKey)detail=detail.split(req.auth.apiKey).join("[מפתח מוסתר]");
    logOperation(req.operationId,"failed","כשל בשלב "+currentStage+" לאחר "+(Date.now()-startedAt)+"ms; HTTP 500; קוד "+String(error&&error.geminiCode||error&&error.code||"לא זמין")+"; פירוט: "+detail.slice(0,500),"error");
    res.status(500).json({error:detail?"Gemini: "+detail:"ניתוח השיר נכשל",operationId:req.operationId,stage:currentStage});
   }finally{try{await fs.unlink(req.file.path);logOperation(req.operationId,"temporary_file_removed","קובץ העבודה הזמני נמחק");}catch(cleanupError){logOperation(req.operationId,"cleanup_warning","לא ניתן היה למחוק קובץ זמני: "+String(cleanupError.message||cleanupError).slice(0,180),"error");}}
  });
 }catch(error){
  let detail=String(error&&error.message||error);if(req.auth&&req.auth.apiKey)detail=detail.split(req.auth.apiKey).join("[מפתח מוסתר]");
  logOperation(req.operationId,"failed","כשל לפני עיבוד הקובץ בשלב "+currentStage+"; HTTP 500; פירוט: "+detail.slice(0,500),"error");
  if(!res.headersSent)res.status(500).json({error:detail||"שגיאת שרת",operationId:req.operationId,stage:currentStage});
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

function normalizeExportSection(section, state) {
  const raw = String(section || "").trim();
  const s = raw.toLowerCase();
  if (/verse|בית/.test(s)) {
    const m = raw.match(/(?:verse|בית)\s*(?:no\.\s*)?([0-9]+)/i);
    if (state.lastKind !== "verse") state.verse += 1;
    if (m) state.verse = Math.max(state.verse, Number(m[1]) || state.verse);
    state.lastKind = "verse";
    const letters = ["א","ב","ג","ד","ה","ו","ז","ח","ט","י","יא","יב","יג","יד","טו"];
    return letters[state.verse - 1] ? "בית " + letters[state.verse - 1] : "בית " + state.verse;
  }
  if (/chorus|refrain|פזמון/.test(s)) { state.lastKind = "chorus"; return "פזמון"; }
  if (/transition|interlude|turnaround|מעבר|אינטרלוד/.test(s)) { state.lastKind = "transition"; return "מעבר"; }
  if (/pre[- ]?chorus|קדם[- ]?פזמון/.test(s)) { state.lastKind = "prechorus"; return "קדם־פזמון"; }
  if (/bridge|גשר/.test(s)) { state.lastKind = "bridge"; return "גשר"; }
  if (/intro|opening|פתיחה/.test(s)) { state.lastKind = "intro"; return "פתיחה"; }
  if (/outro|ending|סיום/.test(s)) { state.lastKind = "outro"; return "סיום"; }
  state.lastKind = "other";
  return raw.replace(/\bVerse\b/gi, "").trim();
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

function makeWordTable(words, fontSize) {
  const bodySize = Math.max(10, Math.min(48, Number(fontSize) || 24));
  const chordSize = Math.max(9, bodySize - 5);
  const chordCells = words.map(function(w) {
    return new TableCell({
      width: { size: Math.max(700, w.text.length * Math.max(360, bodySize * 18)), type: WidthType.DXA },
      borders: noBorders(),
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 0, before: 0 },
          children: [new TextRun({ text: w.chord || "", font: "Arial", bold: true, size: chordSize * 2, color: "2A8D88" })]
        })
      ]
    });
  });

  const wordCells = words.map(function(w) {
    return new TableCell({
      width: { size: Math.max(700, w.text.length * Math.max(360, bodySize * 18)), type: WidthType.DXA },
      borders: noBorders(),
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { after: 0, before: 0 },
          children: [new TextRun({ text: w.text + " ", font: "Arial", size: bodySize * 2, color: "182433" })]
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

function groupWordsForWordExport(analysis, shift, mode) {
  const state = { verse: 0, lastKind: "" };
  const groups = [];
  let current = null;

  function flush() {
    if (current && current.words.length) groups.push(current);
    current = null;
  }

  for (const line of analysis.lines || []) {
    const label = normalizeExportSection(line.section, state);
    const words = (line.words || []).filter(function(w) {
      return String(w && w.text || "").trim();
    }).map(function(w) {
      return {
        text: String(w.text || "").trim(),
        chord: w.chord ? transformChord(w.chord, shift, mode) : "",
        start: Number(w.start) || 0,
        end: Number(w.end) || Number(w.start) || 0
      };
    });

    if (!words.length) {
      if (label === "מעבר") {
        flush();
        groups.push({ section: "מעבר", words: [] });
      }
      continue;
    }

    if (!current || current.section !== label) {
      flush();
      current = { section: label, words: [] };
    }

    current.words.push.apply(current.words, words);

    while (current.words.length > 15) {
      const candidateMin = 10;
      const candidateMax = 15;
      const beat = Number(analysis.bpm) > 0 ? 60 / Number(analysis.bpm) : 0;
      let cut = 12;
      if (beat > 0) {
        let bestScore = Infinity;
        for (let n = candidateMin; n <= candidateMax; n += 1) {
          const word = current.words[n - 1];
          const t = Number(word.end) || Number(word.start) || 0;
          const distanceToBeat = Math.abs(t - Math.round(t / beat) * beat);
          const score = distanceToBeat * 10 + Math.abs(n - 12) * 0.15;
          if (score < bestScore) {
            bestScore = score;
            cut = n;
          }
        }
      }
      groups.push({ section: current.section, words: current.words.splice(0, cut) });
    }
  }

  flush();

  return groups;
}

app.post("/api/separate-vocals",async function(req,res){const access=await requireUploadAccess(req,res,{premiumRequired:true,validateGeminiKey:false});if(access!==true)return;upload.single("audio")(req,res,async function(uploadError){if(uploadError){if(uploadError.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"קובץ ההפרדה גדול מדי (מקסימום 200MB)."});return res.status(400).json({error:"העלאת הקובץ נכשלה: "+String(uploadError.message||uploadError).slice(0,200)});}if(!req.file)return res.status(400).json({error:"לא התקבל קובץ אודיו להפרדה."});try{const bytes=await fs.readFile(req.file.path),audioFile=new File([bytes],path.basename(req.file.originalname||"song-audio"),{type:req.file.mimetype||"audio/mpeg"});if(!process.env.REPLICATE_API_TOKEN)throw new Error("מערכת הפרדת הקול עדיין לא הוגדרה בשרת. חסר REPLICATE_API_TOKEN.");const replicate=new Replicate({auth:process.env.REPLICATE_API_TOKEN}),output=await replicate.run("cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",{input:{audio:audioFile,stem:"vocals",model_name:"htdemucs_ft",shifts:2,overlap:0.25,clip_mode:"rescale",output_format:"mp3",mp3_bitrate:320}});let vocals=output&&((output.vocals)||output.stems&&output.stems.vocals||(Array.isArray(output)?output.find(function(item){return item&&(/vocal/i.test(String(item.name||item.label||""))||/vocal/i.test(String(item)))}):null));let vocalsUrl=typeof vocals==="string"?vocals:vocals&&typeof vocals.url==="function"?String(vocals.url()):vocals&&typeof vocals.url==="string"?vocals.url:vocals&&typeof vocals.href==="string"?vocals.href:"";if(!/^https:\/\//i.test(vocalsUrl))throw new Error("מודל ההפרדה לא החזיר קישור תקין לקובץ קול הזמר. סוג הפלט: "+(Array.isArray(output)?"array":typeof output)+", keys: "+(output&&typeof output==="object"?Object.keys(output).join(","):"none"));res.json({vocalsUrl:vocalsUrl,model:"Demucs htdemucs_ft"});}catch(error){console.error("Vocal separation failed",String(error&&error.stack||error));res.status(502).json({error:"הפרדת הקול נכשלה: "+String(error&&error.message||error).slice(0,300)});}finally{try{await fs.unlink(req.file.path);}catch{}}});});

app.post("/api/export/docx", async function(req, res) {
  try {
    const payload = req.body || {};
    const analysis = payload.analysis;
    const shift = Math.max(-12, Math.min(12, Number(payload.shift) || 0));
    const mode = payload.simplify || "off";
    const fontSize = Math.max(12, Math.min(36, Number(payload.fontSize) || 24));
    if (!analysis) return res.status(400).json({ error: "חסר נתון ניתוח" });

    const key = analysis.key ? transposeChord(analysis.key, shift) : "—";
    const children = [];

    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 80 },
      children: [new TextRun({ text: analysis.title || "דף אקורדים", font: "Arial", bold: true, size: 34, color: "102238" })]
    }));
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 180 },
      children: [new TextRun({
        text: (analysis.artist || "אמן לא זוהה") + " · סולם " + key + (analysis.bpm ? " · " + Math.round(analysis.bpm) + " BPM" : ""),
        font: "Arial", size: 17, color: "667589"
      })]
    }));

    const groups = groupWordsForWordExport(analysis, shift, mode);
    let lastSection = "";
    for (const group of groups) {
      if (group.section && group.section !== lastSection) {
        children.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { before: 140, after: 45 },
          children: [new TextRun({ text: group.section, font: "Arial", bold: true, size: 14, color: "6A839B" })]
        }));
        lastSection = group.section;
      }
      if (group.words.length) {
        children.push(makeWordTable(group.words, fontSize));
      }
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
    const safe = String(analysis.title || "song").replace(/[\\/:*?"<>|]/g, "_") + ".docx";
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
app.listen(port, "0.0.0.0", async function() {
  console.log("Chord Studio listening on " + port);
  if (supabaseReady()) {
    try { await sb("app_accounts?select=account_id&limit=1"); console.log("Supabase persistence check passed"); }
    catch (error) { console.error("Supabase persistence check failed", String(error&&error.message||error)); }
  } else {
    console.warn("Supabase persistence is not configured");
  }
});
