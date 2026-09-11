# DisasterRelief

**AI-Powered Crisis Management Platform — Transforming chaotic disaster inputs into life-saving dispatch actions.**

Built for PromptWars with Google Gemini 2.5 Flash, Node.js/Express, and Google Cloud Run.

## 🌍 Societal Impact

In the critical first hours after a disaster, information is fragmented, chaotic, and overwhelming:

- Survivors report emergencies in **local dialects and minority languages** that standard responders cannot understand.
- Aerial imagery shows destruction, but nobody can quickly detect **survivors on rooftops** or **passable supply routes**.
- Medical teams face a flood of injured people but have **no rapid way to triage severity**.
- Malicious actors submit **fake or duplicated reports**, hijacking scarce and life-saving resources.

DisasterRelief ingests all of this unstructured, messy crisis input — voice notes, dialect speech, chaotic text, satellite and drone photos, injury images — and instantly converts it into **verified, structured, dispatch-ready actions**, dramatically accelerating the decision-making of first responders, EMTs, and coordination centers.

## 🔍 System Architecture

```
                              ┌─────────────────────────────┐
                              │   Frontend Dashboard (SPA)  │
                              │  Incident Intake + Dispatch │
                              └──────────────┬──────────────┘
                                             │ HTTP / JSON
                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                         Express API (Cloud Run)                    │
│  /api/translate  /api/translate/audio  /api/drone  /api/triage    │
│  /api/scam       /health                                          │
└─────────────┬──────────────────────────────────────────────────────┘
              │ @google/genai
              ▼
   ┌───────────────────────────────────────┐
   │    Gemini 2.5 Flash (JSON-guided)     │
   │  Multimodal: text · audio · vision     │
   └───────────────────────────────────────┘
```

### Feature Modules

| Module | Endpoint | Input | Output |
|--------|----------|-------|--------|
| **Multilingual & Dialect Translator** | `POST /api/translate` · `POST /api/translate/audio` | Chaotic dialect text or voice note | `original_language`, `english_translation`, `key_intent`, `detected_urgency`, `location` (GPS/place) |
| **Satellite & Drone Analysis** | `POST /api/drone` | Aerial file upload or image URL | `damage_type`, `severity_score` (1–10), `passable_routes`, `survivors_detected` |
| **Dynamic Medical Triage** | `POST /api/triage` | Injury photo and/or victim description | `triage_level` (RED/YELLOW/GREEN), `recommended_first_aid_steps`, `required_medical_supplies` |
| **AI Sybil & Scam Filter** | `POST /api/scam` | One or many reports | `confidence_score` (0–100), `is_flagged_as_scam`, `risk_factors`, `reasoning` |
| **Gemini Location Extraction** | `POST /api/locate` | Unstructured text | `latitude`, `longitude`, `address`, `confidence` |
| **Rescue Supply Routing** | `POST /api/route-supplies` | Victim location + depot list + requested items | Nearest depot, `distance_km`, `eta_minutes`, `polyline`, reasoning |
| **Supply Depot Registry** | `GET /api/route-supplies/depots` | — | Seeded verified depots with live inventory |
| **Hazard / Disaster Feed** | `GET /api/hazards` · `GET /api/hazards/nearby` | lat/lng + radius | Ranked nearby hazards with severity |
| **Grid & Sector Matrix** | `GET /api/sectors` | — | 16-zone matrix (A1–D4) with primary hubs & serving hubs |
| **Intelligent Supply Matching** | `POST /api/match-supplies` | Sector / coords / text + requested items + triage | `assigned_depot_name`, `target_sector_id`, `estimated_transit_time_mins`, `priority_rank`, `step_by_step_directions_text` |

### 🧠 Provider-Agnostic AI Backend (no Gemini subscription required)

All text AI is routed through `src/services/geminiService.js`, a provider abstraction selected by `LLM_PROVIDER`:

| Provider | Key needed | Best for | Notes |
|----------|-----------|----------|-------|
| `openai` *(default configured in .env)* | `OPENAI_API_KEY` | Everything incl. vision | Any OpenAI-compatible endpoint — **OpenRouter**, Groq, LM Studio |
| `ollama` | No | Local, offline | `ollama pull qwen2.5` (text) + `ollama pull qwen2.5vl` (vision) |
| `gemini` | `GEMINI_API_KEY` | Audio transcription | Only provider that can transcribe voice notes |
| unset | No | Demo | Deterministic key-less heuristics (see below) |

Concretely, `generateStructuredJSON` / `generateWithImage` / `generateWithAudio` talk to **OpenRouter's `https://openrouter.ai/api/v1`** (any OpenAI-compatible chat-completions endpoint) with `response_format: json_object`, and Gemini only when a key is present. Fail-safe priority:

1. Configured LLM (OpenRouter / Ollama / Gemini) → real AI analysis.
2. No LLM reachable → `src/services/keylessFallback.js` returns deterministic heuristic responses for translate, triage, scam, locate, and the grid parser so the whole platform stays testable offline.

**Voice notes (`/api/translate/audio`) are the one exception** — audio transcription requires `GEMINI_API_KEY`.

### 🗺️ Grid & Sector Matrix Dispatch System

The Dispatch Dashboard replaces any map-canvas with a **zero-external-dependency Grid & Sector Matrix Board** — a CSS grid of 16 zones (`A1`–`D4`), each mapped to a real district (e.g., `B2` Downtown Core, `C2` Waterfront & Harbor, `D4` SeaTac Airport):

- **Gemini Geodata Grid Parser** — unstructured crisis text is classified into a standardized Sector Matrix (`sector_id`, sector name, matched landmark, confidence) via Gemini JSON-guided calls when a `GEMINI_API_KEY` is present, with a **keyword landmark fallback** and a **coordinate nearest-sector resolver** so the system works even key-free.
- **Proximity Index (1–5)** — every sector is ranked per supply hub using grid adjacency (same sector = 1 … far = 5), fully deterministic, no map tiles or API subscriptions.
- **Structured Supply Matching (`POST /api/match-supplies`)** — matrix-lookup algorithm that scores each depot on:
  - **Sector Proximity** (matching/adjacent Grid Sector IDs weighted 45%)
  - **Supply Availability** (canonical item matching against live inventory, weighted 35%)
  - **Urgency Score** (RED triage in an identical grid sector is boosted 20%)
  
  It returns a structured routing payload: `assigned_depot_name`, `target_sector_id`, `estimated_transit_time_mins`, `priority_rank`, and a human-readable **step-by-step directions text** (staging → cargo → grid-lane route → ETA). No polyline, no map tiles, no canvas.
- **Visual Sector Board UI** — the dashboard renders a live CSS-grid matrix where each sector box highlights **active-incident counts color-coded by the highest triage level**, the **nearest supply hub status**, and a **"Dispatch Nearest Supplies"** button that renders the text-based route + ETA card directly on screen. Every incident card carries a sector chip and its own "Dispatch Supplies" action with an expandable step-by-step directions block.

Traditional road routing still exists as an option via `POST /api/route-supplies` (OSRM by default, Google Maps opt-in, Haversine fallback) for responders who need real turn-by-turn geometry, but the command dashboard is fully map-free.

## 📁 Project Structure

```
DisasterRelief/
├── Dockerfile
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── server.js                 # Express bootstrap + /health
│   ├── controllers/
│   │   ├── translateController.js
│   │   ├── droneController.js
│   │   ├── triageController.js
│   │   ├── scamController.js
│   │   ├── hazardController.js   # /hazards, /hazards/nearby
│   │   ├── supplyController.js   # /match-supplies, /sectors
│   │   └── routeController.js    # /route-supplies, /locate, depots
│   ├── services/
│   │   ├── geminiService.js      # @google/genai wrapper (gemini-2.5-flash)
│   │   ├── locationService.js    # Gemini geocoding of messy text
│   │   ├── gridService.js        # Gemini/keyword/coords → Sector Matrix (+ proximity)
│   │   ├── supplyMatcher.js      # matrix-lookup supply matching + directions text
│   │   └── routingService.js     # Google Maps + OSRM + Haversine routing
│   ├── routes/
│   │   ├── translateRoutes.js
│   │   ├── droneRoutes.js
│   │   ├── triageRoutes.js
│   │   ├── scamRoutes.js
│   │   └── routeRoutes.js
│   ├── data/
│   │   ├── sectorMatrix.js       # 16-zone grid A1–D4 + centers + adjacency
│   │   ├── hazards.js            # seeded hazard/disaster feed
│   │   └── supplyDepots.js       # seeded first-responder depots + inventory + served sectors
│   └── middleware/
│       └── errorHandler.js
└── public/
    ├── index.html                # SPA dashboard + Sector Matrix Board
    ├── css/styles.css
    ├── js/app.js
    └── uploads/
```

## 🚀 Local Setup (step-by-step)

### 1. Prerequisites

- [Node.js](https://nodejs.org) 20+ installed
- A free API key from **OpenRouter** (`openrouter.ai/api`) — or a `GEMINI_API_KEY` — or none at all (key-less heuristic mode)
- *(Optional)* [Ollama](https://ollama.com) for fully local, offline inference

### 2. Clone & install

```bash
git clone <GITHUB_REPO_LINK>
cd DisasterRelief
npm install
```

### 3. Configure environment

The `.env.example` documents every option. For the free **OpenRouter** path:

```bash
cp .env.example .env
# then edit .env:
#   LLM_PROVIDER=openai
#   OPENAI_BASE_URL=https://openrouter.ai/api/v1
#   OPENAI_API_KEY=sk-or-v1-your_openrouter_key_here   # free at openrouter.ai/api
#   OPENAI_MODEL=openai/gpt-4o-mini
#   PORT=8080
#   ROUTING_PROVIDER=osrm       # free default; google or haversine also supported
#   OSRM_BASE_URL=https://router.project-osrm.org
#   GOOGLE_MAPS_API_KEY=        # optional — leave blank for the free stack
```

Or skip the key entirely: leave `LLM_PROVIDER` unset and the platform falls back to **key-less heuristic mode** (Grid/Sector Matrix, hazards, supply matching, and simulated AI responses all still work).

### 4. Run locally

```bash
npm start
# or for auto-reload during development:
npm run dev
```

Open **http://localhost:8080** — you should see the Incident Intake form and the `● API Connected` badge.

### 5. Smoke-test the APIs

```bash
# Health check
curl http://localhost:8080/health

# Translate a dialect text
curl -X POST http://localhost:8080/api/translate \
  -H "Content-Type: application/json" \
  -d '{"text":"mizu ga kireta, tasukete"}'

# Drone image analysis (file upload)
curl -X POST http://localhost:8080/api/drone \
  -F "image=@aerial.jpg"

# Medical triage
curl -X POST http://localhost:8080/api/triage \
  -F "text=Deep cut on leg, bleeding heavily"

# Scam verification
curl -X POST http://localhost:8080/api/scam \
  -H "Content-Type: application/json" \
  -d '{"text":"We need 500 tents, 2000 blankets, 40 vehicles and unlimited supplies as soon as possible"}'

# Sector matrix (16 zones A1–D4 with hubs)
curl http://localhost:8080/api/sectors

# Intelligent supply matching (by coordinates)
curl -X POST http://localhost:8080/api/match-supplies \
  -H "Content-Type: application/json" \
  -d '{"latitude":47.6032,"longitude":-122.3299,"triage_level":"RED","requested_items":["Surgical bandages","Oxygen","IV fluids"]}'

# …or by unstructured text (Gemini grid parser with keyword fallback)
curl -X POST http://localhost:8080/api/match-supplies \
  -H "Content-Type: application/json" \
  -d '{"text":"Flooding near SeaTac airport terminal, need boats and food","triage_level":"RED","requested_items":["Boats","Food"]}'

# …or by explicit sector
curl -X POST http://localhost:8080/api/match-supplies \
  -H "Content-Type: application/json" \
  -d '{"sector_id":"C2","requested_items":["Water","Bandages"]}'
```

## 🇬🇧 Deploy to Google Cloud Run

```bash
# 1. Build image to Container Registry
gcloud builds submit --tag gcr.io/$GOOGLE_CLOUD_PROJECT/disasterrelief

# 2. Deploy to Cloud Run
gcloud run deploy disasterrelief \
  --image gcr.io/$GOOGLE_CLOUD_PROJECT/disasterrelief \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --set-env-vars GEMINI_API_KEY=your_gemini_api_key_here
```

Cloud Run will auto-configure the health check against the built-in `/health` endpoint.

### Deployed Cloud Run URL

🔗 **[Deployed Cloud Run URL] — https://your-deployment-xxxxxx.run.app** *(replace with your deployment's URL)*

### GitHub Repository

🔗 **[GitHub Repo Link] — https://github.com/your-org/DisasterRelief** *(replace with your repository URL)*

## ⚖️ Notes

- The platform is an **AI assistance layer**; all triage and dispatch decisions must be confirmed by qualified human responders.
- This project is not affiliated with Google; "Gemini" is a model by Google provided through the AI Studio / Vertex AI APIs.
- 🔗 Links marked *(replace…)* are placeholders for final deployment, per the PromptWars submission requirements.