"""Refresh Calgary's annual snow-clearing priority route layer.

The source updates annually. This can be run on schedule to publish new
source data while preserving the current layer if a fetch or validation fails.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from build_layers import build_snow_priority_layer, write_layer
from sources.calgary_snow_priority_source import fetch_snow_priority_routes

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "snow_priority_routes.geojson"


def main() -> int:
    try:
        snow_data = fetch_snow_priority_routes()
        layer = build_snow_priority_layer(snow_data)
    except Exception as error:
        print(f"[refresh_snow_priority] Refresh failed; keeping the last known-good layer: {error}",
              file=sys.stderr)
        return 1

    write_layer(DATA_PATH, layer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
