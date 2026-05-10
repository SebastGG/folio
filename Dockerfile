FROM cloudron/base:4.2.0

RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && apt-get clean

RUN python3 -m venv /app/venv && \
    /app/venv/bin/pip install fastapi uvicorn jinja2 python-multipart

RUN mkdir -p /app/code/static /app/code/templates
WORKDIR /app/code

COPY main.py .
COPY start.sh .
COPY icon.png .
COPY CloudronManifest.json .
COPY static/ static/
COPY templates/ templates/

RUN chmod +x start.sh

CMD ["/app/code/start.sh"]