#!/bin/bash
set -e

chown -R cloudron:cloudron /app/data

cd /app/code
exec /app/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
