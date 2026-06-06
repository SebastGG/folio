FROM cloudron/base:4.2.0

COPY CloudronManifest.json /CloudronManifest.json

RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && apt-get clean

RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install fastapi uvicorn jinja2 python-multipart cryptography python-dotenv itsdangerous httpx

ARG BUILD_HASH=dev
RUN mkdir -p /app/code/static /app/code/templates
WORKDIR /app/code

COPY CloudronManifest.json .
COPY main.py .
COPY tax_engine.py .
COPY tax_engine_xml.py .
COPY start.sh .
RUN echo "$BUILD_HASH" > /app/code/build_hash.txt
COPY icon.png .
COPY static/ static/
COPY templates/ templates/

RUN chmod +x start.sh

CMD ["/app/code/start.sh"]