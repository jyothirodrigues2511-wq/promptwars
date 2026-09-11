# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# PromptWars AI Teacher — production image for Google Cloud Run.
# Builds a slim, non-root, key-free runtime; GEMINI_API_KEY is
# injected by Cloud Run at runtime (Secret Manager), never baked in.
# ---------------------------------------------------------------

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Non-root user so the container never runs as root on Cloud Run.
RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid app app

# Install dependencies first (cached until requirements.txt changes).
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Project code + fixtures + mocks. .dockerignore keeps out .venv/ etc.
COPY --chown=app:app . ./

# Default demo run works with ZERO secrets (offline mock). Override via
# Cloud Run env vars:
#   GEMINI_API_KEY=<secret>   -> live Gemini mode
#   AI_TEACHER_MOCK=<path>    -> offline replay mode (or delete)
ENV AI_TEACHER_MODEL=gemini-2.5-flash \
    AI_TEACHER_MOCK=/app/mocks/fixture_mock.json

USER app

# Example: build the learner's lesson plan from a fixture.
CMD ["python", "-m", "planner.plan", "fixtures/plan_topic.json"]