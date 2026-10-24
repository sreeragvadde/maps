"""
City of Calgary Pathway Closures source.

Confirmed live endpoint — LINE geometry (esriGeometryPolyline), one
line per closed pathway segment, which is what you actually want for
merging against the OSM network:
  https://services1.arcgis.com/AVP60cs0Q9PEA8rH/ArcGIS/rest/services/Current_Pathway_Closures/FeatureServer/0

Real fields on this layer (from the service's own schema):
  NAME, CLOSURE_DETOUR, PURPOSE, STATUS, START_DATE, END_DATE,
  PUBLIC_VIEW, CREATED_DT, MODIFIED_DT, GLOBALID

Contract for fetch_closures():
  - Returns a list of normalized features.
  - Returns [] ONLY when the fetch succeeded and the feed genuinely
    contains zero closures.
  - RAISES on network/HTTP/JSON failure. Callers decide what to do;
    this function does not swallow failures into an ambiguous [].

IMPORTANT — verify before trusting this in production:
  Esri date fields come back as Unix epoch milliseconds, not strings —
  handled below. But the actual STRING VALUES inside STATUS and
  CLOSURE_DETOUR (e.g. is it "Active"/"Closed"? "Closure"/"Detour"?)
  haven't been confirmed against real data yet. Run this file directly
  once and print a few raw records before trusting the status mapping.
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from schema import make_feature

CLOSURES_ENDPOINT = (
    "https://services1.arcgis.com/AVP60cs0Q9PEA8rH/ArcGIS/rest/services/"
    "Current_Pathway_Closures/FeatureServer/0/query"
)
# CLOSURES_ENDPOINT = ("http://localhost:1/nope") # for testing guardrail, simulates bad connection


def _epoch_ms_to_iso(value) -> str | None:
    """Esri date fields are Unix epoch milliseconds. Convert to
    YYYY-MM-DD, or None if missing/unparseable."""
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date().isoformat()
    except (ValueError, TypeError, OSError):
        return None


def _map_status(closure_detour: str | None) -> str:
    """CLOSURE_DETOUR is the field that actually maps to our schema's
    status. Confirmed real values include "CLOSURE"; "DETOUR" is
    presumed from the field name but not yet seen in a sample record —
    verify if/when one shows up.
    """
    value = (closure_detour or "").strip().upper()
    if value == "CLOSURE":
        return "closed"
    if value == "DETOUR":
        return "detour"
    if value == "REDUCED":
        return "reduced"
    return "closed"  # conservative default for any unrecognized value


def fetch_closures() -> list[dict]:
    """Fetch and normalize current + future pathway closures.

    Raises on any network, HTTP, or JSON error — the caller is
    responsible for deciding whether a failed fetch should overwrite
    existing data (it should not). Returns [] only for a genuine
    successful fetch that contained zero features.
    """
    import requests

    resp = requests.get(
        CLOSURES_ENDPOINT,
        params={"where": "1=1", "outFields": "*", "f": "geojson"},
        timeout=30,
    )
    resp.raise_for_status()
    raw = resp.json()

    normalized = []
    for raw_feature in raw.get("features", []):
        try:
            props = raw_feature.get("properties", {})
            temporal_status = props.get("STATUS")
            if temporal_status == "PAST":
                continue  # expired closures aren't relevant to the map
            note_parts = [p for p in (props.get("NAME"), props.get("PURPOSE")) if p]
            normalized.append(
                make_feature(
                    geometry=raw_feature["geometry"],
                    source="calgary-open-data",
                    status=_map_status(props.get("CLOSURE_DETOUR")),
                    start_date=_epoch_ms_to_iso(props.get("START_DATE")),
                    end_date=_epoch_ms_to_iso(props.get("END_DATE")),
                    detour_note=" — ".join(note_parts) if note_parts else None,
                    # STATUS is temporal (CURRENT/FUTURE), not part of the
                    # open/closed schema — kept as raw context so the map
                    # can style FUTURE closures differently (muted).
                    extra_properties={"calgary_temporal_status": temporal_status},
                )
            )
        except (KeyError, ValueError):
            continue

    print(f"[calgary_closures_source] Loaded {len(normalized)} closures")
    return normalized


if __name__ == "__main__":
    # Run this directly first to eyeball 2-3 RAW records before trusting
    # the mapping above. This intentionally does NOT catch network errors —
    # if the endpoint is unreachable, you want to see the traceback.
    import requests

    resp = requests.get(
        CLOSURES_ENDPOINT,
        params={"where": "1=1", "outFields": "*", "f": "geojson", "resultRecordCount": 3},
        timeout=30,
    )
    print("RAW sample records:")
    for f in resp.json().get("features", []):
        print(" ", f["properties"])

    features = fetch_closures()
    print(f"\nNormalized result: {len(features)} features")