"""
Shared layer-building logic.

Extracted from merge.py so that both the full merge pipeline and the
closures-only refresh can produce identical output from identical inputs.
The point of this module is single-source-of-truth: if CLOSURE_KEEP or
the rounding precision or the `generated` timestamp format ever change,
they change here and nowhere else.

This module knows nothing about WHERE features came from — it takes
normalized schema features and produces slim GeoJSON FeatureCollections
ready to write. Validation happened earlier, in schema.py.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from schema import make_feature_collection

COORD_PRECISION = 5  # decimal places, ~1 m at Calgary's latitude — plenty for a city map, much smaller files

NETWORK_KEEP = (
    "facility_type", "bicycle_access", "osm_name", "highway", "surface",
    "cycleway", "cycleway_left", "cycleway_right", "incline", "ele",
)
CLOSURE_KEEP = ("status", "calgary_temporal_status", "start_date", "end_date", "detour_note")
SNOW_PRIORITY_SOURCE = (
    "https://data.calgary.ca/Health-and-Safety/"
    "Snow-and-Ice-Clearing-Priority-Routes/4v8s-3kss"
)


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------

def drop_past_closures(closures: list[dict]) -> list[dict]:
    """Remove closures the City has marked PAST. CURRENT and FUTURE stay;
    the map styles FUTURE ones in a muted way."""
    kept = [f for f in closures if f["properties"].get("calgary_temporal_status") != "PAST"]
    print(f"[build_layers] Dropped {len(closures) - len(kept)} PAST closure(s), kept {len(kept)}")
    return kept


# ---------------------------------------------------------------------------
# Slimming
# ---------------------------------------------------------------------------

def _round_coords(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], COORD_PRECISION), round(coords[1], COORD_PRECISION)]
    return [_round_coords(c) for c in coords]


def _slim(feature: dict, keep: tuple) -> dict:
    props = {k: feature["properties"][k] for k in keep if feature["properties"].get(k) is not None}
    geom = feature["geometry"]
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {"type": geom["type"], "coordinates": _round_coords(geom["coordinates"])},
    }


# ---------------------------------------------------------------------------
# Layer builders
# ---------------------------------------------------------------------------

def build_network_layer(osm_features: list[dict]) -> dict:
    """OSM lines only (tagged points stay in combined.geojson, not on the web map)."""
    lines = [_slim(f, NETWORK_KEEP) for f in osm_features if f["geometry"]["type"] == "LineString"]
    return make_feature_collection(lines)


def build_closures_layer(closures: list[dict]) -> dict:
    layer = make_feature_collection([_slim(f, CLOSURE_KEEP) for f in closures])
    layer["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")  # GeoJSON allows extra top-level members
    return layer


def build_snow_priority_layer(snow_data: dict) -> dict:
    """Build a deterministic, slim layer for official winter-priority routes."""
    features = [_slim(feature, ("priority",)) for feature in snow_data["features"]]
    return {
        **make_feature_collection(features),
        "source_updated": snow_data["source_updated"],
        "source_url": SNOW_PRIORITY_SOURCE,
        "attribution": "The City of Calgary",
        "scope_note": (
            "Priority routes show City snow-clearing service commitments after snowfall ends; "
            "they do not show live plow activity or confirm a route is currently clear."
        ),
    }


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def write_layer(path: Path, obj: dict) -> None:
    """Write a FeatureCollection to disk as compact JSON.

    Public (no leading underscore) because both merge.py and
    refresh_closures.py call it across module boundaries.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"[build_layers] Wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")