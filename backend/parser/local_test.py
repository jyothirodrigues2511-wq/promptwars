"""Local contract test for the /parse Lambda.

Runs every test_events/*.json through lambda_handler directly and
validates the output shape against the frozen Aas-Paas /parse contract.

Usage:
    python local_test.py            # run all events
    python local_test.py sample3    # run one event by basename

Equivalent SAM one-liner when the CLI is available:
    sam local invoke ParserFunction -e test_events/sample1.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app import CATEGORIES, SORTS, lambda_handler

EVENTS_DIR = Path(__file__).resolve().parent / "test_events"


def validate(filters: dict) -> list[str]:
    errors = []

    if "category" not in filters or (
        filters["category"] is not None and filters["category"] not in CATEGORIES
    ):
        errors.append(f"category invalid: {filters.get('category')!r}")

    radius = filters.get("radius_km")
    if not isinstance(radius, (int, float)) or radius <= 0:
        errors.append(f"radius_km invalid: {radius!r}")

    if not isinstance(filters.get("open_now"), bool):
        errors.append(f"open_now not bool: {filters.get('open_now')!r}")

    sort_by = filters.get("sort_by")
    if sort_by is not None and sort_by not in SORTS:
        errors.append(f"sort_by invalid: {sort_by!r}")

    max_price = filters.get("max_price")
    if max_price is not None and (
        not isinstance(max_price, int) or max_price <= 0
    ):
        errors.append(f"max_price invalid: {max_price!r}")

    keywords = filters.get("keywords")
    if not isinstance(keywords, list) or not all(
        isinstance(k, str) for k in keywords
    ):
        errors.append(f"keywords invalid: {keywords!r}")

    extra = set(filters) - {"category", "radius_km", "open_now", "sort_by",
                            "max_price", "keywords"}
    if extra:
        errors.append(f"unexpected keys: {sorted(extra)}")

    if "lat" in filters or "lon" in filters or "location" in filters:
        errors.append("/parse must never return coordinates")

    return errors


def main() -> int:
    events = sorted(EVENTS_DIR.glob("*.json"))
    selected = sys.argv[1:]
    if selected:
        events = [
            e for e in events if e.stem in selected or e.name in selected
        ]
        if not events:
            print("no matching event files")
            return 2

    failed = 0
    for path in events:
        event = json.loads(path.read_text(encoding="utf-8"))
        response = lambda_handler(event, None)
        body = json.loads(response["body"])

        print(f"== {path.name}")
        print(f"   query   : {json.loads(event['body'])['query']}")
        print(f"   status  : {response['statusCode']}")

        if response["statusCode"] != 200:
            print(f"   ERROR: status {response['statusCode']}: {body}")
            failed += 1
            continue

        problems = validate(body)
        if problems:
            print(f"   CONTRACT VIOLATIONS: {problems}")
            failed += 1
        else:
            print(f"   OK: {json.dumps(body, ensure_ascii=False)}")

    print(f"\n{len(events) - failed}/{len(events)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())