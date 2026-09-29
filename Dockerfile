FROM debian:bookworm-slim AS vamp-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       curl \
       git \
       libboost-all-dev \
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
    && cp /opt/build/nnls-chroma/nnls-chroma.cat /opt/vamp/

RUN curl -fsSL \
      https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-linux64-static.tar.gz \
      -o /tmp/sonic-annotator.tar.gz \
    && mkdir -p /tmp/sonic-annotator \
    && tar -xzf /tmp/sonic-annotator.tar.gz -C /tmp/sonic-annotator \
    && find /tmp/sonic-annotator -type f -name sonic-annotator -exec cp {} /usr/local/bin/sonic-annotator \; \
    && chmod +x /usr/local/bin/sonic-annotator \
    && VAMP_PATH=/opt/vamp /usr/local/bin/sonic-annotator -l \
       | grep -Fq "vamp:nnls-chroma:chordino:simplechord"

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SONIC_ANNOTATOR_BIN=/usr/local/bin/sonic-annotator \
    VAMP_PATH=/opt/vamp

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
COPY --from=vamp-builder /usr/local/bin/sonic-annotator /usr/local/bin/sonic-annotator
COPY --from=vamp-builder /opt/vamp /opt/vamp

EXPOSE 10000

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-10000}"]
