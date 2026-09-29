FROM debian:bookworm-slim AS vamp-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       curl \
       git \
       libboost-all-dev \
       libsndfile1-dev \
       pkg-config \
       python3 \
       squashfs-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/build

RUN git clone --depth 1 --branch vamp-plugin-sdk-v2.10 \
      https://github.com/vamp-plugins/vamp-plugin-sdk.git vamp-plugin-sdk \
    && cd vamp-plugin-sdk \
    && ./configure \
    && make -j2

RUN git clone --depth 1 https://github.com/c4dm/nnls-chroma.git nnls-chroma \
    && cd nnls-chroma \
    && make -f Makefile.linux VAMP_SDK_DIR=/opt/build/vamp-plugin-sdk

RUN mkdir -p /opt/vamp \
    && cp /opt/build/nnls-chroma/nnls-chroma.so /opt/vamp/ \
    && cp /opt/build/nnls-chroma/nnls-chroma.n3 /opt/vamp/ \
    && cp /opt/build/nnls-chroma/nnls-chroma.cat /opt/vamp/ \
    && cp -a /opt/build/vamp-plugin-sdk/libvamp-sdk.so* /opt/vamp/

RUN curl -fsSL \
      https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-linux64-static.tar.gz \
      -o /tmp/sonic-annotator.tar.gz \
    && mkdir -p /tmp/sonic-annotator \
    && tar -xzf /tmp/sonic-annotator.tar.gz -C /tmp/sonic-annotator \
    && APPIMAGE="$(find /tmp/sonic-annotator -type f -name sonic-annotator | head -1)" \
    && test -n "$APPIMAGE" \
    && chmod +x "$APPIMAGE" \
    && cd /tmp \
    && "$APPIMAGE" --appimage-extract \
    && mv /tmp/squashfs-root /opt/sonic-annotator \
    && test -x /opt/sonic-annotator/AppRun \
    && LD_LIBRARY_PATH=/opt/vamp VAMP_PATH=/opt/vamp /opt/sonic-annotator/AppRun -l \
       | grep -Fq "vamp:nnls-chroma:chordino:simplechord"

RUN python3 - <<'PY'
import math
import struct
import wave

rate = 22050
frames = rate * 2
with wave.open("/tmp/chordino-smoke.wav", "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    for n in range(frames):
        t = n / rate
        sample = (
            0.22 * math.sin(2 * math.pi * 261.6256 * t)
            + 0.17 * math.sin(2 * math.pi * 329.6276 * t)
            + 0.14 * math.sin(2 * math.pi * 392.0 * t)
        )
        value = max(-1.0, min(1.0, sample))
        w.writeframes(struct.pack("<h", int(value * 32767)))
PY

RUN LD_LIBRARY_PATH=/opt/vamp VAMP_PATH=/opt/vamp /opt/sonic-annotator/AppRun \
      -d vamp:nnls-chroma:chordino:simplechord /tmp/chordino-smoke.wav \
      -w csv --csv-stdout --csv-end-times --csv-fill-ends --csv-omit-filename \
      > /tmp/chordino-smoke.csv \
    && test -s /tmp/chordino-smoke.csv \
    && grep -Eq '^[0-9]' /tmp/chordino-smoke.csv

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    VAMP_PATH=/opt/vamp \
    SONIC_ANNOTATOR_BIN=/opt/sonic-annotator/AppRun \
    LD_LIBRARY_PATH=/opt/vamp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       ffmpeg \
       libsndfile1 \
       libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY web/audio-engine/requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY web/audio-engine/app.py /app/app.py
COPY --from=vamp-builder /opt/sonic-annotator /opt/sonic-annotator
COPY --from=vamp-builder /opt/vamp /opt/vamp

EXPOSE 10000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000}"]
