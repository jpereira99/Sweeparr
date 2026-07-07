# ---- Stage 1: build the React SPA ----
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
# Vite is configured to emit into ../backend/static/spa; redirect it here.
RUN npm run build -- --outDir /spa --emptyOutDir

# ---- Stage 2: python runtime ----
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# Built SPA + the versioned inject script.
COPY --from=frontend /spa ./static/spa
# (static/inject/sweeparr.js is already copied with backend/)

ENV SWEEPARR_CONFIG_DIR=/config
VOLUME ["/config"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
