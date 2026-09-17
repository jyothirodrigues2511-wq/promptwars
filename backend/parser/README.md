# backend/parser — NL query parser (Person 2)

Turns free-text queries into the frozen `/parse` contract:

    POST /parse   { "query": "any tiffin service open right now that's cheap" }
      -> { "category": "tiffin", "radius_km": 2.0, "open_now": true,
           "sort_by": "cheapest", "max_price": null, "keywords": ["tiffin"] }

The parser never returns lat/lon — the frontend supplies `user_location` to
`/search` separately.

## How it works
- Primary path: a **Strands Agents** agent (`from strands import Agent`) with a
  Pydantic `structured_output_model` extracts the filters.
- Fallback path: if no model provider is configured or the agent call fails
  (no AWS creds, Ollama down, timeout), a deterministic rule-based parser is
  used so the endpoint never 500s during a demo.
- Output is normalized against the enum values in the contract.

## Run locally (no SAM required)
    python local_test.py            # runs all test_events/*.json through lambda_handler
    python local_test.py sample3    # subset

With SAM installed:
    sam local invoke ParserFunction -e test_events/sample1.json

## Model provider config (env vars)
| Var | Values | Default |
|---|---|---|
| `PARSE_MODEL_PROVIDER` | `bedrock` \| `ollama` \| `fallback` | `bedrock` |
| `BEDROCK_MODEL_ID` | Bedrock model | `global.anthropic.claude-sonnet-4-6` |
| `OLLAMA_HOST` | Ollama server | `http://localhost:11434` |
| `OLLAMA_MODEL` | Ollama model | `llama3.1` |

Set `PARSE_MODEL_PROVIDER=fallback` to test purely with the rule-based parser.

## Note for Person 1 (infra)
If `PARSE_MODEL_PROVIDER=bedrock` is used on AWS, `ParserFunction` needs an
IAM policy allowing `bedrock:InvokeModel` (plus model-access enabled in
Bedrock). If we stick with `ollama` locally and `fallback` in prod, no
additional permission is required. See ground rules item 6 — flag in chat
rather than creating resources out-of-band.