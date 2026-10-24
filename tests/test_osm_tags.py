import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Scraping"))
sys.path.insert(0, str(ROOT / "Scraping" / "sources"))

from build_layers import build_network_layer
from osm_source import load_osm_features


class OSMTagRetentionTests(unittest.TestCase):
    def test_network_layer_retains_road_and_elevation_tags(self):
        raw = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[-114.0, 51.0], [-114.001, 51.001]],
                },
                "properties": {
                    "highway": "residential",
                    "surface": "asphalt",
                    "cycleway:left": "lane",
                    "incline": "3%",
                    "ele": "1045",
                    "bicycle": "designated",
                    "name": "Test Street",
                },
            }],
        }
        with tempfile.NamedTemporaryFile(mode="w", suffix=".geojson", encoding="utf-8") as source:
            json.dump(raw, source)
            source.flush()
            normalized = load_osm_features(source.name)

        network = build_network_layer(normalized)
        properties = network["features"][0]["properties"]
        self.assertEqual(properties["highway"], "residential")
        self.assertEqual(properties["surface"], "asphalt")
        self.assertEqual(properties["cycleway_left"], "lane")
        self.assertEqual(properties["incline"], "3%")
        self.assertEqual(properties["ele"], "1045")
        self.assertEqual(properties["osm_name"], "Test Street")


if __name__ == "__main__":
    unittest.main()
