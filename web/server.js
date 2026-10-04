import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";
import Replicate from "replicate";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } from "docx";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, ".uploads");
await fs.mkdir(uploadDir, { recursive: true });

async function convertAudioToWav(inputPath, outputPath) {
  if (!ffmpegPath) throw new Error("FFmpeg לא זמין בסביבת השרת");
  await execFileAsync(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outputPath
  ], { maxBuffer: 1024 * 1024 });
}


const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));

const operations = new Map();
const operationOwners = new Map();
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
const WEEKLY_SONG_LIMIT = 1;
const DAILY_SONG_LIMIT = WEEKLY_SONG_LIMIT;
const PREMIUM_INTRO_AMOUNT = 1500;
const PREMIUM_STANDARD_AMOUNT = 3000;
const PREMIUM_INTRO_SLOTS = 5;
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
function tzParts(date){
 const fmt=new Intl.DateTimeFormat("en-US",{timeZone:APP_TIMEZONE,weekday:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
 const out={};for(const part of fmt.formatToParts(date))if(part.type!=="literal")out[part.type]=part.value;return out;
}
function localCalendarToUtc(year,month,day,hour,minute,second){
 const approx=new Date(Date.UTC(year,month-1,day,hour||0,minute||0,second||0));
 const p=tzParts(approx);
 const localAsUtc=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
 return new Date(approx.getTime()-(localAsUtc-approx.getTime()));
}
function usagePeriodStartKey(date){
 const p=tzParts(date||new Date()),weekdayIndex={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[p.weekday];
 const offset=(weekdayIndex+6)%7;
 const localMidnightAsUtc=new Date(Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day)));
 localMidnightAsUtc.setUTCDate(localMidnightAsUtc.getUTCDate()-offset);
 return localMidnightAsUtc.getUTCFullYear()+"-"+String(localMidnightAsUtc.getUTCMonth()+1).padStart(2,"0")+"-"+String(localMidnightAsUtc.getUTCDate()).padStart(2,"0");
}
function todayKey(){return usagePeriodStartKey(new Date());}
function nextDailyReset(){
 const p=tzParts(new Date());
 const weekdayIndex={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6}[p.weekday];
 const offsetToNextMonday=(8-weekdayIndex)%7||7;
 const base=new Date(Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day)));
 base.setUTCDate(base.getUTCDate()+offsetToNextMonday);
 return localCalendarToUtc(base.getUTCFullYear(),base.getUTCMonth()+1,base.getUTCDate(),0,0,0);
}
function usageReservationKey(id,date){return String(id)+"|"+String(date);}
async function withUsageWriteLock(fn){const p=usageWriteQueue.then(fn,fn);usageWriteQueue=p.catch(function(){});return p;}
async function loadUsageState(){if(usageStateCache)return usageStateCache;if(usageStateLoadPromise)return usageStateLoadPromise;usageStateLoadPromise=(async function(){try{const raw=await fs.readFile(USAGE_STATE_FILE,"utf8"),parsed=JSON.parse(raw);usageStateCache=parsed&&typeof parsed==="object"?parsed:{users:{}};}catch{usageStateCache={users:{}};}if(!usageStateCache.users||typeof usageStateCache.users!=="object")usageStateCache.users={};usageStateLoadPromise=null;return usageStateCache;})();return usageStateLoadPromise;}
async function saveUsageState(){const state=usageStateCache||{users:{}},dir=path.dirname(USAGE_STATE_FILE),tmp=USAGE_STATE_FILE+".tmp-"+process.pid;await fs.mkdir(dir,{recursive:true});await fs.writeFile(tmp,JSON.stringify(state),"utf8");await fs.rename(tmp,USAGE_STATE_FILE);}
async function getDailyUsage(id){
 if(supabaseReady()){
   const rows=await sb("rpc/get_daily_song_usage","POST",{p_account_id:id,p_usage_date:todayKey(),p_daily_limit:DAILY_SONG_LIMIT});
   const row=Array.isArray(rows)?(rows[0]||{}):(rows||{});
   return {date:row.usage_date||todayKey(),used:Number(row.used)||0,reserved:Number(row.reserved)||0,remaining:Math.max(0,Number(row.remaining)||0),resetAt:nextDailyReset().toISOString()};
 }
 return withUsageWriteLock(async function(){const state=await loadUsageState(),date=todayKey(),entry=state.users[id],used=entry&&entry.date===date?Math.max(0,Number(entry.count)||0):0,res=usageReservations.has(usageReservationKey(id,date));return{date:date,used:used,remaining:Math.max(0,DAILY_SONG_LIMIT-used-(res?1:0)),reserved:res?1:0,resetAt:nextDailyReset().toISOString()};});
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
async function storageRequest(pathname,method,body,contentType){
 if(!supabaseReady())throw new Error("Supabase Storage is not configured");
 const base=process.env.SUPABASE_URL.replace(/\/+$/,"");
 const headers={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+process.env.SUPABASE_SERVICE_ROLE_KEY};
 if(contentType)headers["Content-Type"]=contentType;
 const response=await fetch(base+"/storage/v1/"+pathname,{method:method||"GET",headers:headers,body:body});
 const raw=await response.text();
 let data=null;try{data=raw?JSON.parse(raw):null;}catch{}
 if(!response.ok){const message=data&&data.message||data&&data.error||data&&data.statusCode||("Storage HTTP "+response.status);const e=new Error(String(message));e.storageStatus=response.status;throw e;}
 return data;
}
function storagePathSegments(p){return String(p||"").split("/").filter(Boolean).map(encodeURIComponent).join("/");}
async function uploadSongToStorage(accountId,filePath,originalName,mimeType){
 const extension=path.extname(String(originalName||"")).toLowerCase().replace(/[^a-z0-9.]/g,"").slice(0,10);
 const objectPath="songs/"+String(accountId)+"/"+crypto.randomUUID()+extension;
 const bytes=await fs.readFile(filePath);
 await storageRequest("object/"+encodeURIComponent(SONG_STORAGE_BUCKET)+"/"+storagePathSegments(objectPath),"POST",bytes,mimeType||"application/octet-stream");
 return objectPath;
}
async function deleteSongFromStorage(objectPath){
 if(!objectPath||!supabaseReady())return;
 try{await storageRequest("object/"+encodeURIComponent(SONG_STORAGE_BUCKET)+"/"+storagePathSegments(objectPath),"DELETE");}
 catch(error){console.error("Stored song delete failed",String(error&&error.message||error));}
}
async function signSongStoragePath(objectPath,expiresInSeconds){
 if(!objectPath||!supabaseReady())return "";
 const result=await storageRequest("object/sign/"+encodeURIComponent(SONG_STORAGE_BUCKET)+"/"+storagePathSegments(objectPath),"POST",JSON.stringify({expiresIn:Math.max(60,Math.min(86400,Number(expiresInSeconds)||3600))}),"application/json");
 const signed=String(result&&result.signedURL||result&&result.signedUrl||"");
 if(!signed)return "";
 return /^https?:\/\//i.test(signed)?signed:(process.env.SUPABASE_URL.replace(/\/+$/,"")+"/storage/v1"+signed);
}
function isYoutubeUrl(url){
 try{const host=new URL(url).hostname.toLowerCase();return host==="youtube.com"||host==="www.youtube.com"||host==="m.youtube.com"||host==="youtu.be"||host.endsWith(".youtube.com");}catch{return false;}
}
function normalizedHttpUrl(raw){
 try{const u=new URL(String(raw||"").trim());if(u.protocol!=="http:"&&u.protocol!=="https:")return "";u.hash="";return u.href;}catch{return "";}
}
async function saveAnalysisHistory(accountId,analysis,meta){
 const title=String(analysis&&analysis.title||"").trim(),artist=String(analysis&&analysis.artist||"").trim(),durationMs=Number(meta&&meta.durationMs)>0?Math.round(Number(meta.durationMs)):(Number(analysis&&analysis.duration)>0?Math.round(Number(analysis.duration)*1000):null);
 const payload={account_id:accountId,title:title,artist:artist,analysis:analysis,audio_path:meta&&meta.audioPath?String(meta.audioPath):null,original_filename:meta&&meta.originalFilename?String(meta.originalFilename):null,mime_type:meta&&meta.mimeType?String(meta.mimeType):null,file_size:meta&&Number.isFinite(Number(meta.fileSize))?Number(meta.fileSize):null,audio_sha256:meta&&meta.audioSha256?String(meta.audioSha256):null,duration_ms:durationMs,normalized_title:compactSongText(title,false)||null,normalized_artist:compactSongText(artist,false)||null,identity_key:songIdentityKey(title,artist)||null};
 const rows=await sb("analysis_history","POST",payload),row=Array.isArray(rows)?rows[0]:rows;return row&&row.id?String(row.id):"";
}
async function updateAnalysisHistory(id,accountId,analysis){if(!id)return;const clean=cleanAnalysis(analysis),title=String(clean&&clean.title||"").trim(),artist=String(clean&&clean.artist||"").trim();await sb("analysis_history?id=eq."+encodeURIComponent(id)+"&account_id=eq."+encodeURIComponent(accountId),"PATCH",{title:title,artist:artist,analysis:clean,duration_ms:Number(clean&&clean.duration)>0?Math.round(Number(clean.duration)*1000):null,normalized_title:compactSongText(title,false)||null,normalized_artist:compactSongText(artist,false)||null,identity_key:songIdentityKey(title,artist)||null});}
async function stripeRequest(endpoint,method,params){if(!process.env.STRIPE_SECRET_KEY){const e=new Error("Stripe עדיין לא הוגדר בשרת.");e.code="STRIPE_NOT_CONFIGURED";throw e;}let url="https://api.stripe.com"+endpoint;const headers={Authorization:"Bearer "+process.env.STRIPE_SECRET_KEY};let body;if(method==="GET"){const q=params?new URLSearchParams(params).toString():"";if(q)url+="?"+q;}else if(params){headers["Content-Type"]="application/x-www-form-urlencoded";body=new URLSearchParams(params).toString();}const resp=await fetch(url,{method:method||"GET",headers:headers,body:body}),raw=await resp.text();let data=null;try{data=raw?JSON.parse(raw):null;}catch{}if(!resp.ok){const e=new Error(data&&data.error&&data.error.message||"Stripe request failed");e.stripeStatus=resp.status;throw e;}return data;}
async function stripeHasPaidPremium(id){if(!process.env.STRIPE_SECRET_KEY)return false;const safe=String(id).replace(/"/g,'\"'),query='metadata["chord_studio_premium"]:"1" AND metadata["account_id"]:"'+safe+'" AND status:"succeeded" AND currency:"'+PREMIUM_CURRENCY+'" AND amount:'+PREMIUM_AMOUNT,data=await stripeRequest("/v1/payment_intents/search","GET",{query:query,limit:"1"});return Boolean(data&&Array.isArray(data.data)&&data.data.some(function(item){return item&&item.status==="succeeded"&&Number(item.amount)===PREMIUM_AMOUNT&&String(item.currency||"").toLowerCase()===PREMIUM_CURRENCY&&item.metadata&&item.metadata.chord_studio_premium==="1"&&item.metadata.account_id===id;}));}
async function isPremiumSession(session){if(!session)return false;if(session.premium===true)return true;const grants=await loadPremiumGrants();if(grants[normalizeEmail(session.user.email)]===true)return true;if(!process.env.STRIPE_SECRET_KEY)return false;if(session.premiumCheckedAt&&Date.now()-session.premiumCheckedAt<30000)return Boolean(session.premium);try{session.premium=await stripeHasPaidPremium(accountIdForUser(session.user));}catch(e){console.error("Stripe premium check failed",String(e&&e.message||e));session.premium=false;}session.premiumCheckedAt=Date.now();return Boolean(session.premium);}
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 }
});

const MODEL = "gemini-flash-lite-latest";
const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
const LOCAL_AUDIO_ENGINE_URL = String(process.env.LOCAL_AUDIO_ENGINE_URL || "").replace(/\/+$/, "");
const LOCAL_AUDIO_ENGINE_TOKEN = String(process.env.LOCAL_AUDIO_ENGINE_TOKEN || "");
const CHORDINO_ENGINE_TIMEOUT_MS = Math.max(30000, Number(process.env.CHORDINO_ENGINE_TIMEOUT_MS) || 240000);
const CHORDINO_CHUNK_SECONDS = Math.max(20, Math.min(20, Number(process.env.CHORDINO_CHUNK_SECONDS) || 20));
const CHORDINO_CHUNK_OVERLAP_SECONDS = Math.max(4, Math.min(5, Number(process.env.CHORDINO_CHUNK_OVERLAP_SECONDS) || 5));
const CHORDINO_CHUNK_SAMPLE_RATE = Math.max(16000, Math.min(48000, Number(process.env.CHORDINO_CHUNK_SAMPLE_RATE) || 44100));
const INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024; // keep encoded request safely below Gemini audio inline request limit
const SONG_STORAGE_BUCKET = "chord-studio-songs";
const SONG_SEARCH_MODEL = "gemini-flash-lite-latest";
const SONG_DOWNLOADER_URL = "https://ssyt.rip/he/";

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
  "You are the FINAL reconciliation engine inside a professional song-to-chords-and-lyrics editor.",
  "The attached audio is the source of truth. Return ONLY one complete JSON object matching the supplied schema.",
  "This request contains TWO independent evidence streams that must be reconciled:",
  "INPUT A — Gemini 3.5 Transcribe: a complete vocal transcription with word timing information when available. Use it as the primary evidence for lyric wording, repetitions, ad-libs, and vocal timing.",
  "INPUT B — Chordino via Sonic Annotator: an independent chord timeline produced from the audio by the Chordino Vamp plugin. Treat these chord events as independent machine evidence, not as lyric guesses.",
  "Do a final audio-grounded reconciliation. Re-listen mentally to the whole recording from the first audible sample to the final sample. Correct transcription evidence only when the audio clearly supports the correction, and never invent lyrics.",
  "For chords, use the Chordino timeline as the starting evidence. Keep genuine Chordino changes, but correct an obvious Chordino artifact only when the attached audio supports the correction. Do not invent chords from lyrics, song title, key, genre, or a familiar progression.",
  "Return the COMPLETE recording: every verse, chorus, bridge, repeated section, vocal ad-lib, intro/outro vocal, and every meaningful chord event across lyric-free transitions, interludes, turnarounds, intros and outros.",
  "Preserve word-level start and end seconds on the original audio timeline. Keep all events chronological and within the true audio duration.",
  "For Hebrew, preserve the exact sung words and only add niqqud when pronunciation is clearly supported by the audio. Keep natural punctuation only when supported by phrasing.",
  "Determine the overall key, BPM and capo when supported by the audio. Capo must be an integer 0–12, or null only when genuinely uncertain.",
  "Chord display rule: place a chord anchor only once at the first suitable word at or immediately after the harmonic change; sustained chords should not be repeated above every word. If a chord returns after a different chord, anchor it again. Keep the COMPLETE independent chord timeline in the chords array even when no lyrics are present.",
  "Use standard chord names such as Bb, F#m7, Cmaj7 and G/B. Prefer a simpler supported chord over an unsupported extension or slash chord.",
  "Confidence must be a number from 0 to 1 and should reflect the acoustic certainty of the final result.",
  "Never summarize or stop early because of output length. Complete chronological coverage is mandatory."
].join("\n");

const VERIFY_PREFIX = [
  "You are the second, independent verification pass for a professional chord-and-lyrics extraction system.",
  "The attached audio is the source of truth.",
  "Audit the candidate JSON below and return the COMPLETE corrected object using the supplied schema.",
  "",
  "Correct lyric words, Hebrew niqqud/punctuation, or timestamps that do not match the audio.",
  "For Hebrew, keep vowel-point niqqud according to the sung pronunciation when it is confidently supported by what is heard; do not invent niqqud. Preserve natural punctuation when supported by phrasing.",
  "Verify the capo position too: return capo as an integer from 0 to 12, use 0 when no capo is used, and null only when uncertain. Do not confuse capo position with song key. Re-derive every chord from the audio rather than accepting the candidate label. For each event, check audible root, chord quality, bass note/inversion, and exact change time; do not infer from key, lyrics, genre, or a familiar progression. Distinguish melody and passing bass notes from stable chord tones. Keep extensions and slash chords only when their defining notes are clearly audible; otherwise simplify to the best-supported chord and lower confidence. Infer meter and harmonic rhythm from the recording; in regular 4/4 use a chord per measure only if it sustains that long, and preserve clearly audible changes within a measure.",
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

const SONG_NOISE_WORDS=new Set(["official","video","music","audio","lyrics","lyric","visualizer","remix","version","edit","live","cover","קליפ","רשמי","מילים","אודיו","וידאו","הופעה","לייב","קאבר","גרסה","רמיקס","מיקס","סינגל"]);
function compactSongText(value,stripNoise){
  let s=String(value||"").normalize("NFKC").toLowerCase().replace(/[’'״׳]/g,"");
  s=s.replace(/\.(mp3|wav|m4a|flac|ogg|aac|opus)$/i," ").replace(/[()[\]{}]/g," ").replace(/[._]+/g," ").replace(/\b(?:track|trk|song)\s*\d+\b/gi," ").replace(/^\s*\d{1,3}\s*[-.)_]+\s*/u," ");
  const fm={"ך":"כ","ם":"מ","ן":"נ","ף":"פ","ץ":"צ"};s=Array.from(s).map(ch=>fm[ch]||ch).join("");
  let t=s.match(/[\p{L}\p{N}]+/gu)||[];if(stripNoise)t=t.filter(x=>!SONG_NOISE_WORDS.has(x));return t.join("");
}
function songSimilarity(a,b){
  const aa=compactSongText(a,false),bb=compactSongText(b,false);if(!aa||!bb)return 0;if(aa===bb)return 1;
  if(aa.includes(bb)||bb.includes(aa))return .9;
  const prev=new Array(bb.length+1),cur=new Array(bb.length+1);for(let j=0;j<=bb.length;j++)prev[j]=j;
  for(let i=1;i<=aa.length;i++){cur[0]=i;for(let j=1;j<=bb.length;j++){const cost=aa[i-1]===bb[j-1]?0:1;cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+cost)}for(let j=0;j<=bb.length;j++)prev[j]=cur[j]}
  return 1-prev[bb.length]/Math.max(aa.length,bb.length);
}
function songIdentityKey(title,artist){return [compactSongText(title,false),compactSongText(artist,false)].filter(Boolean).sort().join("|");}
function songCandidates(filename,meta){
  const out=[],seen=new Set(),add=(title,artist,source)=>{title=String(title||"").trim();artist=String(artist||"").trim();if(!title&&!artist)return;const k=source+"|"+compactSongText(title,true)+"|"+compactSongText(artist,true);if(seen.has(k))return;seen.add(k);out.push({title,artist,source});};
  const mt=String(meta&&meta.title||"").trim(),ma=String(meta&&(meta.artist||meta.albumArtist)||"").trim();if(mt||ma){add(mt,ma,"tags");if(mt&&ma)add(ma,mt,"tags");}
  const stem=filenameHint(filename).replace(/\.(mp3|wav|m4a|flac|ogg|aac|opus)$/i,"");
  const parts=stem.split(/\s+(?:-|–|—|\|)\s+|\s*\|\s*/u).map(x=>String(x||"").trim()).filter(Boolean);
  if(parts.length>=2){const a=parts[0],b=parts.slice(1).join(" ");add(b,a,"filename");add(a,b,"filename");}
  const cleaned=parts.join(" ").trim();if(cleaned)add(cleaned,"","filename");
  return out;
}
function scoreSongCandidate(input,row,duration){
  const rt=String(row&&row.title||"").trim(),ra=String(row&&row.artist||"").trim();if(!rt&&!ra)return {score:0,method:""};
  const it=String(input&&input.title||"").trim(),ia=String(input&&input.artist||"").trim(),ts=songSimilarity(it,rt),as=songSimilarity(ia,ra);
  let score=0,method="";
  if(it&&ia&&rt&&ra){score=ts*.74+as*.26;method=ts>=.9&&as>=.9?"התאמה לשם השיר ולאמן":"התאמה חכמה לשיר ולאמן";}
  else if(it&&rt){score=ts*.94;method="התאמה לשם השיר";}
  const rd=Number(row&&row.duration_ms)>0?Number(row.duration_ms)/1000:0;
  if(duration>0&&rd>0){const d=Math.abs(duration-rd);if(d<=2)score+=.06;else if(d<=5)score+=.035;else if(d<=10)score+=.015;else if(d>=45)score-=.06;}
  if(it&&ia&&songIdentityKey(it,ia)===songIdentityKey(rt,ra)){score=Math.max(score,.97);method="התאמה מלאה לשיר ולאמן, גם אם הסדר הוחלף";}
  return {score:Math.max(0,Math.min(1,score)),method};
}
async function findReusableSongMatches(options){
  if(!supabaseReady())return [];
  const o=options||{},inputs=songCandidates(o.filename,o.audioMetadata||{}),duration=Number(o.durationSeconds)||0,hash=String(o.audioSha256||"");
  const rows=[],add=page=>{for(const row of Array.isArray(page)?page:[])if(row&&row.id)rows.push(row)};
  if(hash)add(await sb("analysis_history?select=id,title,artist,original_filename,audio_sha256,duration_ms,normalized_title,normalized_artist,identity_key,created_at&audio_sha256=eq."+encodeURIComponent(hash)+"&order=created_at.desc&limit=20"));
  if(!rows.length){let offset=0;while(true){const page=await sb("analysis_history?select=id,title,artist,original_filename,audio_sha256,duration_ms,normalized_title,normalized_artist,identity_key,created_at&order=created_at.desc&limit=1000&offset="+offset);add(page);if(!Array.isArray(page)||page.length<1000)break;offset+=1000;}}
  const matches=[];
  for(const row of rows){
    let best={score:0,method:""};
    if(hash&&String(row.audio_sha256||"")===hash)best={score:1,method:"זהה לקובץ שכבר נותח"};
    for(const input of inputs){const s=scoreSongCandidate(input,row,duration);if(s.score>best.score)best=s;}
    if(best.score>=.86)matches.push({id:String(row.id),title:String(row.title||"").trim()||"שיר ללא שם",artist:String(row.artist||"").trim()||"אמן לא ידוע",duration:Number(row.duration_ms)>0?Number(row.duration_ms)/1000:0,score:best.score,method:best.method||"התאמה חכמה"});
  }
  matches.sort((a,b)=>b.score-a.score||Math.abs((a.duration||0)-duration)-Math.abs((b.duration||0)-duration));
  return matches.slice(0,5);
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
      year: common.year ? Number(common.year) : null,
      duration: Number(metadata && metadata.format && metadata.format.duration) > 0 ? Number(metadata.format.duration) : 0
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

function collapseAdjacentChordEvents(chords, maxGapSeconds) {
  const maxGap = Math.max(0, Number(maxGapSeconds) || 0.9);
  const sorted = (Array.isArray(chords) ? chords : [])
    .map(function(c) {
      return {
        start: Math.max(0, Number(c && c.start) || 0),
        end: Math.max(0, Number(c && c.end) || 0),
        chord: String(c && c.chord || "").trim(),
        confidence: Math.max(0, Math.min(1, Number(c && c.confidence) || 0))
      };
    })
    .filter(function(c) {
      return c.chord && c.end > c.start;
    })
    .sort(function(a, b) {
      return a.start - b.start;
    });

  // Ignore a very brief isolated Chordino blip when it is surrounded by the same chord.
  // This removes obvious one-frame misclassifications without rewriting real chord changes.
  const stable = sorted.filter(function(current, index, events) {
    if (current.end - current.start >= 0.32 || index === 0 || index === events.length - 1) return true;
    const previous = events[index - 1], next = events[index + 1];
    return !(previous.chord === next.chord && current.start - previous.end <= 0.25 && next.start - current.end <= 0.25);
  });
  const merged = [];
  for (const current of stable) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.chord === current.chord &&
      current.start <= previous.end + maxGap
    ) {
      previous.end = Math.max(previous.end, current.end);
      previous.confidence = Math.max(previous.confidence, current.confidence);
      continue;
    }
    merged.push(current);
  }
  return merged;
}

function quantizeChordsToFourBeats(chords, bpm, duration) {
  const rawTempo = Number(bpm);
  const tempo = Number.isFinite(rawTempo) && rawTempo >= 40 && rawTempo <= 240 ? rawTempo : 120;
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return [];
  const barSeconds = 4 * 60 / tempo;
  const events = collapseAdjacentChordEvents(Array.isArray(chords) ? chords : [], 0.08);
  const bars = [];
  for (let start = 0; start < total; start += barSeconds) {
    const end = Math.min(total, start + barSeconds);
    const weights = new Map();
    for (const event of events) {
      const overlap = Math.max(0, Math.min(end, Number(event.end) || 0) - Math.max(start, Number(event.start) || 0));
      if (overlap > 0) weights.set(event.chord, (weights.get(event.chord) || 0) + overlap);
    }
    if (!weights.size) continue;
    let selected = "";
    let selectedWeight = -1;
    for (const [chord, weight] of weights) {
      if (weight > selectedWeight) { selected = chord; selectedWeight = weight; }
    }
    if (!selected) continue;
    const previous = bars[bars.length - 1];
    if (previous && previous.chord === selected && Math.abs(previous.end - start) < 0.001) {
      previous.end = end;
    } else {
      bars.push({ start, end, chord: selected, confidence: 0.8 });
    }
  }
  return bars;
}

function placeChordAnchors(lines, chords) {
  (lines || []).forEach(function(line) {
    (line.words || []).forEach(function(word) {
      word.chord = null;
      word.chordOffset = null;
    });
  });

  const allWords = [];
  (lines || []).forEach(function(line) {
    (line.words || []).forEach(function(word, index) {
      const start = Number(word.start);
      const end = Number(word.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      allWords.push({word:word,line:line,index:index,start:start,end:Math.max(start,end)});
    });
  });
  allWords.sort(function(a,b){return a.start-b.start || a.index-b.index;});

  const used = new Set();
  const events = (Array.isArray(chords) ? chords : []).slice().sort(function(a,b){
    return Number(a.start)-Number(b.start);
  });

  for (const chord of events) {
    const start = Number(chord.start);
    if (!Number.isFinite(start)) continue;

    let best = null;
    let bestDistance = Infinity;

    // 1) Prefer the lyric word whose own start is closest to the real chord change.
    for (const item of allWords) {
      if (used.has(item.word)) continue;
      const distance = Math.abs(item.start-start);
      if (distance <= 0.42 && distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }

    // 2) If the harmonic change happens inside a sung word, keep that word.
    if (!best) {
      for (const item of allWords) {
        if (used.has(item.word)) continue;
        if (item.start <= start && start < item.end) {
          best = item;
          break;
        }
      }
    }

    // 3) Otherwise use the first following lyric word, but only across a short
    // gap so instrumental transitions do not steal the next section's first word.
    if (!best) {
      for (const item of allWords) {
        if (used.has(item.word)) continue;
        if (item.start >= start && item.start-start <= 1.20) {
          best = item;
          break;
        }
        if (item.start > start+1.20) break;
      }
    }

    if (!best) continue;

    best.word.chord = String(chord.chord || "").trim() || null;
    if (best.word.chord) used.add(best.word);
  }
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

  const outChords = collapseAdjacentChordEvents(chords);

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

app.get("/api/health",function(_req,res){res.json({
  ok:true,
  model:MODEL,
  transcriptionModel:TRANSCRIBE_MODEL,
  auth:"google-and-email-password",
  googleOAuthConfigured:Boolean(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET),
  stripeConfigured:Boolean(process.env.STRIPE_SECRET_KEY),
  chordinoConfigured:Boolean(LOCAL_AUDIO_ENGINE_URL&&LOCAL_AUDIO_ENGINE_TOKEN),
  chordinoEngine:LOCAL_AUDIO_ENGINE_URL||"",
  replicateConfigured:Boolean(process.env.REPLICATE_API_TOKEN),
  supabaseConfigured:supabaseReady(),
  persistence:supabaseReady()?"supabase":"local-fallback",
  apiKeyRequired:true,
  weeklyLimit:WEEKLY_SONG_LIMIT
});});

app.get("/auth/google",function(_req,res){if(!requireGoogleOAuth(res))return;const state=crypto.randomBytes(24).toString("hex");oauthStates.set(state,Date.now());const params=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:APP_URL+"/auth/google/callback",response_type:"code",scope:OAUTH_SCOPES,state:state});res.redirect("https://accounts.google.com/o/oauth2/v2/auth?"+params.toString());});
app.get("/auth/google/callback",async function(req,res){const state=String(req.query.state||""),code=String(req.query.code||""),created=oauthStates.get(state);oauthStates.delete(state);if(!created||Date.now()-created>10*60*1000||!code)return res.status(400).send("Google authentication state expired or invalid");try{const tokenRes=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code:code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:APP_URL+"/auth/google/callback",grant_type:"authorization_code"})}),tokens=await tokenRes.json();if(!tokenRes.ok||!tokens.access_token)throw new Error(tokens.error_description||"Google token exchange failed");const userRes=await fetch("https://www.googleapis.com/oauth2/v3/userinfo",{headers:{Authorization:"Bearer "+tokens.access_token}}),user=await userRes.json();if(!userRes.ok||!user.sub||user.email_verified!==true)throw new Error("Google user info failed or email is not verified");const sessionId=crypto.randomBytes(32).toString("hex"),userData={id:String(user.sub),name:user.name||user.email||"Google user",email:normalizeEmail(user.email),picture:user.picture||""};if(supabaseReady()){const accountId=await ensureAccount(userData);userData.accountId=accountId;await sb("auth_sessions","POST",{token_hash:tokenHash(sessionId),account_id:accountId,expires_at:new Date(Date.now()+2592000000).toISOString()});}else{sessions.set(sessionId,{user:userData,premium:false,premiumCheckedAt:0,createdAt:Date.now()});}setSessionCookie(res,sessionId);res.redirect("/");}catch(error){console.error(error);res.status(500).send("Google authentication failed");}});
app.post("/api/auth/register",async function(req,res){
  const name=String(req.body&&req.body.name||"").trim();
  const email=normalizeEmail(req.body&&req.body.email);
  const password=String(req.body&&req.body.password||"");
  if(name.length<2||name.length>80)return res.status(400).json({error:"השם חייב להכיל בין 2 ל־80 תווים"});
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:"כתובת האימייל לא תקינה"});
  if(password.length<8||password.length>200)return res.status(400).json({error:"הסיסמה חייבת להכיל בין 8 ל־200 תווים"});
  if(!supabaseReady())return res.status(503).json({error:"שמירת חשבונות דורשת חיבור למסד הנתונים"});
  let createdAccount=false;
  let updatedExisting=false;
  let existingSnapshot=null;
  let accountId="";
  try{
    const exists=await sb("app_accounts?select=account_id,auth_provider,password_hash,display_name&email=eq."+encodeURIComponent(email)+"&limit=1");
    const salt=crypto.randomBytes(16).toString("hex");
    const hash=crypto.scryptSync(password,salt,64).toString("hex");
    const passwordHash="scrypt$"+salt+"$"+hash;

    if(exists.length){
      const existing=exists[0];
      accountId=String(existing.account_id||"");
      if(existing.password_hash){
        return res.status(409).json({error:"כבר קיים חשבון עם כתובת האימייל הזו. נסה להתחבר"});
      }
      existingSnapshot={display_name:existing.display_name,auth_provider:existing.auth_provider,password_hash:existing.password_hash};
      await sb("app_accounts?account_id=eq."+encodeURIComponent(accountId),"PATCH",{
        display_name:name,
        password_hash:passwordHash,
        auth_provider:"google-and-email",
        updated_at:new Date().toISOString()
      });
      updatedExisting=true;
    }else{
      accountId=accountIdForUser({email});
      await sb("app_accounts","POST",{
        account_id:accountId,
        email,
        display_name:name,
        password_hash:passwordHash,
        auth_provider:"email",
        is_admin:email===ADMIN_EMAIL,
        premium_granted:false
      });
      createdAccount=true;
    }

    const token=crypto.randomBytes(32).toString("hex");
    try{
      await sb("auth_sessions","POST",{
        token_hash:tokenHash(token),
        account_id:accountId,
        expires_at:new Date(Date.now()+2592000000).toISOString()
      });
    }catch(sessionError){
      if(createdAccount){
        try{await sb("app_accounts?account_id=eq."+encodeURIComponent(accountId),"DELETE");}catch(rollbackError){console.error("Account registration rollback failed",String(rollbackError.message||rollbackError));}
      }else if(updatedExisting&&existingSnapshot){
        try{await sb("app_accounts?account_id=eq."+encodeURIComponent(accountId),"PATCH",{
          display_name:existingSnapshot.display_name,
          password_hash:existingSnapshot.password_hash,
          auth_provider:existingSnapshot.auth_provider,
          updated_at:new Date().toISOString()
        });}catch(rollbackError){console.error("Existing account password rollback failed",String(rollbackError.message||rollbackError));}
      }
      throw sessionError;
    }

    setSessionCookie(res,token);
    res.json({ok:true});
  }catch(error){
    console.error("Account registration failed",String(error&&error.stack||error));
    res.status(500).json({error:"לא הצלחנו ליצור חשבון כרגע. נסה שוב בעוד רגע"});
  }
});
app.post("/api/auth/login",async function(req,res){
  const email=normalizeEmail(req.body&&req.body.email);
  const password=String(req.body&&req.body.password||"");
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:"כתובת האימייל לא תקינה"});
  if(!password)return res.status(400).json({error:"יש להזין סיסמה"});
  if(!supabaseReady())return res.status(503).json({error:"שמירת חשבונות דורשת חיבור למסד הנתונים"});
  try{
    const rows=await sb("app_accounts?select=account_id,email,display_name,password_hash,auth_provider&email=eq."+encodeURIComponent(email)+"&limit=1");
    const account=rows[0];
    if(!account)return res.status(401).json({error:"לא נמצא חשבון עם כתובת האימייל הזו"});
    if(!account.password_hash){
      if(String(account.auth_provider||"")==="google"){
        return res.status(409).json({error:"החשבון הזה נוצר באמצעות Google. פתח הרשמה עם אותה כתובת כדי להגדיר גם סיסמה, או היכנס באמצעות Google"});
      }
      return res.status(401).json({error:"לא הוגדרה סיסמה לחשבון הזה"});
    }
    const parts=String(account.password_hash).split("$");
    if(parts.length!==3||parts[0]!=="scrypt")return res.status(500).json({error:"מבנה הסיסמה בחשבון אינו תקין"});
    const candidate=crypto.scryptSync(password,parts[1],64);
    const stored=Buffer.from(parts[2],"hex");
    if(stored.length!==candidate.length||!crypto.timingSafeEqual(stored,candidate))return res.status(401).json({error:"האימייל או הסיסמה שגויים"});
    const token=crypto.randomBytes(32).toString("hex");
    await sb("auth_sessions","POST",{token_hash:tokenHash(token),account_id:account.account_id,expires_at:new Date(Date.now()+2592000000).toISOString()});
    setSessionCookie(res,token);
    res.json({ok:true});
  }catch(error){
    console.error("Account login failed",String(error&&error.stack||error));
    res.status(500).json({error:"לא הצלחנו להתחבר כרגע"});
  }
});
app.get("/api/auth/me",async function(req,res){
 try{
   const session=await authSession(req);
   if(!session)return res.set("Cache-Control","no-store").json({authenticated:false,premium:false,plan:"standard",weeklyRemaining:null,weeklyUsed:null,weeklyResetAt:null,dailyRemaining:null,dailyUsed:null,dailyResetAt:null,paymentConfigured:Boolean(process.env.STRIPE_SECRET_KEY),apiKeyRequired:true});
   const premium=await isPremiumSession(session),usage=premium?{remaining:null,used:null}:{};
   if(!premium)Object.assign(usage,await getDailyUsage(accountIdForUser(session.user)));
   return res.set("Cache-Control","no-store").json({
     authenticated:true,user:session.user,isAdmin:normalizeEmail(session.user.email)===ADMIN_EMAIL,
     premium:premium,plan:premium?"premium":"standard",
     weeklyRemaining:usage.remaining,weeklyUsed:usage.used,weeklyResetAt:premium?null:usage.resetAt,
     dailyRemaining:usage.remaining,dailyUsed:usage.used,dailyResetAt:premium?null:usage.resetAt,
     paymentConfigured:Boolean(process.env.STRIPE_SECRET_KEY),apiKeyRequired:true
   });
 }catch(error){
   console.error("Account status lookup failed",String(error&&error.message||error));
   return res.status(503).json({error:"לא ניתן לטעון את מצב החשבון כרגע"});
 }
});
app.get("/api/admin/users",async function(req,res){const session=await authSession(req);if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});try{const grants=await loadPremiumGrants();res.json({users:Object.keys(grants).filter(id=>grants[id]===true)});}catch(error){console.error(error);res.status(503).json({error:"לא ניתן לטעון את רשימת הרשאות Premium"});}});
app.post("/api/admin/premium",async function(req,res){const session=await authSession(req);if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});const email=normalizeEmail(req.body&&req.body.email),enabled=Boolean(req.body&&req.body.enabled);if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:"כתובת אימייל לא תקינה"});if(supabaseReady()){await sb("premium_grants?on_conflict=email","POST",{email:email,granted:enabled,updated_at:new Date().toISOString()});const account=await sb("app_accounts?select=account_id&email=eq."+encodeURIComponent(email)+"&limit=1");if(account.length)await sb("app_accounts?email=eq."+encodeURIComponent(email),"PATCH",{premium_granted:enabled,updated_at:new Date().toISOString()});}else{const grants=await loadPremiumGrants();if(enabled)grants[email]=true;else delete grants[email];await savePremiumGrants();}res.json({ok:true,email:email,premium:enabled});});
app.post("/api/messages",async function(req,res){
 const session=await authSession(req);
 if(!session)return res.status(401).json({error:"יש להתחבר לחשבון לפני שליחת הודעה למפתח"});
 const message=String(req.body&&req.body.message||"").trim();
 const source=String(req.body&&req.body.source||"contact").trim()==="premium"?"premium":"contact";
 if(message.length<2)return res.status(400).json({error:"יש לכתוב הודעה לפני השליחה"});
 if(message.length>5000)return res.status(400).json({error:"ההודעה ארוכה מדי"});
 try{
   const accountId=accountIdForUser(session.user);
   const email=normalizeEmail(session.user.email);
   const displayName=String(session.user.name||email).trim()||email;
   if(supabaseReady()){
     const rows=await sb("developer_messages","POST",{account_id:accountId,display_name:displayName,email:email,message:message,source:source,created_at:new Date().toISOString()});
     const row=Array.isArray(rows)&&rows[0]?rows[0]:null;
     return res.set("Cache-Control","no-store").json({ok:true,message:row?{id:row.id,display_name:row.display_name,email:row.email,message:row.message,source:row.source,created_at:row.created_at}:null});
   }
   return res.status(503).json({error:"שמירת הודעות דורשת חיבור למסד הנתונים"});
 }catch(error){
   console.error("Developer message send failed",String(error&&error.stack||error));
   return res.status(500).json({error:"שליחת ההודעה נכשלה כרגע"});
 } 
});
app.get("/api/admin/messages",async function(req,res){
 const session=await authSession(req);
 if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});
 if(!supabaseReady())return res.json({messages:[]});
 try{
   const rows=await sb("developer_messages?select=id,display_name,email,message,source,created_at&order=created_at.desc&limit=1000");
   return res.set("Cache-Control","no-store").json({messages:Array.isArray(rows)?rows:[]});
 }catch(error){
   console.error("Developer messages load failed",String(error&&error.stack||error));
   return res.status(503).json({error:"לא ניתן לטעון את ההודעות כרגע"});
 }
});
app.get("/api/history",async function(req,res){
 const session=await authSession(req);if(!session)return res.status(401).json({error:"לא מחובר"});
 if(!supabaseReady())return res.json({history:[]});
 try{
  const accountId=accountIdForUser(session.user);
  const rows=await sb("analysis_history?select=id,title,artist,analysis,created_at,audio_path,original_filename,mime_type,file_size&account_id=eq."+encodeURIComponent(accountId)+"&order=created_at.desc&limit=1000");
  const history=await Promise.all((rows||[]).map(async function(row){
   let audioUrl="";
   try{audioUrl=row.audio_path?await signSongStoragePath(row.audio_path,3600):"";}catch{}
   return Object.assign({},row,{audioUrl:audioUrl});
  }));
  res.setHeader("Cache-Control","no-store");res.json({history:history});
 }catch(error){console.error(error);res.status(503).json({error:"לא ניתן לטעון את השירים השמורים"});}
});
app.put("/api/history/:id",async function(req,res){
 const session=await authSession(req);if(!session)return res.status(401).json({error:"לא מחובר"});
 const id=String(req.params.id||"").trim();
 if(!/^[0-9a-f-]{20,80}$/i.test(id))return res.status(400).json({error:"מזהה שיר לא תקין"});
 const analysis=req.body&&req.body.analysis;
 if(!analysis||typeof analysis!=="object")return res.status(400).json({error:"חסר ניתוח לשמירה"});
 try{
  await updateAnalysisHistory(id,accountIdForUser(session.user),cleanAnalysis(analysis));
  res.setHeader("Cache-Control","no-store");res.json({ok:true});
 }catch(error){console.error("Auto-save history failed",String(error&&error.message||error));res.status(500).json({error:"שמירת השינויים נכשלה"});}
});
app.post("/api/search-song",async function(req,res){
 const session=await authSession(req);
 if(!session)return res.status(401).json({error:"יש להתחבר לחשבון לפני חיפוש שיר"});
 const apiKey=String(req.headers["x-gemini-api-key"]||"").trim();
 if(!apiKey)return res.status(401).json({error:"יש להזין מפתח Gemini API לפני חיפוש"});
 const artist=String(req.body&&req.body.artist||"").trim();
 const title=String(req.body&&req.body.title||"").trim();
 const details=String(req.body&&req.body.details||"").trim();
 if(artist.length<2||title.length<2)return res.status(400).json({error:"יש להזין את השם המלא של הזמר ואת השם המלא של השיר"});
 const prompt=[
  "Find the exact song requested below on the public web using Google Search grounding.",
  "The user needs one precise playable URL for the exact song, ideally the exact YouTube video.",
  "Artist full name: "+artist,
  "Song full title: "+title,
  "Additional optional details: "+(details||"none"),
  "Search broadly and verify that the selected result matches BOTH artist and song title.",
  "Never invent, guess, or synthesize a URL.",
  "Return ONLY JSON: found, artist, title, url, sourceTitle, note.",
  "The url MUST be one of the URLs returned by Google Search grounding. If no exact verified result exists, found=false and url is empty.",
  "Prefer a single exact YouTube video over playlists, artist homepages, search pages, lyrics pages, or unrelated covers."
 ].join("\n");
 try{
  const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(SONG_SEARCH_MODEL)+":generateContent",{
   method:"POST",
   headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
   body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{temperature:0.1}})
  });
  const raw=await response.text();
  let data={};
  try{data=raw?JSON.parse(raw):{};}catch{return res.status(502).json({error:"חיפוש השיר החזיר תשובה לא תקינה"});}
  if(!response.ok){
   const message=data&&data.error&&data.error.message||"חיפוש Google דרך Gemini נכשל";
   return res.status(response.status===429?429:502).json({error:message});
  }
  const candidate=data.candidates&&data.candidates[0]||{};
  const parts=candidate.content&&candidate.content.parts||[];
  const output=parts.map(function(part){return part&&part.text||"";}).join("").trim();
  let parsed=null;
  try{parsed=JSON.parse(output);}catch{
   try{parsed=JSON.parse(output.replace(/^\\s*json\\s*/i,"").replace(/\\s*$/i,""));}catch{}
  }
  if(!parsed||typeof parsed!=="object")throw new Error("Gemini לא החזיר תוצאת חיפוש תקינה");
  const gm=candidate.groundingMetadata||candidate.grounding_metadata||{};
  const chunks=Array.isArray(gm.groundingChunks)?gm.groundingChunks:Array.isArray(gm.grounding_chunks)?gm.grounding_chunks:[];
  const groundedCandidates=chunks.map(function(chunk){
    return {url:normalizedHttpUrl(chunk&&chunk.web&&chunk.web.uri||""),title:String(chunk&&chunk.web&&chunk.web.title||""),text:String(chunk&&chunk.web&&chunk.web.text||"")};
  }).filter(function(item){return Boolean(item.url);});
  const groundedUrls=groundedCandidates.map(function(item){return item.url;});
  const returnedUrl=normalizedHttpUrl(parsed.url||"");
  let exact=groundedUrls.find(function(u){return u===returnedUrl;});
  if(!exact&&returnedUrl)exact=groundedUrls.find(function(u){return u.replace(/\/$/,"")===returnedUrl.replace(/\/$/,"");})||"";
  if(!exact){
    const needle=(artist+" "+title).toLowerCase().replace(/[^a-z0-9א-ת]+/g," ").trim().split(/\s+/).filter(function(x){return x.length>=2;});
    const matched=groundedCandidates.find(function(item){
      const hay=(item.title+" "+item.text).toLowerCase();
      return needle.length>0&&needle.every(function(word){return hay.indexOf(word)>=0;});
    });
    if(matched)exact=matched.url;
  }
  if(!exact)exact=groundedCandidates.find(function(item){return isYoutubeUrl(item.url);})?.url||"";
  if(!exact||parsed.found===false){
   return res.json({found:false,artist:String(parsed.artist||artist),title:String(parsed.title||title),url:"",sourceTitle:String(parsed.sourceTitle||""),note:String(parsed.note||"לא נמצא קישור מדויק ומאומת.")});
  }
  return res.json({found:true,artist:String(parsed.artist||artist),title:String(parsed.title||title),url:exact,sourceTitle:String(parsed.sourceTitle||""),note:String(parsed.note||""),downloaderUrl:SONG_DOWNLOADER_URL});
 }catch(error){
  console.error("Song search failed",String(error&&error.stack||error));
  res.status(502).json({error:"חיפוש השיר נכשל: "+String(error&&error.message||error).slice(0,300)});
 }
});
app.post("/api/auth/logout",async function(req,res){const token=cookieToken(req);if(token){sessions.delete(token);if(supabaseReady())try{await sb("auth_sessions?token_hash=eq."+tokenHash(token),"DELETE");}catch(e){console.error("Session revoke failed",String(e.message||e));}}clearSessionCookie(res);res.json({ok:true});});
let premiumOfferCache=null;
let premiumOfferCacheAt=0;
async function getPremiumSalesCount(){
 if(!process.env.STRIPE_SECRET_KEY)return 0;
 try{
   const data=await stripeRequest("/v1/payment_intents/search","GET",{query:'metadata["chord_studio_premium"]:"1" AND status:"succeeded" AND currency:"'+PREMIUM_CURRENCY+'"',limit:String(PREMIUM_INTRO_SLOTS)});
   return Math.min(PREMIUM_INTRO_SLOTS,Array.isArray(data&&data.data)?data.data.length:0);
 }catch(error){
   console.error("Premium sales count failed",String(error&&error.message||error));
   return 0;
 }
}
async function getPremiumOffer(){
 const now=Date.now();
 if(premiumOfferCache&&now-premiumOfferCacheAt<15000)return premiumOfferCache;
 const sales=await getPremiumSalesCount();
 const introRemaining=Math.max(0,PREMIUM_INTRO_SLOTS-sales);
 premiumOfferCache={sold:sales,introRemaining:introRemaining,priceAmount:introRemaining>0?PREMIUM_INTRO_AMOUNT:PREMIUM_STANDARD_AMOUNT,priceAfterAmount:PREMIUM_STANDARD_AMOUNT};
 premiumOfferCacheAt=now;
 return premiumOfferCache;
}
app.get("/api/premium/info",async function(_req,res){
 try{
   const offer=await getPremiumOffer();
   res.setHeader("Cache-Control","no-store");
   res.json({configured:Boolean(process.env.STRIPE_SECRET_KEY),sold:offer.sold,introRemaining:offer.introRemaining,priceAmount:offer.priceAmount,priceText:(offer.priceAmount/100).toFixed(0)+" ₪",standardPriceAmount:PREMIUM_STANDARD_AMOUNT,standardPriceText:(PREMIUM_STANDARD_AMOUNT/100).toFixed(0)+" ₪",introSlots:PREMIUM_INTRO_SLOTS,lifetime:true});
 }catch(error){
   res.status(503).json({configured:false,error:"לא ניתן לטעון את מחיר Premium כרגע"});
 }
});
app.post("/api/premium/checkout",async function(req,res){
 const session=await authSession(req);
 if(!session)return res.status(401).json({error:"יש להתחבר לחשבון לפני רכישת Premium."});
 const accountId=accountIdForUser(session.user);
 if(await isPremiumSession(session))return res.json({alreadyPremium:true});
 if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:"מערכת התשלום עדיין לא הוגדרה בשרת."});
 try{
   const offer=await getPremiumOffer();
   const amount=offer.priceAmount;
   const checkout=await stripeRequest("/v1/checkout/sessions","POST",{
     mode:"payment",locale:"he",
     success_url:APP_URL+"/?premium=success&session_id={CHECKOUT_SESSION_ID}",
     cancel_url:APP_URL+"/?premium=cancel",
     customer_email:normalizeEmail(session.user.email),
     client_reference_id:accountId,
     "line_items[0][price_data][currency]":PREMIUM_CURRENCY,
     "line_items[0][price_data][product_data][name]":PREMIUM_PRODUCT_NAME,
     "line_items[0][price_data][product_data][description]":"Premium חד־פעמי לכל החיים / עד שהאתר ייסגר. 5 הראשונים במחיר השקה, לאחר מכן המחיר עולה.",
     "line_items[0][price_data][unit_amount]":String(amount),
     "line_items[0][quantity]":"1",
     "metadata[chord_studio_premium]":"1",
     "metadata[account_id]":accountId,
     "metadata[premium_intro_slot]":offer.introRemaining>0?"1":"0",
     "payment_intent_data[metadata][chord_studio_premium]":"1",
     "payment_intent_data[metadata][account_id]":accountId,
     "payment_intent_data[metadata][premium_intro_slot]":offer.introRemaining>0?"1":"0"
   });
   if(!checkout||!checkout.url)throw new Error("Stripe לא החזיר קישור לתשלום.");
   res.json({url:checkout.url,amount:amount,priceText:(amount/100).toFixed(0)+" ₪",introRemaining:offer.introRemaining});
 }catch(error){
   console.error("Stripe checkout failed",String(error&&error.stack||error));
   res.status(502).json({error:"יצירת התשלום נכשלה: "+String(error&&error.message||error).slice(0,250)});
 }
});
app.get("/api/premium/confirm",async function(req,res){const session=await authSession(req),sessionId=String(req.query.session_id||"").trim();if(!session)return res.status(401).json({error:"יש להתחבר עם Google לפני אישור התשלום."});if(!sessionId)return res.status(400).json({error:"חסר מזהה תשלום."});if(!process.env.STRIPE_SECRET_KEY)return res.status(503).json({error:"מערכת התשלום עדיין לא הוגדרה בשרת."});try{const checkout=await stripeRequest("/v1/checkout/sessions/"+encodeURIComponent(sessionId),"GET");const accountId=accountIdForUser(session.user),paid=checkout&&checkout.status==="complete"&&checkout.payment_status==="paid"&&Number(checkout.amount_total)===PREMIUM_AMOUNT&&String(checkout.currency||"").toLowerCase()===PREMIUM_CURRENCY&&checkout.metadata&&checkout.metadata.account_id===accountId&&checkout.metadata.chord_studio_premium==="1";if(!paid)return res.status(403).json({error:"התשלום לא אומת עבור חשבון Google הזה."});session.premium=true;session.premiumCheckedAt=Date.now();res.json({ok:true,premium:true});}catch(error){console.error("Stripe payment confirmation failed",String(error&&error.stack||error));res.status(502).json({error:"אימות התשלום נכשל: "+String(error&&error.message||error).slice(0,250)});}});
async function requireUploadAccess(req,res,options){
 const session=await authSession(req);if(!session){res.status(401).json({error:"יש להתחבר עם חשבון לפני העלאת קובץ."});return false;}
 const requireApiKey=!(options&&options.requireApiKey===false),apiKey=String(req.headers["x-gemini-api-key"]||"").trim();if(requireApiKey&&!apiKey){res.status(401).json({error:"חייבים להזין מפתח Gemini API לפני העלאת קובץ."});return false;}
 const premium=await isPremiumSession(session);if(options&&options.premiumRequired&&!premium){res.status(403).json({error:"הפעולה זמינה במסלול Premium בלבד."});return false;}
 let usageReservation=null;
 if(!premium&&!(options&&options.validateGeminiKey===false)){const usage=await reserveDailyUsage(accountIdForUser(session.user));if(!usage.allowed){const resetAt=nextDailyReset().toISOString();res.set("Retry-After",String(Math.max(1,Math.ceil((new Date(resetAt).getTime()-Date.now())/1000))));res.status(429).json({error:usage.reason==="pending"?"כבר מתבצע ניתוח עבור החשבון הזה. המתן לסיומו.":"המכסה השבועית נוצלה. אפשר לנתח שיר נוסף כשהמכסה תתחדש.",weeklyRemaining:0,dailyRemaining:0,weeklyResetAt:resetAt,dailyResetAt:resetAt});return false;}usageReservation=usage;}
 req.auth={session:session,apiKey:apiKey,premium:premium,usageReservation:usageReservation};logOperation(req.operationId,"access_granted",premium?"חשבון Premium אומת":usageReservation?"חשבון ומפתח API אומתו; נשמר מקום במכסה השבועית":"החשבון אומת; עדיין לא נשמר מקום במכסת הניתוח","success");return true;
}
function parseTranscriptionOffset(value){
  if(typeof value==="number"&&Number.isFinite(value))return Math.max(0,value);
  const raw=String(value==null?"":value).trim().toLowerCase();
  if(!raw)return NaN;
  if(/ms$/.test(raw)){const n=Number.parseFloat(raw);return Number.isFinite(n)?Math.max(0,n/1000):NaN;}
  const n=Number.parseFloat(raw);
  return Number.isFinite(n)?Math.max(0,n):NaN;
}
function normalizeTimelineWord(value){
  return String(value||"").toLowerCase().normalize("NFD").replace(/[\u0591-\u05C7]/g,"").replace(/[^\p{L}\p{N}]+/gu,"");
}
function timelineWordSimilarity(a,b){
  if(!a||!b)return 0;
  if(a===b)return 1;
  if(a.length<2||b.length<2)return 0;
  if(a.includes(b)||b.includes(a))return 0.88;
  const prev=new Array(b.length+1),cur=new Array(b.length+1);
  for(let j=0;j<=b.length;j++)prev[j]=j;
  for(let i=1;i<=a.length;i++){
    cur[0]=i;
    for(let j=1;j<=b.length;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+cost);
    }
    for(let j=0;j<=b.length;j++)prev[j]=cur[j];
  }
  return 1-(prev[b.length]/Math.max(a.length,b.length));
}
function alignFinalWordTimes(lines,transcriptionWords,duration){
  if(!Array.isArray(transcriptionWords)||transcriptionWords.length<3)return 0;
  const source=transcriptionWords.map(function(item){
    return {
      word:String(item&&item.word||"").trim(),
      token:normalizeTimelineWord(item&&item.word),
      start:Number(item&&item.startOffset),
      end:Number(item&&item.endOffset)
    };
  }).filter(function(item){
    return item.token&&Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.end>=item.start;
  }).sort(function(a,b){return a.start-b.start;});
  if(source.length<3)return 0;
  let cursor=0,matched=0;
  for(const line of (lines||[])){
    for(const finalWord of (line&&line.words)||[]){
      const token=normalizeTimelineWord(finalWord&&finalWord.text);
      if(!token)continue;
      let bestIndex=-1,bestScore=0;
      const limit=Math.min(source.length,cursor+40);
      for(let j=cursor;j<limit;j++){
        const similarity=timelineWordSimilarity(token,source[j].token);
        const score=similarity-((j-cursor)*0.004);
        if(score>bestScore){bestScore=score;bestIndex=j;}
        if(similarity===1&&(j-cursor)<3)break;
      }
      if(bestIndex<0||bestScore<0.70)continue;
      const hit=source[bestIndex];
      const safeEnd=Number.isFinite(duration)&&duration>0?Math.min(duration,hit.end):hit.end;
      if(safeEnd>=hit.start){
        finalWord.start=hit.start;
        finalWord.end=Math.max(hit.start,safeEnd);
        matched+=1;
      }
      cursor=bestIndex+1;
    }
  }
  return matched;
}

async function transcribeWithGemini(apiKey,audioBase64,mimeType,operationIdValue){
  const startedAt=Date.now(),maxRetries=10,retryDelayMs=60000;
  for(let attempt=0;;attempt++){
    const controller=new AbortController();
    const timeoutMs=Math.max(30000,Number(process.env.GEMINI_TIMEOUT_MS)||240000);
    const timeout=setTimeout(function(){controller.abort();},timeoutMs);
    try{
      logOperation(operationIdValue,"transcription_started","מתחיל תמלול מלא באמצעות "+TRANSCRIBE_MODEL+"; ניסיון "+(attempt+1));
      const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(TRANSCRIBE_MODEL)+":generateContent",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
        body:JSON.stringify({
          contents:[{role:"user",parts:[
            {text:"Transcribe the ENTIRE attached recording verbatim in the sung/spoken language. Perform a complete scan from beginning to end, preserving every verse, chorus repetition, instrumental vocal, ad-lib and ending. Return word-level timestamps for every recognized word. Do not summarize and do not omit later sections."},
            {inline_data:{mime_type:mimeType,data:audioBase64}}
          ]}],
          generationConfig:{audioTranscriptionConfig:{wordTimestamp:true,mode:"VERBATIM"}}
        }),
        signal:controller.signal
      });
      const raw=await response.text();let data={};
      try{data=raw?JSON.parse(raw):{};}catch{
        const e=new Error("Gemini Transcribe החזיר תשובה שאינה JSON תקין");
        e.geminiStatus=response.status;e.geminiCode="INVALID_JSON";throw e;
      }
      if(!response.ok){
        const e=new Error(data&&data.error&&data.error.message||"Gemini Transcribe request failed");
        e.geminiStatus=response.status;e.geminiCode=data&&data.error&&data.error.status||"";e.geminiApiCode=data&&data.error&&data.error.code||null;
        e.retryAfterSeconds=Number(response.headers.get("retry-after"))||0;throw e;
      }
      const transcriptParts=data.candidates&&data.candidates[0]&&data.candidates[0].content&&Array.isArray(data.candidates[0].content.parts)
        ?data.candidates[0].content.parts:[];
      const transcriptWords=[];
      const transcript=transcriptParts.map(function(part){
        if(!part)return "";
        const audioTx=part.audio_transcription||part.audioTranscription||part.audio_transcription_result||part.audioTranscriptionResult;
        if(audioTx&&Array.isArray(audioTx.words)){
          audioTx.words.forEach(function(wordInfo){
            const start=parseTranscriptionOffset(wordInfo ? (wordInfo.startOffset ?? wordInfo.start_offset) : undefined);
            const end=parseTranscriptionOffset(wordInfo ? (wordInfo.endOffset ?? wordInfo.end_offset) : undefined);
            const word=String(wordInfo&&wordInfo.word||"").trim();
            if(word&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start)transcriptWords.push({word:word,startOffset:start,endOffset:end});
          });
        }
        return String(part.text||audioTx&&audioTx.text||audioTx&&Array.isArray(audioTx.words)&&audioTx.words.map(function(word){return word&&word.word||"";}).join(" ")||"");
      }).filter(Boolean).join("\n").trim()||String(data.output_text||data.outputText||"").trim();
      if(!transcript.trim()){
        const e=new Error("Gemini Transcribe החזיר תמלול ריק");
        e.geminiStatus=response.status;e.geminiCode="EMPTY_TRANSCRIPT";throw e;
      }
      logOperation(operationIdValue,"transcription_completed","התמלול המלא הושלם באמצעות "+TRANSCRIBE_MODEL+"; "+transcriptWords.length+" חותמות זמן ברמת מילה; משך "+(Date.now()-startedAt)+"ms");
      return {text:transcript,words:transcriptWords};
    }catch(error){
      const overload=Number(error&&error.geminiStatus)===429||Number(error&&error.geminiStatus)===503||/RESOURCE_EXHAUSTED|UNAVAILABLE|overload|overloaded|high demand|rate.?limit/i.test(String(error&&error.geminiCode||"")+" "+String(error&&error.message||""));
      if(overload&&attempt<maxRetries){
        logOperation(operationIdValue,"transcription_overload_retry","Gemini Transcribe עמוס או הגביל בקשות; ניסיון "+(attempt+1)+" נכשל. ניסיון חוזר "+(attempt+2)+" מתוך "+(maxRetries+1)+" בעוד דקה","warning");
        await new Promise(function(resolve){setTimeout(resolve,retryDelayMs);});
        continue;
      }
      const message=error&&error.name==="AbortError"?"בקשת התמלול חרגה ממגבלת הזמן":"תמלול באמצעות Gemini נכשל";
      logOperation(operationIdValue,"transcription_failed",message+"; מודל "+TRANSCRIBE_MODEL+"; HTTP "+(error&&error.geminiStatus||"לא התקבל")+"; ניסיונות "+(attempt+1)+"; פירוט: "+String(error&&error.message||error).slice(0,350),"error");
      throw error;
    }finally{
      clearTimeout(timeout);
    }
  }
}
async function analyzeWithChordino(filePath,originalName,mimeType,operationIdValue){
  if(!LOCAL_AUDIO_ENGINE_URL||!LOCAL_AUDIO_ENGINE_TOKEN){
    const error=new Error("שירות Chordino לא מוגדר בשרת. חסרים LOCAL_AUDIO_ENGINE_URL או LOCAL_AUDIO_ENGINE_TOKEN.");
    error.code="CHORDINO_NOT_CONFIGURED";
    logOperation(operationIdValue,"chordino_not_configured",error.message,"error");
    throw error;
  }
  const startedAt=Date.now(),controller=new AbortController();
  const timeout=setTimeout(function(){controller.abort();},CHORDINO_ENGINE_TIMEOUT_MS);
  try{
    logOperation(operationIdValue,"chordino_started","שולחים את האודיו למנוע Sonic Annotator + Chordino");
    const bytes=await fs.readFile(filePath);
    let response,connectionError;
    for(let attempt=0;attempt<3;attempt++){
      try{
        const form=new FormData();
        form.append("audio",new Blob([bytes],{type:mimeType||"audio/mpeg"}),String(originalName||"audio"));
        response=await fetch(LOCAL_AUDIO_ENGINE_URL+"/analyze",{
          method:"POST",
          headers:{Authorization:"Bearer "+LOCAL_AUDIO_ENGINE_TOKEN},
          body:form,
          signal:controller.signal
        });
        connectionError=null;
        if([502,503,504].includes(response.status)&&attempt<2){
          logOperation(operationIdValue,"chordino_http_retry","שירות Chordino החזיר HTTP "+response.status+"; ניסיון חוזר "+(attempt+2)+" מתוך 3","warning");
          try{await response.body?.cancel();}catch(cancelError){}
          await new Promise(function(resolve){setTimeout(resolve,2000*(attempt+1));});
          continue;
        }
        break;
      }catch(error){
        connectionError=error;
        const transient=error&&(/terminated|socket|fetch failed|ECONNRESET|UND_ERR/i.test(String(error.message||error)));
        if(!transient||attempt===2||controller.signal.aborted)throw error;
        logOperation(operationIdValue,"chordino_connection_retry","חיבור למנוע Chordino נותק לפני קבלת תשובה; ניסיון חוזר "+(attempt+2)+" מתוך 3","warning");
        await new Promise(function(resolve){setTimeout(resolve,1500*(attempt+1));});
      }
    }
    if(!response&&connectionError)throw connectionError;
    const raw=await response.text();let data={};
    try{data=raw?JSON.parse(raw):{};}catch(parseError){
      const contentType=String(response.headers.get("content-type")||"לא צוין");
      const preview=String(raw||"").replace(/\\s+/g," ").slice(0,240);
      const error=new Error("שירות Chordino החזיר גוף שאינו JSON; HTTP "+response.status+"; Content-Type: "+contentType+"; תשובה: "+(preview||"[ריק]"));
      error.chordinoStatus=response.status;error.code="CHORDINO_INVALID_RESPONSE";throw error;
    }
    if(!response.ok){
      const detail=data&&data.detail||data&&data.error||"שירות Chordino נכשל";
      const error=new Error(String(detail)+" (HTTP "+response.status+")");
      error.chordinoStatus=response.status;throw error;
    }
    const rawChords=Array.isArray(data.chords)?data.chords.map(function(chord){
      return {
        start:Math.max(0,Number(chord&&chord.start)||0),
        end:Math.max(0,Number(chord&&chord.end)||0),
        chord:String(chord&&chord.chord||"").trim()
      };
    }).filter(function(chord){
      return chord.chord&&chord.end>chord.start;
    }).sort(function(a,b){return a.start-b.start;}) : [];
    const chords=collapseAdjacentChordEvents(rawChords,0.9);
    if(!chords.length){
      const error=new Error("Chordino לא החזיר אף אירוע אקורד לקובץ.");
      error.code="EMPTY_CHORDINO";throw error;
    }
    logOperation(operationIdValue,"chordino_completed","Chordino החזיר "+chords.length+" אירועי אקורד; משך "+(Date.now()-startedAt)+"ms");
    return {
      engine:String(data.engine||"sonic-annotator+chordino"),
      duration:Number(data.duration)||0,
      chords:chords
    };
  }catch(error){
    const message=error&&error.name==="AbortError"?"עיבוד Chordino חרג ממגבלת הזמן":"עיבוד Chordino נכשל";
    logOperation(operationIdValue,"chordino_failed",message+"; HTTP "+(error&&error.chordinoStatus||"לא התקבל")+"; פירוט: "+String(error&&error.message||error).slice(0,350),"error");
    throw error;
  }finally{
    clearTimeout(timeout);
  }
}


async function getAudioDurationSeconds(filePath){
  try{
    const metadata=await parseFile(filePath,{skipCovers:true});
    const duration=Number(metadata&&metadata.format&&metadata.format.duration||0);
    if(Number.isFinite(duration)&&duration>0)return duration;
  }catch(error){
    console.warn("Audio duration read failed",String(error&&error.message||error).slice(0,250));
  }
  return 0;
}

async function analyzeChordinoInChunks(filePath,originalName,mimeType,operationIdValue){
  // Send the ENTIRE song to Chordino in one request.
  // Do not split the recording: multiple chunk requests can exhaust the
  // external engine quota and can create boundary artifacts.
  logOperation(operationIdValue,"chordino_single_pass","שולחים את כל השיר בשלמותו ל-Chordino בבקשה אחת; ללא חלוקה למקטעים. הבדיקה מכסה את כל ציר הזמן, כולל אמצע וסיום.");
  const result=await analyzeWithChordino(filePath,originalName,mimeType,operationIdValue);
  const duration=Math.max(0,Number(result&&result.duration)||await getAudioDurationSeconds(filePath));
  const chords=Array.isArray(result&&result.chords)?result.chords:[];
  if(!chords.length)throw new Error("Chordino בניתוח מלא לא החזיר אירועי אקורד");
  logOperation(operationIdValue,"chordino_single_pass_completed","Chordino השלים ניתוח מלא של כל השיר בבקשה אחת: "+chords.length+" אירועי אקורד על פני "+duration.toFixed(2)+" שניות");
  return {duration:duration,chords:chords,chunkCount:1};
}

const LIBROSA_ENGINE_URL=String(process.env.LIBROSA_ENGINE_URL||"").replace(/\/+$/,"");
const LIBROSA_ENGINE_TOKEN=String(process.env.LIBROSA_ENGINE_TOKEN||"");
async function analyzeWithLibrosa(filePath,originalName,mimeType,operationIdValue){if(!LIBROSA_ENGINE_URL||!LIBROSA_ENGINE_TOKEN)throw new Error("Librosa engine is not configured");const bytes=await fs.readFile(filePath);const form=new FormData();form.append("audio",new Blob([bytes],{type:mimeType||"audio/mpeg"}),String(originalName||"audio.mp3"));const response=await fetch(LIBROSA_ENGINE_URL+"/analyze",{method:"POST",headers:{Authorization:"Bearer "+LIBROSA_ENGINE_TOKEN},body:form,signal:AbortSignal.timeout(300000)});const raw=await response.text();let data;try{data=JSON.parse(raw)}catch(e){throw new Error("Librosa returned non-JSON response (HTTP "+response.status+")")}if(!response.ok)throw new Error(String(data.error||"Librosa failed")+" (HTTP "+response.status+")");const chords=(Array.isArray(data.chords)?data.chords:[]).map(c=>({start:Number(c.start)||0,end:Number(c.end)||0,chord:String(c.chord||""),confidence:Number(c.confidence)||0})).filter(c=>c.chord&&c.end>c.start).sort((a,b)=>a.start-b.start);if(!chords.length)throw new Error("Librosa returned no chords");logOperation(operationIdValue,"librosa_completed","Librosa returned "+chords.length+" chord events");return {duration:Number(data.duration)||0,chords};}
async function analyzeWithGemini(apiKey,audioBase64,mimeType,prompt,operationIdValue,stage){
 const startedAt=Date.now(),maxRetries=10,retryDelayMs=60000;
 let activeModel=MODEL,usedFallback=false;
 for(let attempt=0;;attempt++){
  try{
   const controller=new AbortController();
   const timeoutMs=Math.max(30000,Number(process.env.GEMINI_TIMEOUT_MS)||240000);
   const timeout=setTimeout(function(){controller.abort();},timeoutMs);
   let response;
   try{response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(activeModel)+":generateContent",{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inline_data:{mime_type:mimeType,data:audioBase64}}]}],generationConfig:{responseMimeType:"application/json",responseSchema:SCHEMA}}),signal:controller.signal});}finally{clearTimeout(timeout);}
   const raw=await response.text();let data={};
   try{data=raw?JSON.parse(raw):{};}catch(parseError){const e=new Error("Gemini החזיר גוף תשובה שאינו JSON תקין");e.geminiStatus=response.status;e.geminiCode="INVALID_JSON";e.responsePreview=raw.slice(0,500);throw e;}
   if(!response.ok){const error=new Error(data&&data.error&&data.error.message||"Gemini generation failed");error.geminiStatus=response.status;error.geminiCode=data&&data.error&&data.error.status||"";error.geminiApiCode=data&&data.error&&data.error.code||null;error.retryAfterSeconds=Number(response.headers.get("retry-after"))||0;throw error;}
   const outputText=data.candidates&&data.candidates[0]&&data.candidates[0].content&&Array.isArray(data.candidates[0].content.parts)?data.candidates[0].content.parts.map(function(part){return part&&part.text||"";}).join(""):"";
   if(!outputText){const e=new Error("Gemini returned an empty response");e.geminiStatus=response.status;e.geminiCode="EMPTY_RESPONSE";throw e;}
   let parsed;try{parsed=JSON.parse(outputText);}catch(parseError){const e=new Error("Gemini החזיר תוכן שאינו JSON תקין: "+String(parseError.message||parseError).slice(0,180));e.geminiStatus=response.status;e.geminiCode="INVALID_MODEL_JSON";throw e;}
   logOperation(operationIdValue,"gemini_response_received","Gemini החזיר תשובה תקינה; שלב "+stage+", מודל "+activeModel+(usedFallback?" (מודל גיבוי)":"")+", HTTP "+response.status+", ניסיון "+(attempt+1)+", משך "+(Date.now()-startedAt)+"ms");return parsed;
  }catch(error){
   if(!usedFallback&&activeModel===MODEL){usedFallback=true;activeModel="gemini-3.8-flash";attempt=-1;logOperation(operationIdValue,"gemini_fallback","מודל ברירת המחדל "+MODEL+" נכשל בשלב "+stage+"; מעבר אוטומטי למודל הגיבוי gemini-3.8-flash. פירוט: "+String(error&&error.message||error).slice(0,250),"warning");continue;}
   const overload=Number(error&&error.geminiStatus)===429||Number(error&&error.geminiStatus)===503||/RESOURCE_EXHAUSTED|UNAVAILABLE|overload|overloaded|high demand|rate.?limit/i.test(String(error&&error.geminiCode||"")+" "+String(error&&error.message||""));
   if(overload&&attempt<maxRetries){logOperation(operationIdValue,"gemini_overload_retry","מודל הגיבוי עמוס או הגביל בקשות; ניסיון "+(attempt+1)+" נכשל. ניסיון חוזר "+(attempt+2)+" מתוך "+(maxRetries+1)+" בעוד דקה","warning");await new Promise(function(resolve){setTimeout(resolve,retryDelayMs);});continue;}
   const message=error&&error.name==="AbortError"?"הבקשה ל־Gemini חרגה ממגבלת הזמן":"בקשת Gemini נכשלה";
   logOperation(operationIdValue,"gemini_request_failed",message+"; שלב "+stage+", מודל "+activeModel+", HTTP "+(error&&error.geminiStatus||"לא התקבל")+", קוד "+(error&&error.geminiCode||"לא ידוע")+", ניסיונות "+(attempt+1)+", משך "+(Date.now()-startedAt)+"ms, פירוט: "+String(error&&error.message||error).slice(0,350),"error");throw error;
  }
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
   alignFinalWordTimes(verified.lines,pending.transcriptionWords||[],Number(verified.duration)||0);
   if(supabaseReady()&&pending.historyId)await updateAnalysisHistory(pending.historyId,accountIdForUser(session.user),verified);
   pendingVerifications.delete(id);res.json({analysis:verified,verified:true});
 }catch(error){res.status(502).json({error:"האימות הנוסף נכשל, אך הניתוח הראשוני נשמר. "+String(error&&error.message||error),verificationFailed:true});}
});

app.get("/api/admin/operations",async function(req,res){
 const session=await authSession(req);
 if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});
 const items=Array.from(operations.entries()).map(function(entry){const id=entry[0],events=entry[1]||[],last=events[events.length-1]||{};return{id:id,status:last.level==="error"?"נכשלה":last.stage==="completed"||last.stage==="response"?"הושלם":"בתהליך",updatedAt:last.time||null,eventCount:events.length}}).sort(function(a,b){return String(b.updatedAt||"").localeCompare(String(a.updatedAt||""))}).slice(0,50);
 res.setHeader("Cache-Control","no-store");res.json({operations:items});
});
app.get("/api/admin/operations/:id",async function(req,res){
 const session=await authSession(req);
 if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});
 const id=String(req.params.id||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80);
 res.setHeader("Cache-Control","no-store");res.json({operationId:id,events:operations.get(id)||[]});
});
app.get("/api/admin/summary",async function(req,res){
 const session=await authSession(req);
 if(!session||normalizeEmail(session.user.email)!==ADMIN_EMAIL)return res.status(403).json({error:"אין הרשאת מנהל"});
 let premiumUsers=0;
 try{premiumUsers=Object.keys(await loadPremiumGrants()).length;}catch{}
 let accountCount=null;
 if(supabaseReady()){try{const rows=await sb("app_accounts?select=account_id");accountCount=Array.isArray(rows)?rows.length:null;}catch{}}
 res.setHeader("Cache-Control","no-store");res.json({operationCount:operations.size,premiumUsers:premiumUsers,accountCount:accountCount,model:MODEL,transcriptionModel:TRANSCRIBE_MODEL,supabaseConfigured:supabaseReady(),stripeConfigured:Boolean(process.env.STRIPE_SECRET_KEY),chordinoConfigured:Boolean(LOCAL_AUDIO_ENGINE_URL&&LOCAL_AUDIO_ENGINE_TOKEN)});
});
app.get("/api/operations/:id",async function(req,res){
 const session=await authSession(req);
 if(!session)return res.status(401).json({error:"יש להתחבר כדי לקרוא את מצב הניתוח"});
 const id=String(req.params.id||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,80);
 const accountId=accountIdForUser(session.user);
 if(normalizeEmail(session.user.email)!==ADMIN_EMAIL&&operationOwners.get(id)!==accountId)return res.status(403).json({error:"אין הרשאה לקרוא את מצב הניתוח הזה"});
 res.setHeader("Cache-Control","no-store");
 res.json({operationId:id,events:operations.get(id)||[]});
});
app.post("/api/analyze",async function(req,res){
 const startedAt=Date.now();req.operationId=operationId(req);
 logOperation(req.operationId,"request_received","התקבלה בקשת ניתוח מהדפדפן");
 let currentStage="access_check";
 try{
  const access=await requireUploadAccess(req,res,{consumeDaily:false,validateGeminiKey:false,requireApiKey:false});
  if(access!==true){logOperation(req.operationId,"access_denied","השרת עצר את הבקשה בשלב בדיקת החשבון; HTTP "+res.statusCode,"error");return;}
  operationOwners.set(req.operationId,accountIdForUser(req.auth.session.user));
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
    currentStage="file_validation";
    logOperation(req.operationId,"file_received","קובץ התקבל; בודקים גודל וסוג");
    const stat=await fs.stat(req.file.path);
    logOperation(req.operationId,"file_stats","גודל הקובץ "+stat.size+" בתים; MIME "+String(req.file.mimetype||"לא צוין"));
    if(!stat.size)throw new Error("הקובץ שהתקבל ריק. בחר קובץ אודיו אחר.");
    if(stat.size>INLINE_AUDIO_MAX_BYTES)throw new Error("הקובץ גדול מדי לניתוח ב-Gemini (מקסימום 14MB).");

    currentStage="audio_read";
    logOperation(req.operationId,"audio_read_started","קוראים את הקובץ ומכינים אותו לשליחה ל-Gemini");
    const audioBase64=(await fs.readFile(req.file.path)).toString("base64");
    const mimeType=req.file.mimetype||"audio/mpeg";
    const filenameHintValue=filenameHint(req.file.originalname||"");
    logOperation(req.operationId,"audio_read_completed","הקובץ נקרא בהצלחה; גודל מקודד "+audioBase64.length+" תווים");

    currentStage="metadata";
    logOperation(req.operationId,"metadata_started","מחלצים פרטי אודיו כגון מידע מוטמע");
    const audioMetadata=await extractAudioMetadata(req.file.path);
    logOperation(req.operationId,"metadata_completed","חילוץ פרטי האודיו הסתיים; "+(audioMetadata?"נמצאו פרטים":"לא נמצאו פרטים מוטמעים"));

    const audioBufferForMatch=await fs.readFile(req.file.path);
    const audioSha256ForMatch=crypto.createHash("sha256").update(audioBufferForMatch).digest("hex");
    const skipGlobalReuse=String(req.body&&req.body.skipGlobalReuse||"") === "1";
    if(!skipGlobalReuse){
      currentStage="global_song_match";
      logOperation(req.operationId,"song_match_search_started","מחפשים בכל הניתוחים הקיימים של כל המשתמשים לפני Gemini ו-Chordino");
      const reusableMatches=await findReusableSongMatches({filename:filenameHintValue,audioMetadata:audioMetadata,audioSha256:audioSha256ForMatch,durationSeconds:Number(audioMetadata&&audioMetadata.duration)||0});
      if(reusableMatches.length){
        const match=reusableMatches[0];
        logOperation(req.operationId,"song_match_found","נמצאה התאמה לשיר שכבר נותח: "+match.title+" — "+match.artist+"; "+match.method,"success");
        res.setHeader("Cache-Control","no-store");
        return res.json({match:{id:match.id,title:match.title,artist:match.artist,duration:match.duration,method:match.method},operationId:req.operationId});
      }
      logOperation(req.operationId,"song_match_none","לא נמצאה התאמה מספקת; ממשיכים לניתוח מלא");
    }
    currentStage="access_check";
    const finalAccess=await requireUploadAccess(req,res,{consumeDaily:true,validateGeminiKey:true,requireApiKey:true});
    if(finalAccess!==true){logOperation(req.operationId,"access_denied","השרת עצר את הבקשה לאחר חיפוש ההתאמה; HTTP "+res.statusCode,"error");return;}

    currentStage="evidence_collection";
    logOperation(req.operationId,"evidence_collection_started","מריצים תמלול Gemini מלא ובמקביל Chordino על כל השיר בבקשה אחת, ללא חלוקה למקטעים");
    const chordEngine=String(req.body&&req.body.chordEngine||"chordino").toLowerCase()==="librosa"?"librosa":"chordino";
    const evidence=await Promise.all([
      transcribeWithGemini(req.auth.apiKey,audioBase64,mimeType,req.operationId),
      chordEngine==="librosa" ? analyzeWithLibrosa(req.file.path,filenameHintValue,mimeType,req.operationId) : analyzeChordinoInChunks(req.file.path,filenameHintValue,mimeType,req.operationId)
    ]);
    const transcriptionEvidence=evidence[0];
    const transcript=String(transcriptionEvidence&&transcriptionEvidence.text||"").trim();
    const chordino=evidence[1];
    if(!Array.isArray(chordino.chords)||!chordino.chords.length)throw new Error("Chordino לא סיפק נתוני אקורדים");

    currentStage="final_reconciliation";
    logOperation(req.operationId,"final_reconciliation_started","שולחים ל-Gemini Flash Lite את התמלול ואת ציר האקורדים של Chordino כדי לסגור את התוצאה הסופית");
    const reconciliationPrompt=PRIMARY_PROMPT+
      metadataPromptBlock(filenameHintValue,audioMetadata)+
      "\n\nGEMINI 3.5 TRANSCRIBE — COMPLETE TRANSCRIPTION EVIDENCE:\n"+
      transcript+
      "\n\nGEMINI 3.5 TRANSCRIBE — WORD TIMESTAMP EVIDENCE (REAL AUDIO OFFSETS):\n"+
      JSON.stringify((transcriptionEvidence&&transcriptionEvidence.words)||[])+
      "\n\nCHORDINO — INDEPENDENT CHORD TIMELINE EVIDENCE:\n"+
      JSON.stringify({source:"Chordino via Sonic Annotator",duration:chordino.duration,chords:chordino.chords})+
      "\n\nMUSICAL CONTEXT RULES:\n"+
      "Use the Chordino chord sequence as the primary and authoritative evidence for every chord. Check the ENTIRE timeline carefully from beginning to end, with EXTRA attention to chord changes in the middle and especially the final third and ending of the song; do not stop relying on evidence after the opening section. Use the overall chord movement to establish the tonal center and likely major/minor key. Do not invent, delete, rename, simplify, duplicate, move, or extrapolate chords beyond what the Chordino timeline provides. Preserve chord qualities and timestamps exactly as detected by Chordino. When reconciling lyrics and chords, keep later-section chord changes fully represented rather than defaulting to chords from the beginning.";
    const finalAnalysis=cleanAnalysis(await analyzeWithGemini(req.auth.apiKey,audioBase64,mimeType,reconciliationPrompt,req.operationId,"final_reconciliation"));
    if(!(finalAnalysis.lines||[]).length)throw new Error("הניתוח הסופי של Gemini לא החזיר תמלול");
    // Chordino is the authoritative chord detector. Gemini contributes lyrics,
    // metadata and key context only; never replace the detected chord timeline.
    // Preserve the real Chordino timestamps. Do NOT quantize from song start to BPM bars:
    // that introduces cumulative timing drift when a recording changes tempo or breathes naturally.
    finalAnalysis.duration=chordino.duration>0?chordino.duration:finalAnalysis.duration;
    const alignedWordCount=alignFinalWordTimes(finalAnalysis.lines,(transcriptionEvidence&&transcriptionEvidence.words)||[],finalAnalysis.duration);
    logOperation(req.operationId,"word_timeline_aligned","סנכרון מחדש לפי חותמות הזמן האמיתיות של Gemini Transcribe: "+alignedWordCount+" מילים קיבלו זמן אודיו מדוד");
    finalAnalysis.chords=collapseAdjacentChordEvents(chordino.chords,0.35).map(function(chord){
      return {
        start:Math.max(0,Number(chord.start)||0),
        end:Math.min(finalAnalysis.duration||Infinity,Math.max(0,Number(chord.end)||0)),
        chord:String(chord.chord||"").trim(),
        confidence:Math.max(0,Math.min(1,Number(chord.confidence)||0.8))
      };
    }).filter(function(chord){return chord.chord&&chord.end>chord.start;});
    // Put each detected chord above the first suitable lyric word only.
    // Never repeat the same sustained chord above every following word.
    placeChordAnchors(finalAnalysis.lines,finalAnalysis.chords);
    if(!finalAnalysis.chords.length)throw new Error("Chordino לא סיפק ציר אקורדים תקין");
    logOperation(req.operationId,"final_reconciliation_completed","התמלול והמטא-נתונים הושלמו; ציר האקורדים הסופי נלקח מ-Chordino בניתוח מלא: "+(chordino.chunkCount||1)+" מקטעים, "+(finalAnalysis.lines||[]).length+" שורות, "+finalAnalysis.chords.length+" אקורדים");

    currentStage="history_save";
    let historyId="",savedAudioPath="";
    if(supabaseReady()){
      const accountId=accountIdForUser(req.auth.session.user);
      try{
        logOperation(req.operationId,"song_storage_started","שומרים אוטומטית את קובץ השיר בחשבון");
        savedAudioPath=await uploadSongToStorage(accountId,req.file.path,req.file.originalname||filenameHintValue,req.file.mimetype||mimeType);
        logOperation(req.operationId,"song_storage_completed","קובץ השיר נשמר אוטומטית בחשבון");
      }catch(storageError){
        savedAudioPath="";
        logOperation(req.operationId,"song_storage_warning","לא ניתן היה לשמור את קובץ האודיו ב-Storage; הניתוח יישמר בכל זאת. "+String(storageError&&storageError.message||storageError).slice(0,260),"warning");
      }
      logOperation(req.operationId,"history_save_started","שומרים את הניתוח ואת פרטי השיר בהיסטוריית החשבון");
      try{
        historyId=await saveAnalysisHistory(accountId,finalAnalysis,{audioPath:savedAudioPath,originalFilename:req.file.originalname||filenameHintValue,mimeType:req.file.mimetype||mimeType,fileSize:stat.size ,audioSha256:audioSha256ForMatch,durationMs:Number(finalAnalysis.duration)>0?Math.round(Number(finalAnalysis.duration)*1000):Math.round(Number(audioMetadata.duration||0)*1000)});
      }catch(historyError){
        if(savedAudioPath)await deleteSongFromStorage(savedAudioPath);
        throw historyError;
      }
      logOperation(req.operationId,"history_save_completed","השיר נשמר אוטומטית בחשבון"+(historyId?" (מזהה "+historyId+")":""));
    }
    pendingVerifications.set(req.operationId,{audioBase64:audioBase64,mimeType:mimeType,first:finalAnalysis,transcriptionWords:(transcriptionEvidence&&transcriptionEvidence.words)||[],historyId:historyId,filename:filenameHintValue,audioMetadata:audioMetadata,createdAt:Date.now()});

    currentStage="quota_commit";
    let quotaStatus=null;
    if(usageReservation){
      logOperation(req.operationId,"quota_commit_started","מעדכנים את ניצול המכסה השבועית לאחר ניתוח שהושלם");
      await commitDailyUsage(accountIdForUser(req.auth.session.user),usageReservation.date,usageReservation.reservationKey);
      logOperation(req.operationId,"quota_commit_completed","המכסה השבועית עודכנה");
      if(!req.auth.premium) quotaStatus=await getDailyUsage(accountIdForUser(req.auth.session.user));
    }

    currentStage="response";
    logOperation(req.operationId,"completed","הניתוח הושלם ונשלחת תוצאה סופית לדפדפן; Chordino פעל בבקשה אחת על כל השיר; משך כולל "+(Date.now()-startedAt)+"ms","success");
    res.json({analysis:finalAnalysis,verificationAvailable:true,operationId:req.operationId,historyId:historyId,audioSaved:Boolean(savedAudioPath),dailyRemaining:quotaStatus?quotaStatus.remaining:null,dailyResetAt:quotaStatus?quotaStatus.resetAt:null,weeklyRemaining:quotaStatus?quotaStatus.remaining:null,weeklyResetAt:quotaStatus?quotaStatus.resetAt:null});
   }catch(error){
    if(usageReservation)await releaseDailyUsage(accountIdForUser(req.auth.session.user),usageReservation.reservationKey);
    let detail=String(error&&error.message||error);
    if(req.auth&&req.auth.apiKey)detail=detail.split(req.auth.apiKey).join("[מפתח מוסתר]");
    const prefix=currentStage==="chordino"||currentStage==="evidence_collection"?"ניתוח אודיו/Chordino: ":"Gemini: ";
    const status=currentStage==="chordino"||currentStage==="evidence_collection"?502:500;
    logOperation(req.operationId,"failed","כשל בשלב "+currentStage+" לאחר "+(Date.now()-startedAt)+"ms; HTTP "+status+"; קוד "+String(error&&error.geminiCode||error&&error.code||"לא זמין")+"; פירוט: "+detail.slice(0,500),"error");
    res.status(status).json({error:prefix+(detail||"ניתוח השיר נכשל"),operationId:req.operationId,stage:currentStage});
   }finally{
    try{await fs.unlink(req.file.path);logOperation(req.operationId,"temporary_file_removed","קובץ העבודה הזמני נמחק");}
    catch(cleanupError){logOperation(req.operationId,"cleanup_warning","לא ניתן היה למחוק קובץ זמני: "+String(cleanupError.message||cleanupError).slice(0,180),"error");}
   }
  });
 }catch(error){
  let detail=String(error&&error.message||error);
  if(req.auth&&req.auth.apiKey)detail=detail.split(req.auth.apiKey).join("[מפתח מוסתר]");
  logOperation(req.operationId,"failed","כשל לפני עיבוד הקובץ בשלב "+currentStage+"; HTTP 500; פירוט: "+detail.slice(0,500),"error");
  if(!res.headersSent)res.status(500).json({error:"Gemini: "+(detail||"שגיאת שרת"),operationId:req.operationId,stage:currentStage});
 }
});

app.post("/api/reuse-analysis",upload.single("audio"),async function(req,res){
 const session=await authSession(req);if(!session)return res.status(401).json({error:"יש להתחבר עם חשבון לפני שימוש בשיר שכבר נותח."});
 const historyId=String(req.body&&req.body.historyId||"").trim();if(!/^[0-9a-f-]{20,80}$/i.test(historyId))return res.status(400).json({error:"מזהה שיר לא תקין"});
 if(!req.file)return res.status(400).json({error:"לא התקבל קובץ השיר"});
 try{
  const rows=await sb("analysis_history?select=id,title,artist,analysis,original_filename,audio_sha256,duration_ms,normalized_title,normalized_artist,identity_key&id=eq."+encodeURIComponent(historyId)+"&limit=1"),source=Array.isArray(rows)?rows[0]:null;
  if(!source||!source.analysis)return res.status(404).json({error:"השיר שנבחר כבר אינו זמין"});
  const buffer=await fs.readFile(req.file.path),hash=crypto.createHash("sha256").update(buffer).digest("hex"),meta=await extractAudioMetadata(req.file.path),fn=filenameHint(req.file.originalname||"");
  const matches=await findReusableSongMatches({filename:fn,audioMetadata:meta,audioSha256:hash,durationSeconds:Number(meta.duration)||0}),selected=matches.find(x=>x.id===historyId);
  if(!selected||selected.score<.86)return res.status(409).json({error:"ההתאמה כבר לא אומתה. בחר בניתוח מחדש."});
  const accountId=accountIdForUser(session.user),reused=cleanAnalysis(source.analysis);let savedAudioPath="";
  try{savedAudioPath=await uploadSongToStorage(accountId,req.file.path,req.file.originalname||fn,req.file.mimetype||"audio/mpeg");}catch(e){console.warn("Reuse storage warning",String(e&&e.message||e).slice(0,200));}
  const savedHistoryId=await saveAnalysisHistory(accountId,reused,{audioPath:savedAudioPath,originalFilename:req.file.originalname||fn,mimeType:req.file.mimetype||"audio/mpeg",fileSize:buffer.length,audioSha256:hash,durationMs:Number(reused.duration)>0?Math.round(Number(reused.duration)*1000):Math.round(Number(meta.duration||0)*1000)});
  res.setHeader("Cache-Control","no-store");res.json({analysis:reused,reused:true,historyId:savedHistoryId,match:{title:selected.title,artist:selected.artist,method:selected.method}});
 }catch(error){console.error("Song reuse failed",String(error&&error.stack||error));res.status(500).json({error:"לא ניתן להציג את הניתוח הקיים: "+String(error&&error.message||error).slice(0,300)});}
 finally{try{await fs.unlink(req.file.path);}catch{}}
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
  const raw = String(chord || "").trim();
  if (!raw || mode === "off") return raw;
  const slashIndex = raw.indexOf("/");
  const main = slashIndex > 0 ? raw.slice(0, slashIndex) : raw;
  const m = main.match(/^([A-G](?:#|b)?)(.*)$/);
  if (!m) return raw;
  const root = m[1], suffix = m[2] || "", lower = suffix.toLowerCase();
  if (mode === "simple") return root + (/^(?:m|min)/.test(lower) ? "m" : "");
  if (mode === "medium") {
    if (/^(?:m|min)(?:7|9|11|13)?$/.test(lower)) return root + "m";
    if (/^(?:dim|°)(?:7)?$/.test(lower)) return root + "dim";
    if (/^(?:aug|\+)$/.test(lower)) return root + "aug";
    if (/^sus[24]$/.test(lower)) return root + lower;
    return root + (lower === "7" ? "7" : "");
  }
  if (mode === "advanced") {
    let simplified = suffix.replace(/(?:add)?(?:9|11|13)$/i, "");
    if (/^min$/i.test(simplified)) simplified = "m";
    return root + simplified;
  }
  return raw;
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
  const bodySize = Math.max(4, Math.min(48, Number(fontSize) || 14));
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

app.post("/api/separate-vocals",async function(req,res){
  const access=await requireUploadAccess(req,res,{premiumRequired:true,validateGeminiKey:false});
  if(access!==true)return;
  upload.single("audio")(req,res,async function(uploadError){
    if(uploadError){
      if(uploadError.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"קובץ ההפרדה גדול מדי (מקסימום 100MB)."});
      return res.status(400).json({error:"העלאת הקובץ נכשלה: "+String(uploadError.message||uploadError).slice(0,200)});
    }
    if(!req.file)return res.status(400).json({error:"לא התקבל קובץ אודיו להפרדה."});
    try{
      const token=String(process.env.REPLICATE_API_TOKEN||"").trim();
      if(!token)throw new Error("מערכת הפרדת הקול לא מופעלת בשרת. חסר REPLICATE_API_TOKEN ב-Render.");
      const bytes=await fs.readFile(req.file.path);
      const audioInput=bytes;
      const replicate=new Replicate({auth:token,useFileOutput:false});
      const modelVersion="cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953";
      const output=await replicate.run(modelVersion,{input:{audio:audioInput,stem:"vocals",model_name:"htdemucs_ft",shifts:2,overlap:0.25,clip_mode:"rescale",output_format:"mp3",mp3_bitrate:320}});
      let vocalsUrl="";
      if(output&&typeof output==="object"&&!Array.isArray(output))vocalsUrl=String(output.vocals||"");
      if(!vocalsUrl&&Array.isArray(output)){
        const found=output.find(function(item){return typeof item==="string"&&/^https:\/\/.*(?:vocals|vocal)/i.test(item)});
        if(found)vocalsUrl=String(found);
      }
      if(!/^https:\/\//i.test(vocalsUrl)){
        throw new Error("מודל Demucs לא החזיר קובץ vocals תקין.");
      }
      const verify=await fetch(vocalsUrl,{method:"HEAD"}).catch(function(){return null});
      if(verify&&!verify.ok)throw new Error("קובץ קול הזמר נוצר אך לא ניתן לגשת אליו (HTTP "+verify.status+").");
      res.setHeader("Cache-Control","no-store");
      res.json({vocalsUrl:vocalsUrl,model:"Demucs htdemucs_ft",ready:true});
    }catch(error){
      console.error("Vocal separation failed",String(error&&error.stack||error));
      const raw=String(error&&error.message||error);
      const safe=raw.replace(tokenForError(req),"[מפתח מוסתר]");
      res.status(502).json({error:"הפרדת הקול נכשלה: "+safe.slice(0,400)});
    }finally{try{await fs.unlink(req.file.path);}catch{}}
  });
});

function tokenForError(_req){return String(process.env.REPLICATE_API_TOKEN||"__never__");}

app.post("/api/export/docx", async function(req, res) {
  try {
    const payload = req.body || {};
    const analysis = payload.analysis;
    const shift = Math.max(-12, Math.min(12, Number(payload.shift) || 0));
    const mode = payload.simplify || "off";
    const fontSize = Math.max(4, Math.min(36, Number(payload.fontSize) || 14));
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
      children: [new TextRun({ text: "נוצר באמצעות Chord Studio · Gemini Flash Lite", font: "Arial", size: 10, color: "8493A4" })]
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


const selfTests = new Map();
const SELF_TEST_AUDIO_URL = "https://commons.wikimedia.org/wiki/Special:Redirect/file/Amazing_Grace_with_vocals_and_guitar_by_Rocks_From_The_Garden_-_20060603.ogg";

function selfTestAuthorized(req) {
  return process.env.SELF_TEST_ENABLED === "true" &&
    String(req.query && req.query.token || "") === String(process.env.SELF_TEST_TOKEN || "");
}

function selfTestTimelineValid(analysis) {
  if (!analysis || !Array.isArray(analysis.lines) || !Array.isArray(analysis.chords)) return false;
  const duration = Number(analysis.duration) || 0;
  const words = [];
  for (const line of analysis.lines) {
    for (const word of (line && line.words) || []) {
      const start = Number(word && word.start);
      const end = Number(word && word.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return false;
      if (duration && end > duration + 0.5) return false;
      words.push({start, end});
    }
  }
  for (const chord of analysis.chords) {
    const start = Number(chord && chord.start);
    const end = Number(chord && chord.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return false;
    if (duration && end > duration + 0.5) return false;
  }
  for (let i = 1; i < words.length; i += 1) {
    if (words[i].start + 0.25 < words[i - 1].start) return false;
  }
  for (let i = 1; i < analysis.chords.length; i += 1) {
    if (Number(analysis.chords[i].start) + 0.01 < Number(analysis.chords[i - 1].start)) return false;
  }
  return true;
}

async function runSelfTest(id) {
  const state = selfTests.get(id);
  const apiKey = String(process.env.GEMINI_API_KEY || "").trim();
  if (!state) return;
  const startedAt = Date.now();
  const setStage = function(stage, message) {
    const current = selfTests.get(id);
    if (!current) return;
    current.stage = stage;
    current.message = message || "";
    current.updatedAt = Date.now();
  };
  try {
    if (!apiKey) throw new Error("SELF_TEST חסר GEMINI_API_KEY ב-Render");
    setStage("download_test_audio", "מורידים קובץ בדיקה ציבורי");
    const audioResponse = await fetch(SELF_TEST_AUDIO_URL);
    if (!audioResponse.ok) throw new Error("הורדת אודיו לבדיקה נכשלה: HTTP " + audioResponse.status);
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    if (!audioBuffer.length) throw new Error("קובץ הבדיקה ריק");
    const sourcePath = path.join(uploadDir, "self-test-source-" + id + ".ogg");
    const wavPath = path.join(uploadDir, "self-test-" + id + ".wav");
    await fs.writeFile(sourcePath, audioBuffer);
    await convertAudioToWav(sourcePath, wavPath);
    const wavBuffer = await fs.readFile(wavPath);
    const mimeType = "audio/wav";
    const audioBase64 = wavBuffer.toString("base64");
    const filename = "amazing-grace.wav";
    state.audioBytes = wavBuffer.length;
    state.sourceAudioBytes = audioBuffer.length;
    state.mimeType = mimeType;

    setStage("transcription", "Gemini 3.5 Transcribe");
    const transcriptionEvidence = await transcribeWithGemini(apiKey, audioBase64, mimeType, id);
    const transcript = String(transcriptionEvidence&&transcriptionEvidence.text||"").trim();
    state.checks.transcription = { ok: Boolean(transcript), chars: transcript.length, timestampedWords: (transcriptionEvidence.words||[]).length };

    setStage("chordino", "Sonic Annotator + Chordino");
    try {
      const audioMetadata = await extractAudioMetadata(wavPath);
      const chordino = await analyzeWithChordino(sourcePath, filename, "audio/ogg", id);
      state.checks.chordino = { ok: Array.isArray(chordino.chords) && chordino.chords.length > 0, events: chordino.chords.length, duration: chordino.duration };

      setStage("reconciliation", "Gemini Flash Lite משלב תמלול + Chordino");
      const reconciliationPrompt = PRIMARY_PROMPT +
        metadataPromptBlock(filename, audioMetadata) +
        "\n\nGEMINI 3.5 TRANSCRIBE — COMPLETE TRANSCRIPTION EVIDENCE:\n" +
        transcript +
        "\n\nGEMINI 3.5 TRANSCRIBE — WORD TIMESTAMP EVIDENCE:\n" +
        JSON.stringify(transcriptionEvidence.words||[]) +
        "\n\nCHORDINO — INDEPENDENT CHORD TIMELINE EVIDENCE:\n" +
        JSON.stringify({ source: "Chordino via Sonic Annotator", duration: chordino.duration, chords: chordino.chords });
      const first = cleanAnalysis(await analyzeWithGemini(apiKey, audioBase64, mimeType, reconciliationPrompt, id, "final_reconciliation"));
      if (!Array.isArray(first.lines) || !first.lines.length || !Array.isArray(first.chords) || !first.chords.length) {
        throw new Error("הפלט הראשוני של Gemini לא הכיל גם מילים וגם אקורדים");
      }
      state.checks.reconciliation = { ok: true, lines: first.lines.length, chords: first.chords.length, timelineValid: selfTestTimelineValid(first) };

      setStage("verification", "Gemini Flash Lite מאמת מחדש את התוצאה");
      const verifyPrompt = VERIFY_PREFIX + metadataPromptBlock(filename, audioMetadata) + "\nCandidate JSON:\n" + JSON.stringify(first);
      const verified = cleanAnalysis(await analyzeWithGemini(apiKey, audioBase64, mimeType, verifyPrompt, id, "analysis_verify"));
      alignFinalWordTimes(verified.lines,transcriptionEvidence.words||[],Number(verified.duration)||Number(chordino.duration)||0);
      if (!Array.isArray(verified.lines) || !verified.lines.length || !Array.isArray(verified.chords) || !verified.chords.length) {
        throw new Error("פלט האימות של Gemini לא הכיל גם מילים וגם אקורדים");
      }
      state.checks.verification = { ok: true, lines: verified.lines.length, chords: verified.chords.length, timelineValid: selfTestTimelineValid(verified) };
      if (!state.checks.reconciliation.timelineValid || !state.checks.verification.timelineValid) {
        throw new Error("נמצאה בעיית ציר זמן בתוצאה");
      }

      state.status = "completed";
      state.stage = "completed";
      state.message = "הבדיקה המלאה הושלמה בהצלחה";
      state.result = {
        ok: true,
        source: SELF_TEST_AUDIO_URL,
        audioBytes: wavBuffer.length,
        sourceAudioBytes: audioBuffer.length,
        mimeType,
        models: { transcription: TRANSCRIBE_MODEL, reconciliation: MODEL, verification: MODEL },
        checks: state.checks,
        analysis: verified
      };
      state.updatedAt = Date.now();
      state.durationMs = Date.now() - startedAt;
    } finally {
      try { await fs.unlink(sourcePath); } catch {}
      try { await fs.unlink(wavPath); } catch {}
    }
  } catch (error) {
    const safeMessage = String(error && error.message || error).replace(apiKey || "__never__", "[מפתח מוסתר]");
    state.status = "failed";
    state.stage = "failed";
    state.message = safeMessage.slice(0, 800);
    state.updatedAt = Date.now();
    state.durationMs = Date.now() - startedAt;
  }
}

app.get("/api/self-test/start", function(req, res) {
  if (!selfTestAuthorized(req)) return res.status(404).json({ error: "Not found" });
  const running = Array.from(selfTests.values()).find(function(item) { return item.status === "running"; });
  if (running) return res.json({ ok: true, existing: true, id: running.id, stage: running.stage, status: running.status });
  const id = crypto.randomBytes(10).toString("hex");
  selfTests.set(id, { id: id, status: "running", stage: "starting", message: "מתחיל בדיקה", checks: {}, startedAt: Date.now(), updatedAt: Date.now() });
  res.json({ ok: true, id: id, existing: false, stage: "starting", status: "running" });
  runSelfTest(id).catch(function(error) {
    const state = selfTests.get(id);
    if (!state) return;
    state.status = "failed";
    state.stage = "failed";
    state.message = String(error && error.message || error).slice(0, 800);
    state.updatedAt = Date.now();
  });
});

app.get("/api/self-test/status", function(req, res) {
  if (!selfTestAuthorized(req)) return res.status(404).json({ error: "Not found" });
  const id = String(req.query && req.query.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const state = selfTests.get(id);
  if (!state) return res.status(404).json({ error: "בדיקה לא נמצאה" });
  const out = {
    id: state.id,
    status: state.status,
    stage: state.stage,
    message: state.message,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    durationMs: state.durationMs || null,
    checks: state.checks || {}
  };
  if (state.status === "completed") out.result = state.result;
  if (state.status === "failed") out.error = state.message;
  res.setHeader("Cache-Control", "no-store");
  res.json(out);
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
  if (String(process.env.SELF_TEST_AUTOSTART || "").toLowerCase() === "true") {
    const running = Array.from(selfTests.values()).find(function(item) { return item.status === "running"; });
    if (!running) {
      const id = "startup-" + crypto.randomBytes(8).toString("hex");
      selfTests.set(id, { id:id, status:"running", stage:"starting", message:"בדיקת שרת מלאה מתחילה אוטומטית", checks:{}, startedAt:Date.now(), updatedAt:Date.now() });
      console.log("SELF_TEST_AUTOSTART", id);
      runSelfTest(id).then(function() {
        const state=selfTests.get(id);
        const summary=state&&state.status==="completed"
          ? {status:state.status,stage:state.stage,durationMs:state.durationMs,checks:state.checks,resultOk:Boolean(state.result&&state.result.ok)}
          : {status:state&&state.status||"unknown",stage:state&&state.stage||"unknown",message:state&&state.message||""};
        console.log("SELF_TEST_RESULT", JSON.stringify(summary));
      }).catch(function(error) {
        console.error("SELF_TEST_FATAL", String(error&&error.stack||error));
      });
    }
  }
});
