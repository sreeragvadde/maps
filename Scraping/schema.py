"""
Shared schema for the Calgary cycling closures map.
Every source script (OSM, Calgary open data, etc.) should build its
output features through make_feature() so nothing downstream has to
guess what fields exist or what they're called.
"""

from datetime import date, datetime

VALID_FACILITY_TYPES = {
    "cycle_track", "bike_lane", "pathway", "trail", "shared_use", "unknown"
}
VALID_BICYCLE_ACCESS = {"designated", "yes", "permissive", "unknown"}
VALID_STATUS = {"open", "closed", "detour", "reduced"}


def make_feature(
    geometry: dict,
    source: str,
    facility_type: str = "unknown",
    bicycle_access: str = "unknown",
    status: str = "open",
    start_date: str | None = None,
    end_date: str | None = None,
    detour_note: str | None = None,
    extra_properties: dict | None = None,
) -> dict:
    """Build one GeoJSON Feature matching the project's shared schema.

    Raises ValueError if a field gets a value outside the allowed set —
    better to fail loudly here than silently pass bad data downstream.
    """
    if facility_type not in VALID_FACILITY_TYPES:
        raise ValueError(f"Unknown facility_type: {facility_type!r}")
    if bicycle_access not in VALID_BICYCLE_ACCESS:
        raise ValueError(f"Unknown bicycle_access: {bicycle_access!r}")
    if status not in VALID_STATUS:
        raise ValueError(f"Unknown status: {status!r}")

    properties = {
        "source": source,
        "facility_type": facility_type,
        "bicycle_access": bicycle_access,
        "status": status,
        "start_date": start_date,
        "end_date": end_date,
        "detour_note": detour_note,
        "last_verified": date.today().isoformat(),
    }
    if extra_properties:
        properties.update(extra_properties)

    return {"type": "Feature", "geometry": geometry, "properties": properties}


def make_feature_collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}
