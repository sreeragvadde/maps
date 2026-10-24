"""
OSM source.
Reads the raw Calgary cycling GeoJSON produced by the osmium pipeline
(Geofabrik Alberta extract -> tags-filter -> extract to Calgary boundary)
and normalizes every feature into the shared Phase-0 schema.

Two responsibilities live here, in this order:

1. GEOMETRY NORMALIZATION. osmium emits closed-loop ways (cul-de-sacs,
   roundabouts) as Polygon/MultiPolygon, which render as filled rectangles
   on the map. We convert every polygon ring into a LineString. This is a
   *pure geometry transform* — it does not decide what to keep or drop.

2. SEMANTIC FILTERING. A handful of features in the extract are real OSM
   areas but not cycling infrastructure (LRT platforms tagged
   `public_transport=platform`). These are dropped by name so the skip
   is visible in the log, distinct from schema rejections.

OSM gives you the NETWORK, not closures — so every surviving feature starts
as status="open". Closures get merged in later from the Calgary open data
source.

Contract for load_osm_features():
  - Returns a list of normalized features.
  - Returns [] ONLY when the file loaded successfully and genuinely
    contained zero features.
  - RAISES on file-not-found, JSON parse failure, or any other read
    error. Callers decide what to do; this function does not swallow
    failures into an ambiguous [].
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from schema import make_feature


# ---------------------------------------------------------------------------
# Geometry normalization
# ---------------------------------------------------------------------------

_PASSTHROUGH_GEOM_TYPES = {"LineString", "MultiLineString", "Point", "MultiPoint"}


def _ring_to_linestring_coords(ring: list) -> list:
    """Strip a GeoJSON polygon ring's closing vertex (last == first).

    OSM ways are open; GeoJSON polygon rings are closed. When we convert a
    ring back to a line, dropping the duplicate closing coordinate yields
    the conventional "open line that happens to form a loop" representation.
    """
    if len(ring) >= 2 and ring[0] == ring[-1]:
        return ring[:-1]
    return ring


def _polygon_geom_to_lines(geom: dict) -> dict:
    """Convert Polygon/MultiPolygon geometry to LineString/MultiLineString.

    Every ring (exterior and interior) becomes its own LineString, so no
    coordinates are silently discarded. Non-polygon geometry is returned
    unchanged, making this function idempotent.

    Raises ValueError on an unrecognized geometry type — a new type from
    osmium should be a loud failure, not a silent pass-through.
    """
    gtype = geom.get("type")

    if gtype in _PASSTHROUGH_GEOM_TYPES:
        return geom

    if gtype == "Polygon":
        rings = geom["coordinates"]
        lines = [_ring_to_linestring_coords(r) for r in rings]
        if len(lines) == 1:
            return {"type": "LineString", "coordinates": lines[0]}
        return {"type": "MultiLineString", "coordinates": lines}

    if gtype == "MultiPolygon":
        lines = [
            _ring_to_linestring_coords(ring)
            for polygon in geom["coordinates"]
            for ring in polygon
        ]
        if not lines:
            raise ValueError("MultiPolygon with no rings")
        if len(lines) == 1:
            return {"type": "LineString", "coordinates": lines[0]}
        return {"type": "MultiLineString", "coordinates": lines}

    raise ValueError(f"Unhandled geometry type in OSM extract: {gtype!r}")


def _fix_closed_loop_geometry(data: dict) -> tuple[dict, dict]:
    """Replace every polygon geometry in a FeatureCollection with lines.

    Returns (data, stats) where stats counts conversions by original type.
    Does not drop or filter any feature — that is a separate concern.
    """
    stats = {"Polygon": 0, "MultiPolygon": 0}
    for feature in data.get("features", []):
        geom = feature.get("geometry") or {}
        gtype = geom.get("type")
        if gtype in stats:
            feature["geometry"] = _polygon_geom_to_lines(geom)
            stats[gtype] += 1
    return data, stats


# ---------------------------------------------------------------------------
# Semantic filtering
# ---------------------------------------------------------------------------

def _is_cycling_infrastructure(props: dict) -> bool:
    """Reject OSM features that are real areas but not cycling ways.

    Deliberately narrow: this is not a router, and the permissive-filtering
    principle (include bicycle=yes / unconfirmed) lives in the tag-mapping
    functions below, not here. This only excludes things that are clearly a
    different kind of object.

    Currently excludes LRT / transit platforms, which osmium emits as
    `area=yes` polygons carrying `railway=platform` or
    `public_transport=platform` and — misleadingly for our purposes —
    `bicycle=yes` or `bicycle=designated`.
    """
    if props.get("railway") == "platform":
        return False
    if props.get("public_transport") == "platform":
        return False
    return True


# ---------------------------------------------------------------------------
# Tag mapping
# ---------------------------------------------------------------------------

def _facility_type_from_tags(props: dict) -> str:
    """Map raw OSM tags to one of our facility_type buckets."""
    highway = props.get("highway")
    if highway == "cycleway":
        return "cycle_track"
    if "cycleway" in props:  # e.g. cycleway=lane on a road way
        return "bike_lane"
    if highway in ("path", "footway"):
        return "pathway"
    if highway == "track":
        return "trail"
    return "shared_use"


def _bicycle_access_from_tags(props: dict) -> str:
    value = props.get("bicycle")
    if value in ("designated", "yes", "permissive"):
        return value
    return "unknown"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def load_osm_features(geojson_path: str) -> list[dict]:
    """Load and normalize OSM features.

    Raises on file-not-found or malformed JSON — the caller is responsible
    for deciding whether a failed load should overwrite existing data (it
    should not). Returns [] only for a successful load that contained zero
    features.
    """
    with open(geojson_path, "r") as f:
        data = json.load(f)

    data, geom_stats = _fix_closed_loop_geometry(data)
    if geom_stats["Polygon"] or geom_stats["MultiPolygon"]:
        print(
            f"[osm_source] geometry fix: converted "
            f"{geom_stats['MultiPolygon']} MultiPolygon, "
            f"{geom_stats['Polygon']} Polygon -> line geometry"
        )

    normalized = []
    skipped_non_cycling = 0
    skipped_schema = 0

    for raw_feature in data.get("features", []):
        props = raw_feature.get("properties", {})

        if not _is_cycling_infrastructure(props):
            skipped_non_cycling += 1
            continue

        try:
            normalized.append(
                make_feature(
                    geometry=raw_feature["geometry"],
                    source="osm",
                    facility_type=_facility_type_from_tags(props),
                    bicycle_access=_bicycle_access_from_tags(props),
                    status="open",
                    extra_properties={"osm_name": props.get("name")},
                )
            )
        except (KeyError, ValueError):
            skipped_schema += 1
            continue  # one bad feature shouldn't stop the whole load

    print(
        f"[osm_source] Loaded {len(normalized)} features, "
        f"skipped {skipped_non_cycling} non-cycling, "
        f"skipped {skipped_schema} schema-rejected"
    )
    return normalized


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <geojson_path>", file=sys.stderr)
        sys.exit(2)

    features = load_osm_features(sys.argv[1])
    print(f"First feature sample: {features[0] if features else 'none'}")