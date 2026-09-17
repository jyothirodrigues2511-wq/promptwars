"""Aas-Paas query parser Lambda.

POST /parse  ->  { "query": "any tiffin service open right now that's cheap" }

Parses a natural-language query into structured search filters using a
Strands Agents agent with structured (Pydantic) output. The "AI agent"
path is primary; if no model provider is configured or the invocation
fails (no creds, Ollama down, etc.), it degrades to a deterministic
rule-based fallback so the API never breaks during a demo.

Deployed via AWS SAM (template owned by Person 1 / backend/infra) as
ParserFunction with handler `app.lambda_handler`.

Env vars:
  PARSE_MODEL_PROVIDER : "bedrock" (default) | "ollama" | "fallback"
  BEDROCK_MODEL_ID     : Bedrock model to use (default claude sonnet 4)
  OLLAMA_HOST          : http://localhost:11434
  OLLAMA_MODEL         : llama3.1
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

logger = logging.getLogger("aaspaas.parser")
if not logger.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s | %(name)s | %(message)s",
    )

CATEGORIES = ("pg", "mess", "tiffin", "print_shop", "atm", "other")
SORTS = ("cheapest", "nearest", "rating")

DEFAULT_RADIUS_KM = 2.0

try:  # pydantic is a strands dependency; guard anyway for the fallback path
    from pydantic import BaseModel, Field
except Exception:  # pragma: no cover - pydantic ships with strands-agents
    BaseModel = None  # type: ignore
    Field = None  # type: ignore


def _build_output_schema():
    if BaseModel is None:
        return None

    class ParseOutput(BaseModel):
        """Structured search filters extracted from a raw query."""

        category: Optional[str] = Field(
            default=None,
            description=(
                "One of: pg, mess, tiffin, print_shop, atm, other. "
                "Set null only if the query does not clearly map to a category."
            ),
        )
        radius_km: float = Field(
            default=DEFAULT_RADIUS_KM,
            description=(
                "Search radius in kilometres. Default 2.0 when the user does "
                "not mention a distance."
            ),
        )
        open_now: bool = Field(
            default=False,
            description=(
                "True only when the query asks for places open right now, e.g. "
                "'open now', 'currently open', 'open at this time'."
            ),
        )
        sort_by: Optional[str] = Field(
            default=None,
            description=(
                "Preferred ordering: 'cheapest' for cheap/budget, 'nearest' for "
                "closest/nearby, 'rating' for best/top-rated, else null."
            ),
        )
        max_price: Optional[int] = Field(
            default=None,
            description=(
                "Maximum price in rupees the user mentioned (e.g. 'under 50', "
                "'below 5000'), else null. Never invent one."
            ),
        )
        keywords: list[str] = Field(
            default_factory=list,
            description=(
                "Leftover descriptive terms useful for fuzzy text search, e.g. "
                "'veg', 'tiffin', 'colour print', 'shared'."
            ),
        )

    return ParseOutput


_SYSTEM_PROMPT = (
    "You extract structured campus-search filters from a student's short "
    "query. Rules:\n"
    "- category: exactly one of pg, mess, tiffin, print_shop, atm, other, or "
    "null when unclear. 'print/xerox/photocopy' -> print_shop. "
    "'PG/hostel' -> pg. 'ATM/cash/withdraw' -> atm. 'tiffin/dabba' -> tiffin. "
    "'mess/food/lunch/dinner' -> mess.\n"
    "- radius_km: default 2.0. Only change it when the user names a distance "
    "('within 1km', 'near 500m').\n"
    "- open_now: true only for 'open now / right now / currently open'.\n"
    "- sort_by: 'cheapest' for cheap/budget, 'nearest' for closest, 'rating' "
    "for best/top-rated, else null.\n"
    "- max_price: only from an explicit rupee amount ('under 50', 'budget "
    "3000', 'Rs 40'), else null.\n"
    "- keywords: leftover descriptive words for fuzzy search; always include "
    "the category word. Never return coordinates.\n"
    "Respond only with the structured output."
)


def _create_agent():
    """Create a Strands agent for the configured provider (or None)."""
    provider = os.environ.get("PARSE_MODEL_PROVIDER", "bedrock").strip().lower()
    if provider == "fallback":
        return None

    from strands import Agent

    kwargs: dict[str, Any] = {"callback_handler": None}  # silence console spam

    if provider == "ollama":
        from strands.models.ollama import OllamaModel

        kwargs["model"] = OllamaModel(
            host=os.environ.get("OLLAMA_HOST", "http://localhost:11434"),
            model_id=os.environ.get("OLLAMA_MODEL", "llama3.1"),
            temperature=0,
        )
    elif provider == "bedrock":
        from strands.models import BedrockModel

        kwargs["model"] = BedrockModel(
            model_id=os.environ.get(
                "BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-4-6"
            ),
            temperature=0,
        )
    # else: fall through to Strands' default (Bedrock).

    return Agent(**kwargs)


_AGENT: Any = None
_AGENT_ERROR: Optional[str] = None


def _get_agent() -> Any:
    """Lazily build the agent once; return None if unavailable."""
    global _AGENT, _AGENT_ERROR
    if _AGENT_ERROR is not None:
        return None
    if _AGENT is None:
        try:
            _AGENT = _create_agent()
        except Exception as exc:  # noqa: BLE001 - degrade gracefully on any setup issue
            _AGENT_ERROR = str(exc)
            logger.warning(
                "Strands agent unavailable (%s); using deterministic fallback",
                exc,
            )
            _AGENT = None
    return _AGENT


# ---------------------------------------------------------------------------
# Deterministic fallback (heuristic)
# ---------------------------------------------------------------------------

_STOPWORDS = {
    "a", "an", "any", "the", "is", "at", "my", "i", "me", "and", "or", "to",
    "of", "for", "with", "that", "this", "which", "service", "services",
    "place", "places", "shop", "shops", "open", "now", "right", "currently",
    "still", "looking", "need", "want", "there", "what", "where", "please",
    "find", "nearby", "around", "some", "one", "who", "does", "do", "are",
    "it", "its", "under", "within", "than", "less", "above", "best", "good",
    "top", "rated", "rating", "cheap", "cheapest", "budget", "affordable",
    "cheaper", "inexpensive", "close", "closest", "near", "nearest", "can", "rupees", "rs", "per",
}

_CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("pg", ("pg", "hostel", "paying guest", "room for rent")),
    ("tiffin", ("tiffin", "dabba", "home food", "tiffin service")),
    (
        "mess",
        ("mess", "food", "canteen", "dining", "eatery", "lunch", "dinner",
         "breakfast", "meals", "snacks"),
    ),
    (
        "print_shop",
        ("print", "xerox", "photocopy", "photostat", "printing", "printout",
         "print out", "print shop"),
    ),
    ("atm", ("atm", "cash", "withdraw", "withdrawal")),
]

_OPEN_NOW_RE = re.compile(
    r"\b(open now|right now|currently open|open currently|open at this|"
    r"still open|open right now|open these|working now)\b",
    re.IGNORECASE,
)
_RADIUS_KM_RE = re.compile(
    r"(?:within|inside|near|around|under)\s*(\d+(?:\.\d+)?)\s*kms?",
    re.IGNORECASE,
)
_RADIUS_M_RE = re.compile(
    r"(?:within|inside|near|around|under)\s*(\d+)\s*m(?!etre|b|m)",
    re.IGNORECASE,
)
_PRICE_RE = re.compile(
    r"(?:under|below|less than|cheaper than|max|at most|budget of)\s*"
    r"[rRsS\u20b9\s]*(\d+)",
    re.IGNORECASE,
)
_PRICE_RS_RE = re.compile(r"(?:rs\.?|rupees|inr|\u20b9)\s*(\d+)", re.IGNORECASE)
_DIST_AFTER_RE = re.compile(
    r"\s*(?:kms?|kilometers?|kilometres?|metres?|meters?|m)\b",
    re.IGNORECASE,
)
_CHEAP_RE = re.compile(
    r"\b(cheap|cheapest|budget|affordable|inexpensive|cheaper|low cost|"
    r"value for money)\b",
    re.IGNORECASE,
)
_RATING_RE = re.compile(
    r"\b(best|top rated|top-rated|highest rated|highly rated|good rating|"
    r"well rated)\b",
    re.IGNORECASE,
)
_NEAREST_RE = re.compile(r"\b(closest|nearest)\b", re.IGNORECASE)


def _match_category(text: str) -> Optional[str]:
    for category, needles in _CATEGORY_KEYWORDS:
        for needle in needles:
            if re.search(rf"\b{re.escape(needle)}s?\b", text, re.IGNORECASE):
                return category
    return None


def _heuristic_parse(query: str) -> dict[str, Any]:
    text = query.strip()

    open_now = bool(_OPEN_NOW_RE.search(text))
    radius_km = DEFAULT_RADIUS_KM
    max_price: Optional[int] = None
    sort_by: Optional[str] = None

    m = _RADIUS_KM_RE.search(text)
    if m:
        radius_km = float(m.group(1))
    else:
        m = _RADIUS_M_RE.search(text)
        if m:
            radius_km = max(0.1, float(m.group(1)) / 1000.0)

    for rx in (_PRICE_RE, _PRICE_RS_RE):
        m = rx.search(text)
        # "under 5 km" is a distance, not a price — skip when a unit follows.
        if m and not _DIST_AFTER_RE.match(m.string, m.end(1)):
            max_price = int(m.group(1))
            break

    if _CHEAP_RE.search(text):
        sort_by = "cheapest"
    elif _RATING_RE.search(text):
        sort_by = "rating"
    elif _NEAREST_RE.search(text):
        sort_by = "nearest"

    category = _match_category(text)

    keywords: list[str] = []
    for token in re.findall(r"[a-z0-9]+", text.lower()):
        if token[0].isdigit():
            continue
        if token in _STOPWORDS or len(token) < 3:
            continue
        if token not in keywords:
            keywords.append(token)
    if category:
        seed = {"tiffin": "tiffin", "print_shop": "print", "atm": "atm",
                "pg": "pg", "mess": "mess"}.get(category, category)
        if seed not in keywords:
            keywords.insert(0, seed)
    keywords = keywords[:8]

    return {
        "category": category,
        "radius_km": radius_km,
        "open_now": open_now,
        "sort_by": sort_by,
        "max_price": max_price,
        "keywords": keywords,
    }


# ---------------------------------------------------------------------------
# Public API used by the Lambda handler and tests
# ---------------------------------------------------------------------------

def parse_query(query: str) -> dict[str, Any]:
    """Return structured /parse filters for a free-text query."""
    agent = _get_agent()
    schema = _build_output_schema()

    if agent is not None and schema is not None:
        try:
            result = agent(
                query + "\n\n" + _SYSTEM_PROMPT,
                structured_output_model=schema,
            )
            raw = result.structured_output.model_dump()
            logger.info("Parsed via Strands agent -> %s", json.dumps(raw))
            return _normalize(raw)
        except Exception as exc:  # noqa: BLE001 - agent failure is not fatal
            logger.warning("Strands parse failed (%s); using fallback", exc)

    raw = _heuristic_parse(query)
    logger.info("Parsed via heuristic fallback -> %s", json.dumps(raw))
    return _normalize(raw)


def _normalize(filters: dict[str, Any]) -> dict[str, Any]:
    category = filters.get("category")
    if category not in CATEGORIES:
        category = None

    sort_by = filters.get("sort_by")
    if sort_by not in SORTS:
        sort_by = None

    try:
        radius_km = float(filters.get("radius_km", DEFAULT_RADIUS_KM))
    except (TypeError, ValueError):
        radius_km = DEFAULT_RADIUS_KM
    if radius_km <= 0:
        radius_km = DEFAULT_RADIUS_KM

    max_price = filters.get("max_price")
    if max_price is None:
        pass
    else:
        try:
            max_price = int(max_price)
        except (TypeError, ValueError):
            max_price = None
        if max_price is not None and max_price <= 0:
            max_price = None

    keywords = [
        k for k in (filters.get("keywords") or [])
        if isinstance(k, str) and k.strip()
    ]

    return {
        "category": category,
        "radius_km": radius_km,
        "open_now": bool(filters.get("open_now", False)),
        "sort_by": sort_by,
        "max_price": max_price,
        "keywords": keywords,
    }


def _read_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body") or {}
    if isinstance(body, (str, bytes)):
        if not body:
            return {}
        return json.loads(body if isinstance(body, str) else body.decode("utf-8"))
    return body if isinstance(body, dict) else {}


def _respond(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST,OPTIONS",
        },
        "body": json.dumps(payload, ensure_ascii=False),
    }


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """API Gateway handler for POST /parse."""
    try:
        if (event.get("httpMethod") or "POST").upper() == "OPTIONS":
            return _respond(200, {})  # CORS preflight
        payload = _read_body(event)
        query = str(payload.get("query") or "").strip()
        if not query:
            return _respond(400, {"error": "missing field: query"})
        filters = parse_query(query)
        return _respond(200, filters)
    except Exception as exc:  # noqa: BLE001 - never crash the endpoint
        logger.exception("Unhandled error in /parse")
        return _respond(500, {"error": str(exc)})


if __name__ == "__main__":
    import sys

    for q in sys.argv[1:] or [
        "any tiffin service open right now that's cheap",
        "print shop within 1km",
    ]:
        print(q, "->", json.dumps(parse_query(q)))