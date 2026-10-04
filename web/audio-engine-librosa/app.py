import os, tempfile
from pathlib import Path
import librosa, numpy as np
from flask import Flask, jsonify, request
from scipy.ndimage import median_filter

app=Flask(__name__)
app.config["MAX_CONTENT_LENGTH"]=25*1024*1024
SR=22050
HOP=512
NOTES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
MAJ=np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],dtype=np.float32)
MIN=np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17],dtype=np.float32)
TEMPLATES=[]; NAMES=[]
for root in range(12):
    for suffix,profile in [("",MAJ),("m",MIN)]:
        v=np.roll(profile,root); v=(v-v.mean())/(np.linalg.norm(v-v.mean())+1e-9)
        TEMPLATES.append(v); NAMES.append(NOTES[root]+suffix)
TEMPLATES=np.stack(TEMPLATES)

def detect(path):
    y,sr=librosa.load(path,sr=SR,mono=True,duration=480,res_type="kaiser_fast")
    if not len(y): raise ValueError("קובץ השמע ריק או לא נתמך")
    duration=len(y)/sr
    harmonic,_=librosa.effects.hpss(y)
    chroma=librosa.feature.chroma_cqt(y=harmonic,sr=sr,hop_length=HOP).astype(np.float32)
    chroma-=chroma.mean(axis=0,keepdims=True)
    chroma/=np.maximum(np.linalg.norm(chroma,axis=0,keepdims=True),1e-8)
    scores=TEMPLATES@chroma
    best=np.argmax(scores,axis=0)
    best=median_filter(best.astype(np.int32),size=9 if len(best)>=9 else 3,mode="nearest")
    times=librosa.frames_to_time(np.arange(len(best)),sr=sr,hop_length=HOP)
    out=[]; start=0
    for i in range(1,len(best)+1):
        if i<len(best) and best[i]==best[start]: continue
        end=float(times[i]) if i<len(times) else duration
        if end-float(times[start])>=0.35:
            out.append({"start":round(float(times[start]),3),"end":round(min(end,duration),3),"chord":NAMES[int(best[start])],"confidence":round(float(np.clip(scores[best[start],start:i].mean(),0,1)),3)})
        start=i
    merged=[]
    for e in out:
        if merged and merged[-1]["chord"]==e["chord"]:
            merged[-1]["end"]=e["end"]
        else: merged.append(e)
    if merged: merged[0]["start"]=0.0; merged[-1]["end"]=round(duration,3)
    return {"engine":"librosa","source":"Python + librosa","duration":round(duration,3),"sample_rate":sr,"chords":merged}

@app.get("/health")
def health(): return jsonify(ok=True,engine="librosa")
@app.post("/analyze")
def analyze():
    token=os.getenv("LOCAL_AUDIO_ENGINE_TOKEN","")
    if not token or request.headers.get("Authorization","")!="Bearer "+token:
        return jsonify(error="Unauthorized"),401
    f=request.files.get("audio") or request.files.get("file")
    if not f: return jsonify(error="Missing audio file"),400
    suffix=Path(f.filename or "audio.wav").suffix.lower()
    if suffix not in {".mp3",".wav",".m4a",".ogg",".flac",".aac",".webm"}:
        return jsonify(error="Unsupported audio format"),400
    path=None
    try:
        with tempfile.NamedTemporaryFile(delete=False,suffix=suffix) as tmp:
            path=tmp.name; f.save(tmp)
        return jsonify(detect(path))
    except ValueError as e: return jsonify(error=str(e)),400
    except Exception as e:
        app.logger.exception("Librosa analysis failed")
        return jsonify(error="Librosa analysis failed",details=str(e)),500
    finally:
        if path:
            try: os.unlink(path)
            except OSError: pass
if __name__=="__main__": app.run(host="0.0.0.0",port=int(os.getenv("PORT","10000")))
