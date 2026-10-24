"""
Merge pipeline.

Calls every source independently (a broken source degrades the output
instead of crashing the run), drops expired closures, and writes:

  ../data/combined.geojson   full merged data, for inspection (61 MB+ —
                             add it to .gitignore, don't commit it)
  ../data/network.geojson    slim OSM lines for the web map
  ../data/closures.geojson   current + future closures for the web map

This is the FULL pipeline: it re-reads and re-normalizes the entire OSM
network on every run, which is expensive. Run it weekly (via
.github/workflows/refresh-network.yml) or on demand when the OSM input
changes. For the 3-hourly closure refresh, use refresh_closures.py
instead — it skips the OSM half entirely.

WRITE GATING: each output is written only when its inputs succeeded. A
failed source leaves its corresponding output file untouched, preserving
the last known-good version rather than overwriting it with empty data.
combined.geojson is written only when BOTH sources succeeded, since it
is the "everything, complete" view.

# to clear cache of combined.geojson:
# git rm --cached data/combined.geojson
# to open html local:
# python3 -m http.server 8000
"""

from pathlib import Path

from schema import make_feature_collection
from sources.osm_source import load_osm_features
from sources.calgary_closures_source import fetch_closures

from build_layers import (
    build_closures_layer,
    build_network_layer,
    drop_past_closures,
    write_layer,
)

OSM_INPUT_PATH = Path(__file__).resolve().parent / "inputs/calgary_cycling_permissive.geojson"
# OSM_INPUT_PATH = Path(__file__).resolve().parent / "inputs/none.geojson"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def run():
    osm_ok, closures_ok = False, False
    osm, closures = [], []

    try:
        osm = load_osm_features(str(OSM_INPUT_PATH))
        osm_ok = True
    except Exception as e:
        print(f"[merge] OSM source failed: {e}")

    try:
        closures = drop_past_closures(fetch_closures())
        closures_ok = True
    except Exception as e:
        print(f"[merge] Calgary closures source failed: {e}")

    if osm_ok and closures_ok:
        write_layer(DATA_DIR / "combined.geojson", make_feature_collection(osm + closures))
    else:
        print(
            "[merge] Skipping combined.geojson — one or both sources failed; "
            "keeping last known-good file."
        )

    if osm_ok:
        write_layer(DATA_DIR / "network.geojson", build_network_layer(osm))
    else:
        print("[merge] Skipping network.geojson — OSM source failed.")

    if closures_ok:
        write_layer(DATA_DIR / "closures.geojson", build_closures_layer(closures))
    else:
        print("[merge] Skipping closures.geojson — closure source failed.")


if __name__ == "__main__":
    run()