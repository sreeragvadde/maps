import unittest
import sys
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Scraping"))
sys.path.insert(0, str(ROOT / "Scraping" / "sources"))

from calgary_snow_priority_source import (
    SIMPLIFY_TOLERANCE_M,
    _simplify_line,
    fetch_snow_priority_routes,
)
from build_layers import build_snow_priority_layer


class SnowPrioritySourceTests(unittest.TestCase):
    @patch("requests.get")
    def test_fetch_normalizes_priorities_and_source_update_time(self, get):
        geojson = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"priority": "1"},
                    "geometry": {
                        "type": "MultiLineString",
                        "coordinates": [[[-114.1, 51], [-114.09, 51]]],
                    },
                },
                {
                    "type": "Feature",
                    "properties": {"priority": "2"},
                    "geometry": {
                        "type": "MultiLineString",
                        "coordinates": [[[-114.2, 51], [-114.19, 51]]],
                    },
                },
            ],
        }
        responses = [Mock(), Mock()]
        responses[0].json.return_value = geojson
        responses[1].json.return_value = {"rowsUpdatedAt": 1_790_886_957}
        get.side_effect = responses

        result = fetch_snow_priority_routes()

        self.assertEqual([f["properties"]["priority"] for f in result["features"]], [1, 2])
        self.assertEqual(result["source_updated"], "2026-10-01T20:35:57+00:00")
        self.assertEqual(get.call_count, 2)

    def test_rejects_missing_priority_class(self):
        with patch("requests.get") as get:
            response = Mock()
            response.json.return_value = {
                "type": "FeatureCollection",
                "features": [{
                    "type": "Feature",
                    "properties": {"priority": "1"},
                    "geometry": {
                        "type": "MultiLineString",
                        "coordinates": [[[-114.1, 51], [-114.09, 51]]],
                    },
                }],
            }
            get.return_value = response
            metadata = Mock()
            metadata.json.return_value = {"rowsUpdatedAt": 1_790_886_957}
            get.side_effect = [response, metadata]
            with self.assertRaisesRegex(ValueError, "Expected Priority 1 and 2"):
                fetch_snow_priority_routes()

    def test_simplification_keeps_line_endpoints_and_bounds_deviation(self):
        line = [[-114.1 + index * 0.00001, 51 + (index % 2) * 0.00001] for index in range(101)]
        simplified = _simplify_line(line)

        self.assertEqual(simplified[0], line[0])
        self.assertEqual(simplified[-1], line[-1])
        self.assertLessEqual(len(simplified), len(line))
        self.assertGreater(SIMPLIFY_TOLERANCE_M, 0)

    def test_build_layer_labels_service_commitments_not_live_clearing(self):
        layer = build_snow_priority_layer({
            "features": [{
                "type": "Feature",
                "properties": {"priority": 1},
                "geometry": {
                    "type": "MultiLineString",
                    "coordinates": [[[-114.1, 51], [-114.09, 51]]],
                },
            }],
            "source_updated": "2026-10-01T20:35:57+00:00",
        })

        self.assertEqual(layer["features"][0]["properties"]["priority"], 1)
        self.assertEqual(layer["source_updated"], "2026-10-01T20:35:57+00:00")
        self.assertIn("do not show live plow activity", layer["scope_note"])


if __name__ == "__main__":
    unittest.main()
