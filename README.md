# PromptWars — AI Teacher

Turn unstructured inputs (a topic, a learner's profile, a chatty request) into
**structured, validated actions**: a minute-exact lesson plan, a sequenced
learning path, a quiz, a teaching script, answer evaluation, and re-explanations.

Built for the **PromptWars** developer challenge on Google Cloud Run, using
**Gemini 2.5 Flash** to do the heavy language work and Pydantic contracts to
make every output predictable and safe.

> Societal benefit: quality private tutoring is expensive and scarce. This
> project makes a structured, 1:1 teacher experience affordable and scalable —
> any learner (level, language, time budget) can describe what they need in
> plain language and immediately receive an actionable, curriculum-validated
> lesson to follow.

## Live Links

| Resource | URL |
| --- | --- |
| Deployed Cloud Run service | `https://<your-service>-<hash>-<region>.run.app` — **TODO: replace after deploy** |
| GitHub repository | `https://github.com/<your-username>/promptwars` — **TODO: replace after push** |

---

## What it does

The repo is two cooperating halves plus shared contracts:

- **`planner/`** — decides *what* to teach
  - `plan.py` — lesson plan with per-concept minutes that sum **exactly** to the learner's time budget
  - `path.py` — multi-session learning path from a goal
  - `quiz.py` — final-quiz generation
  - `report.py` — session report card (score, strong/weak, next topic)
- **`teacher/`** — decides *how* to teach
  - `segment.py` — moment-by-moment teaching segments with citations
  - `evaluate.py` — marks a free-text answer and names the misconception
  - `reexplain.py` — tries a *new* analogy each time a learner is stuck
- **`shared/models.py`** — Pydantic contracts shared by both halves
- **`llm.py`** — the only file that talks to the Gemini SDK (dependency isolation)
- **`prompts.py`** — every prompt as a named, fillable template

Each pipeline step takes free-form natural language and emits **typed JSON** via
`llm.generate_json()`, so a webstore, chat UI, or API layer can act on the
output without any parsing heuristics.

## Technical overview — Gemini / Google integration

- **SDK**: [`google-genai`](https://pypi.org/project/google-genai/) (the current SDK, *not* `google-generativeai`).
- **Structured output**: every call requests `response_mime_type="application/json"`,
  temperature `0.4`, and up to 8192 output tokens (`llm.py`). Responses are
  force-parsed, the code strips stray markdown fences, and retries once on bad output.
- **Invariant enforcement outside the model**: the model *proposes*; the code
  *verifies*. `planner/plan.py` topologically re-sorts concepts and rescales
  minutes so `sum(concepts.minutes) == profile.time_minutes` exactly.
- **Config via environment**: key, model, and offline mock are read once at
  import (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AI_TEACHER_MODEL`,
  `AI_TEACHER_MOCK`). No secrets in code or `.env`.
- **Google Cloud**: deployed as a **Cloud Run** job/service from the included
  `Dockerfile`. In production the API key is injected at runtime via
  **Secret Manager**, so the image stays key-free and rebuildable by anyone.

## Local setup

Prerequisites: Python **3.10+** and a free [Google AI Studio](https://aistudio.google.com/) API key.

```bash
# 1. Clone
git clone https://github.com/<your-username>/promptwars.git
cd promptwars

# 2. Create and activate a virtual environment
python -m venv .venv
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# macOS / Linux:
source .venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Provide your key (choose ONE of these; never commit it)
# Windows (PowerShell):
$env:GEMINI_API_KEY="your-key-here"
# macOS / Linux:
export GEMINI_API_KEY="your-key-here"

# 5. Verify the whole pipeline offline (no key needed)
python check_offline.py

# 6. Run the test suite (offline, fake LLM)
python -m unittest discover -s tests -v

# 7. Live example against Gemini — build a lesson plan from a fixture
python -m planner.plan fixtures/plan_topic.json
```

Other live entry points:

```bash
python -m planner.path     fixtures/path_topic.json
python -m planner.quiz     fixtures/quiz_plan.json
python -m planner.report   fixtures/report_session.json
python -m teacher.segment  fixtures/segment_input.json
python -m teacher.evaluate fixtures/wrong_answer.json
python -m teacher.reexplain fixtures/reexplain.json
```

Fully offline runs (no key, no network) can replay canned Gemini responses with:

```bash
export AI_TEACHER_MOCK=mocks/fixture_mock.json
```

## Deploy to Cloud Run

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/promptwars
gcloud run deploy promptwars \
  --image gcr.io/YOUR_PROJECT_ID/promptwars \
  --region us-central1 \
  --set-env-vars AI_TEACHER_MODEL=gemini-2.5-flash \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --allow-unauthenticated
```

> The image defaults to an **offline mock** command so it boots with zero
> secrets. Point `GEMINI_API_KEY` (via Secret Manager) to switch it to live
> Gemini mode.

## Repository layout

```
.
├── planner/          # lesson planning: plan, path, quiz, report
├── teacher/          # delivery: segment, evaluate, reexplain
├── shared/           # Pydantic contracts (models.py)
├── fixtures/         # JSON inputs for CLI entry points
├── mocks/            # canned Gemini replies for offline runs
├── tests/            # unittest suite (fake LLM, no API key)
├── llm.py            # single Gemini access point
├── prompts.py        # prompt templates
├── check_offline.py  # end-to-end offline verification
├── requirements.txt
├── Dockerfile
└── .env.example
```