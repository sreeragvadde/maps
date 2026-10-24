"""City of Calgary snow and ice clearing priority street routes.

This annual dataset maps Priority 1 and Priority 2 streets. It describes
service commitments after snowfall ends; it does not report actual plow
activity or confirm that a segment has been cleared.
"""

from datetime import datetime, timezone
from math import cos, pi

DATASET_ID = "4v8s-3kss"
RESOURCE_URL = f"https://data.calgary.ca/resource/{DATASET_ID}.geojson"
METADATA_URL = f"https://data.calgary.ca/api/views/{DATASET_ID}.json"
SOURCE_URL = f"https://data.calgary.ca/d/{DATASET_ID}"
SIMPLIFY_TOLERANCE_M = 8


def _distance_to_segment(point, start, end, lat_scale):
    px, py = point[0] * lat_scale, point[1] * 111_320
    ax, ay = start[0] * lat_scale, start[1] * 111_320
    bx, by = end[0] * lat_scale, end[1] * 111_320
    dx, dy = bx - ax, by - ay
    length_squared = dx * dx + dy * dy
    fraction = 0 if not length_squared else max(
        0, min(1, ((px - ax) * dx + (py - ay) * dy) / length_squared)
    )
    return ((px - ax - fraction * dx) ** 2 + (py - ay - fraction * dy) ** 2) ** 0.5


def _simplify_line(line):
    """Douglas-Peucker simplification in local metre coordinates."""
    if len(line) <= 2:
        return [[float(point[0]), float(point[1])] for point in line]

    lat_scale = 111_320 * cos(sum(float(point[1]) for point in line) / len(line) * pi / 180)
    keep = {0, len(line) - 1}
    pending = [(0, len(line) - 1)]
    while pending:
        first, last = pending.pop()
        farthest_index = -1
        farthest_distance = SIMPLIFY_TOLERANCE_M
        for index in range(first + 1, last):
            distance = _distance_to_segment(line[index], line[first], line[last], lat_scale)
            if distance > farthest_distance:
                farthest_index, farthest_distance = index, distance
        if farthest_index >= 0:
            keep.add(farthest_index)
            pending.extend(((first, farthest_index), (farthest_index, last)))

    return [[float(line[index][0]), float(line[index][1])] for index in sorted(keep)]


def _source_updated_at(metadata):
    value = metadata.get("rowsUpdatedAt")
    if not isinstance(value, (int, float)):
        raise ValueError("Snow-priority metadata is missing its rowsUpdatedAt timestamp.")
    return datetime.fromtimestamp(value, tz=timezone.utc).isoformat(timespec="seconds")


def fetch_snow_priority_routes() -> dict:
    """Fetch and validate the official GeoJSON and its source update time."""
    import requests

    response = requests.get(RESOURCE_URL, params={"$limit": 10}, timeout=60)
    response.raise_for_status()
    raw = response.json()
    if raw.get("type") != "FeatureCollection" or not isinstance(raw.get("features"), list):
        raise ValueError("Snow-priority feed did not return a GeoJSON FeatureCollection.")

    metadata_response = requests.get(METADATA_URL, timeout=30)
    metadata_response.raise_for_status()
    source_updated = _source_updated_at(metadata_response.json())

    features = []
    priorities = set()
    for feature in raw["features"]:
        properties = feature.get("properties") or {}
        try:
            priority = int(properties.get("priority", properties.get("PRIORITY")))
        except (TypeError, ValueError) as error:
            raise ValueError("Snow-priority feed contains a record without a valid priority.") from error
        if priority not in (1, 2):
            raise ValueError(f"Unsupported snow-clearing priority: {priority}.")

        geometry = feature.get("geometry") or {}
        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates")
        if geometry_type == "LineString":
            lines = [coordinates]
            normalized_type = "MultiLineString"
        elif geometry_type == "MultiLineString":
            lines = coordinates
            normalized_type = geometry_type
        else:
            raise ValueError(f"Unsupported snow-priority geometry: {geometry_type!r}.")
        if not isinstance(lines, list):
            raise ValueError("Snow-priority geometry has no line coordinates.")

        simplified = []
        for line in lines:
            if not isinstance(line, list) or len(line) < 2:
                continue
            normalized_line = _simplify_line(line)
            if len(normalized_line) >= 2:
                simplified.append(normalized_line)
        if not simplified:
            raise ValueError(f"Priority {priority} feature has no usable route geometry.")

        priorities.add(priority)
        features.append({
            "type": "Feature",
            "properties": {"priority": priority},
            "geometry": {"type": normalized_type, "coordinates": simplified},
        })

    if priorities != {1, 2}:
        raise ValueError(f"Expected Priority 1 and 2 routes; received {sorted(priorities)}.")

    return {"features": features, "source_updated": source_updated}
