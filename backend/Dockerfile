# AI-interview backend — FastAPI + async SQLAlchemy over ephemeral SQLite.
#
# The DB lives on the container's own writable disk under /app/data and is reseeded on every boot
# (see entrypoint.sh): alembic upgrade head → optional private client-bundle import → uvicorn.
FROM python:3.11-slim

# - Unbuffered stdout so [entrypoint] logs stream to Container Apps in real time.
# - Ephemeral, writable paths for the SQLite file and the local SOP blob store. These are picked up
#   by app.config.Settings; the Container App overrides them to the same /app/data locations too.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DATABASE_URL=sqlite+aiosqlite:///./data/ai_interview.db \
    MATERIAL_STORAGE_PATH=/app/data/_sop_storage

WORKDIR /app

# curl is used by the HEALTHCHECK below; tini is PID 1, so a process left behind by a killed
# LibreOffice conversion is reaped. LibreOffice (Writer, headless) prints Word SOPs to PDF
# for Document Intelligence; the Noto CJK and DejaVu fonts let it lay out Chinese and Latin text.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini \
        libreoffice-writer-nogui fonts-noto-cjk fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
# Every published image has a working LibreOffice: no fallback to the in-house Word converter.
ENV SOP_REQUIRE_LIBREOFFICE=1

# Install deps first (better layer caching). Copy only the packaging metadata, then the source.
# `pip install -e .[azure]` needs the app package present for the editable install to resolve.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --upgrade pip && pip install -e ".[azure]"
# The build fails unless LibreOffice really converts a Word file (Chinese included) to PDF.
COPY scripts/check_libreoffice.py ./scripts/check_libreoffice.py
RUN python scripts/check_libreoffice.py

# Migration + start-up assets. scripts/ holds fetch_client_bundle.py (the gitignored importer is
# NOT baked in — it arrives at boot inside the private client bundle).
COPY alembic.ini ./
COPY alembic ./alembic
COPY scripts ./scripts
COPY entrypoint.sh ./entrypoint.sh

RUN chmod +x entrypoint.sh && mkdir -p /app/data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
