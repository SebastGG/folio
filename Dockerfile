FROM cloudron/base:5.1.0@sha256:1c0666c9abe9e2090d33686826d4e97769b799124573118d41e0d7485135748e
# Ubuntu 24.04, Python 3.12 (Tag + Digest: ein umgeschriebener Tag aendert das Abbild nicht still).

COPY CloudronManifest.json /CloudronManifest.json

RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && apt-get clean

COPY requirements.lock /tmp/requirements.lock
# Nur aus der Lock-Datei, nur fertige Wheels, jeder Hash wird geprueft.
RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: \
        -r /tmp/requirements.lock && rm /tmp/requirements.lock

ARG BUILD_HASH=dev
RUN mkdir -p /app/code/static /app/code/templates
WORKDIR /app/code

COPY CloudronManifest.json .
COPY main.py .
COPY tax_engine.py .
COPY tax_engine_xml.py .
COPY tax_engine_konvex.py .
COPY tax_pdf_konvex.py .
COPY screener.py .
COPY markt.py .
COPY universen.py .
COPY screening.py .
COPY konvex_tax/ konvex_tax/
COPY start.sh .
RUN echo "$BUILD_HASH" > /app/code/build_hash.txt
COPY icon.png .
COPY static/ static/
COPY templates/ templates/

RUN chmod +x start.sh

CMD ["/app/code/start.sh"]