"""
Closures-only refresh.

The 3-hourly entry point. Fetches fresh pathway closures from the City of
Calgary ArcGIS feed, drops PAST records, and writes ../data/closures.geojson.
Does NOT touch combined.geojson or network.geojson — those belong to
merge.py, which re-reads the OSM network and is correspondingly slower.

Exit codes:
  0  success. Either real closures were written, or the City genuinely
     reported zero closures (which is a true fact, not an error).
  1  fetch failed (network / HTTP / JSON). Existing closures.geojson was
     left UNTOUCHED. This is the fail-closed path: a failed fetch must
     never empty the published map.

Run from anywhere:
    python3 Scraping/refresh_closures.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sources.calgary_closures_source import fetch_closures
from build_layers import build_closures_layer, drop_past_closures, write_layer

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CLOSURES_PATH = DATA_DIR / "closures.geojson"

EXIT_OK = 0
EXIT_FETCH_FAILED = 1


def _existing_feature_count(path: Path) -> int:
    """Number of features currently in the on-disk closures.geojson, or 0
    if the file is missing or unparseable. Unparseable is treated as 0 so
    a corrupted file doesn't block a legitimate refresh."""
    try:
        with open(path) as f:
            return len(json.load(f).get("features", []))
    except (FileNotFoundError, json.JSONDecodeError):
        return 0


def main() -> int:
    existing_count = _existing_feature_count(CLOSURES_PATH)

    try:
        closures = drop_past_closures(fetch_closures())
    except Exception as e:
        print(f"[refresh_closures] Fetch failed: {e}", file=sys.stderr)
        print(
            f"[refresh_closures] Refusing to overwrite closures.geojson "
            f"({existing_count} feature(s) on disk). Published map keeps "
            f"its previous data.",
            file=sys.stderr,
        )
        return EXIT_FETCH_FAILED

    # Fetch succeeded. If it's empty, that's a true fact from the City's
    # feed — write the empty layer. If it's non-empty, write the real data.
    if not closures:
        print(
            f"[refresh_closures] City reports zero active closures "
            f"(existing file had {existing_count}). Writing empty layer."
        )
    write_layer(CLOSURES_PATH, build_closures_layer(closures))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())