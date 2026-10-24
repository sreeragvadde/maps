#!/usr/bin/env python3
"""
doctor.py — preflight diagnostics for the Calgary Cycling Closures Map.

    python3 doctor.py            # human-readable, exit 0 if no errors
    python3 doctor.py --json     # machine-readable, for CI

Errors and warnings are named exception subclasses carrying a `hint`.
Add a check with the @check decorator; the runner picks it up automatically.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Layout — paths resolve relative to this file, so repo renames are safe.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent
SCRAPING  = REPO_ROOT / "Scraping"
SOURCES   = SCRAPING / "sources"
DATA      = REPO_ROOT / "data"
WEB       = REPO_ROOT / "web"

# ---------------------------------------------------------------------------
# Error hierarchy
# ---------------------------------------------------------------------------

class DoctorError(Exception):
    severity = "error"
    def __init__(self, message, *, hint=None, severity=None):
        super().__init__(message)
        self.message = message
        self.hint = hint
        if severity is not None:
            self.severity = severity

class EnvironmentProblem(DoctorError): ...
class MissingFile(DoctorError): ...
class SchemaViolation(DoctorError): ...
class GeoJSONInvalid(DoctorError): ...
class GeometryAnomaly(DoctorError): ...
class DataStale(DoctorError): ...
class WebAssetProblem(DoctorError): ...
class GitIgnoreProblem(DoctorError): ...

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

CHECKS: list[tuple[str, str, Callable[[], None]]] = []

def check(code: str, name: str):
    def deco(fn):
        CHECKS.append((code, name, fn))
        return fn
    return deco

# ---------------------------------------------------------------------------
# Schema expectations
# ---------------------------------------------------------------------------

# Value validation — applies whenever the field is present.
DEFAULT_ALLOWED = {
    "source":         {"osm", "calgary-open-data"},
    "facility_type":  {"cycle_track", "bike_lane", "pathway", "trail",
                       "shared_use", "unknown"},
    "bicycle_access": {"designated", "yes", "permissive", "unknown"},
    "status":         {"open", "closed", "detour", "reduced"},
}
VALUE_CHECKED = tuple(DEFAULT_ALLOWED.keys())

# Presence requirements — per file. Slim outputs only carry what the web page
# actually reads; the full schema applies only to combined.geojson (if present).
FULL_REQUIRED = ("source", "facility_type", "bicycle_access", "status")
REQUIRED_BY_FILE = {
    "combined.geojson":  FULL_REQUIRED,
    "network.geojson":   ("bicycle_access",),              # index.html styling
    "closures.geojson":  ("status", "calgary_temporal_status"),  # index.html styling
}

DATE_FIELDS = ("start_date", "end_date", "last_verified")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GeoJSONCache: dict[Path, Any] = {}

def _load_geojson(path: Path):
    if path in _GeoJSONCache:
        return _GeoJSONCache[path]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise MissingFile(f"Cannot read {path.name}: {e}",
                          hint=f"Expected file at {path}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise GeoJSONInvalid(
            f"{path.name} is not valid JSON: {e.msg} at line {e.lineno}, col {e.colno}",
            hint="Re-run the pipeline to regenerate it.",
        )
    _GeoJSONCache[path] = data
    return data

def _first_keys(fc: dict, n: int = 1) -> list[str]:
    feats = fc.get("features") or []
    for f in feats[:n]:
        if isinstance(f, dict):
            props = f.get("properties")
            if isinstance(props, dict):
                return sorted(props.keys())
    return []

def _grep_lines(path: Path, needles: list[str], ignore_case: bool = True,
                limit: int = 12) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        hay = line.lower() if ignore_case else line
        if any((n.lower() if ignore_case else n) in hay for n in needles):
            out.append(f"{i}: {line.rstrip()[:140]}")
            if len(out) >= limit:
                break
    return out

def _probe_allowed_from_schema() -> dict[str, set[str]]:
    schema_path = SCRAPING / "schema.py"
    if not schema_path.exists():
        return dict(DEFAULT_ALLOWED)
    spec = importlib.util.spec_from_file_location("_project_schema", schema_path)
    if spec is None or spec.loader is None:
        return dict(DEFAULT_ALLOWED)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception:
        return dict(DEFAULT_ALLOWED)
    name_hints = {
        "source":         ("SOURCES", "ALLOWED_SOURCES", "SOURCE_VALUES"),
        "facility_type":  ("FACILITY_TYPES", "ALLOWED_FACILITY_TYPES",
                           "FACILITY_TYPE_VALUES"),
        "bicycle_access": ("BICYCLE_ACCESS", "ALLOWED_BICYCLE_ACCESS",
                           "BICYCLE_ACCESS_VALUES"),
        "status":         ("STATUSES", "ALLOWED_STATUSES", "STATUS_VALUES"),
    }
    out = dict(DEFAULT_ALLOWED)
    for field, names in name_hints.items():
        for n in names:
            v = getattr(mod, n, None)
            if isinstance(v, (set, frozenset, list, tuple)) and v:
                out[field] = set(v)
                break
    return out

def _git_info() -> dict:
    """Return {'is_repo': bool, 'root': Path|None, 'ignore_files': [Path,...]}."""
    if shutil.which("git") is None:
        return {"is_repo": False, "root": None, "ignore_files": []}
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        return {"is_repo": False, "root": None, "ignore_files": []}
    root = Path(r.stdout.strip())
    ignores: list[Path] = []
    try:
        rel = REPO_ROOT.resolve().relative_to(root.resolve())
    except ValueError:
        rel = Path("")
    walk = root
    for part in rel.parts:
        walk = walk / part
        gi = walk / ".gitignore"
        if gi.exists():
            ignores.append(gi)
    r2 = subprocess.run(["git", "config", "--get", "core.excludesfile"],
                        cwd=REPO_ROOT, capture_output=True, text=True)
    if r2.returncode == 0 and r2.stdout.strip():
        p = Path(r2.stdout.strip()).expanduser()
        if p.exists():
            ignores.append(p)
    return {"is_repo": True, "root": root, "ignore_files": ignores}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

@check("ENV-001", "Running inside WSL/Linux (not Windows Python)")
def check_platform():
    system = platform.system()
    if system == "Windows":
        raise EnvironmentProblem(
            f"Running under Windows Python ({system}), not WSL.",
            hint="Open a WSL Ubuntu terminal and run `python3 doctor.py` there. "
                 "All Python/pip/osmium/git commands must run inside WSL.",
        )
    if system == "Linux":
        try:
            proc = Path("/proc/version").read_text(encoding="utf-8").lower()
        except OSError:
            proc = ""
        if "microsoft" not in proc and "wsl" not in proc:
            raise EnvironmentProblem(
                "Linux detected, but /proc/version does not mention WSL.",
                severity="warning",
                hint="Fine on a native Linux host; the WSL warning is only "
                     "relevant for the developer's original setup.",
            )

@check("ENV-002", "Python version is at least 3.9")
def check_python_version():
    if sys.version_info < (3, 9):
        raise EnvironmentProblem(
            f"Python {sys.version.split()[0]} is too old.",
            hint="Upgrade Python inside WSL (e.g. `sudo apt install python3.11`).",
        )

# ---------------------------------------------------------------------------
# File layout
# ---------------------------------------------------------------------------

REQUIRED_PIPELINE_FILES = (
    SCRAPING / "schema.py",
    SCRAPING / "merge.py",
    SOURCES / "__init__.py",
    SOURCES / "osm_source.py",
    SOURCES / "calgary_closures_source.py",
    WEB / "index.html",
)

@check("FILE-001", "Required pipeline source files present")
def check_required_files():
    missing = [p for p in REQUIRED_PIPELINE_FILES if not p.exists()]
    if missing:
        rel = ", ".join(str(p.relative_to(REPO_ROOT)) for p in missing)
        raise MissingFile(
            f"Missing {len(missing)} required file(s): {rel}",
            hint="If you renamed a folder, update REPO_ROOT/SCRAPING/etc. in "
                 "doctor.py.",
        )

@check("FILE-002", "Data outputs exist (network.geojson, closures.geojson)")
def check_data_files():
    expected = (DATA / "network.geojson", DATA / "closures.geojson")
    missing = [p.name for p in expected if not p.exists()]
    if missing:
        raise MissingFile(
            f"Missing data output(s): {', '.join(missing)}",
            hint="Run `python3 Scraping/merge.py` to regenerate them.",
            severity="warning",
        )

@check("OSM-001", "OSM_INPUT_PATH is defined and points at an existing file")
def check_osm_input_path():
    if not SCRAPING.exists():
        return

    py_files = sorted(SCRAPING.rglob("*.py"))
    assign_re = re.compile(
        r"^[ \t]*(OSM[A-Z0-9_]*PATH[A-Z0-9_]*|OSM[A-Z0-9_]*INPUT[A-Z0-9_]*|"
        r"[A-Z0-9_]*OSM[A-Z0-9_]*PATH[A-Z0-9_]*)"
        r"[ \t]*=[ \t]*(.+?)[ \t]*$",
        re.M,
    )
    lit_re = re.compile(r"""^[rRbBfF]*['"](.+?)['"]""")

    # (file, name, rhs_expression)
    candidates: list[tuple[Path, str, str]] = []
    for py in py_files:
        try:
            text = py.read_text(encoding="utf-8")
        except OSError:
            continue
        for m in assign_re.finditer(text):
            candidates.append((py, m.group(1), m.group(2).strip()))

    if not candidates:
        raise MissingFile(
            "No OSM path constant found under Scraping/.",
            hint="The project summary expects a module-level constant named "
                 "something like OSM_INPUT_PATH. If your constant uses a "
                 "different name, either rename it or widen the regex in "
                 "check_osm_input_path().",
        )

    resolved: list[tuple[Path, str, Path, str]] = []   # file, name, value, how
    failures: list[str] = []

    for py, name, rhs in candidates:
        lit = lit_re.match(rhs)
        if lit:
            raw_value = lit.group(1)
            p = Path(raw_value)
            if not p.is_absolute():
                p = (py.parent / p).resolve()
            resolved.append((py, name, p, f"literal {raw_value!r}"))
            continue

        # Try to evaluate as a Python expression in a controlled namespace.
        # Deliberately do NOT expose builtins like open/exec/eval.
        sandbox = {
            "Path": Path,
            "PurePath": Path,      # fallback if someone imports PurePath as Path
            "__file__": str(py.resolve()),
            "__name__": "_doctor_probe_",
        }
        try:
            value = eval(rhs, {"__builtins__": {}}, sandbox)   # noqa: S307
        except Exception as e:
            failures.append(
                f"{py.relative_to(REPO_ROOT)}: {name} = {rhs}\n"
                f"            (could not evaluate: {type(e).__name__}: {e})"
            )
            continue

        if isinstance(value, Path):
            p = value if value.is_absolute() else (py.parent / value).resolve()
            resolved.append((py, name, p, f"Path expression {rhs}"))
        elif isinstance(value, str):
            p = Path(value)
            if not p.is_absolute():
                p = (py.parent / p).resolve()
            resolved.append((py, name, p, f"expression → {value!r}"))
        else:
            failures.append(
                f"{py.relative_to(REPO_ROOT)}: {name} = {rhs}\n"
                f"            (evaluated to {type(value).__name__}, not Path/str)"
            )

    if not resolved and failures:
        raise MissingFile(
            "OSM path constant(s) found but none could be evaluated:\n        "
            + "\n        ".join(failures),
            hint="If the RHS uses modules not available in the doctor's sandbox "
                 "(e.g. os.path, a helper function), either simplify it to a "
                 "Path(...) expression, or extend the sandbox in "
                 "check_osm_input_path().",
        )

    existing = [(f, n, p, how) for (f, n, p, how) in resolved if p.exists()]
    if existing:
        return   # at least one resolves — pass

    detail_lines = []
    for f, n, p, how in resolved:
        detail_lines.append(
            f"{f.relative_to(REPO_ROOT)}: {n}\n"
            f"            via {how}\n"
            f"            resolved to: {p}"
        )
    raise MissingFile(
        "OSM path constant(s) resolved, but none point at an existing file:\n        "
        + "\n        ".join(detail_lines),
        hint="Download the Alberta extract from Geofabrik, run osmium "
             "tags-filter + extract to clip it to Calgary, and point the "
             "constant at the resulting .geojson.",
    )

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

@check("SCHEMA-001", "Scraping/schema.py imports cleanly")
def check_schema_import():
    path = SCRAPING / "schema.py"
    if not path.exists():
        return
    spec = importlib.util.spec_from_file_location("_project_schema", path)
    if spec is None or spec.loader is None:
        raise SchemaViolation("Could not create an import spec for schema.py.")
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        raise SchemaViolation(
            f"schema.py raised on import: {type(e).__name__}: {e}",
            hint="schema.py should have no side effects at import time.",
        )
    if not hasattr(mod, "make_feature"):
        raise SchemaViolation(
            "schema.py does not define `make_feature`.",
            hint="make_feature() is the single writer for every feature.",
        )

def _check_feature_schema(fc: dict, path: Path, allowed: dict[str, set[str]]):
    if fc.get("type") != "FeatureCollection":
        raise GeoJSONInvalid(
            f"{path.name}: top-level `type` is {fc.get('type')!r}, "
            "expected 'FeatureCollection'.",
        )
    feats = fc.get("features")
    if not isinstance(feats, list):
        raise GeoJSONInvalid(f"{path.name}: `features` is not a list.")

    required = REQUIRED_BY_FILE.get(path.name, ())
    problems: list[str] = []

    for i, feat in enumerate(feats):
        if not isinstance(feat, dict):
            problems.append(f"feature {i}: not an object")
            continue
        if feat.get("type") != "Feature":
            problems.append(f"feature {i}: type={feat.get('type')!r}")
        props = feat.get("properties")
        if not isinstance(props, dict):
            problems.append(f"feature {i}: properties missing/not object")
            continue
        for key in required:
            if key not in props or props[key] in (None, ""):
                problems.append(f"feature {i}: missing required `{key}`")
        for key in VALUE_CHECKED:
            if key not in props or props[key] in (None, ""):
                continue
            vals = allowed.get(key)
            if vals and props[key] not in vals:
                problems.append(f"feature {i}: {key}={props[key]!r} not in {sorted(vals)}")
        for dk in DATE_FIELDS:
            dv = props.get(dk)
            if dv in (None, ""):
                continue
            try:
                datetime.fromisoformat(str(dv).replace("Z", "+00:00"))
            except ValueError:
                problems.append(f"feature {i}: {dk}={dv!r} not ISO-8601")

    if problems:
        head = problems[:8]
        tail = (f"\n          (+{len(problems) - len(head)} more)"
                if len(problems) > len(head) else "")
        keys = _first_keys(fc)
        keys_line = (f"\n        keys present on feature 0: {keys}"
                     if keys else "")
        req_line = (f"\n        required for {path.name}: {list(required)}"
                    if required else "")
        raise SchemaViolation(
            f"{path.name}: {len(problems)} schema problem(s):\n          "
            + "\n          ".join(head) + tail
            + req_line + keys_line,
            hint="If the key names here don't match what your source modules "
                 "emit, update REQUIRED_BY_FILE / VALUE_CHECKED at the top of "
                 "doctor.py. If they do match, this points at a source module "
                 "bypassing make_feature().",
        )

@check("SCHEMA-002", "network.geojson features satisfy its slim schema")
def check_network_schema():
    path = DATA / "network.geojson"
    if not path.exists():
        return
    _check_feature_schema(_load_geojson(path), path, _probe_allowed_from_schema())

@check("SCHEMA-003", "closures.geojson features satisfy its slim schema")
def check_closures_schema():
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    _check_feature_schema(_load_geojson(path), path, _probe_allowed_from_schema())

@check("SCHEMA-004", "combined.geojson (if present) satisfies the full schema")
def check_combined_schema():
    path = DATA / "combined.geojson"
    if not path.exists():
        return
    _check_feature_schema(_load_geojson(path), path, _probe_allowed_from_schema())

# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

BAD_LINE_TYPES = {"Polygon", "MultiPolygon"}

@check("GEO-001", "network.geojson contains no polygon artifacts")
def check_no_polygons():
    path = DATA / "network.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    bad = []
    for i, feat in enumerate(fc.get("features", [])):
        g = feat.get("geometry") or {}
        if g.get("type") in BAD_LINE_TYPES:
            name = (feat.get("properties") or {}).get("name") or "(unnamed)"
            bad.append(f"feature {i} [{g.get('type')}] {name}")
    if bad:
        head = bad[:5]
        tail = f" (+{len(bad) - len(head)} more)" if len(bad) > len(head) else ""
        raise GeometryAnomaly(
            f"network.geojson contains {len(bad)} polygon feature(s): "
            + "; ".join(head) + tail,
            hint="Closed-loop ways are leaking through as Polygons. Bake the "
                 "closed-loop fix into osm_source.py (Immediate next step #1).",
        )

@check("GEO-002", "closures.geojson features are LineString/MultiLineString")
def check_closure_geometry():
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    ok = {"LineString", "MultiLineString"}
    bad = []
    for i, feat in enumerate(fc.get("features", [])):
        g = feat.get("geometry") or {}
        if g.get("type") not in ok:
            bad.append(f"feature {i}: {g.get('type')!r}")
    if bad:
        head = bad[:5]
        tail = f" (+{len(bad) - len(head)} more)" if len(bad) > len(head) else ""
        raise GeometryAnomaly(
            f"{len(bad)} closure feature(s) have unexpected geometry: "
            + "; ".join(head) + tail,
            hint="The Calgary Pathway Closures layer is line geometry. If the "
                 "ArcGIS schema changed, update calgary_closures_source.py.",
        )

# ---------------------------------------------------------------------------
# Data freshness / hygiene
# ---------------------------------------------------------------------------

@check("DATA-001", "closures.geojson carries a top-level `generated` timestamp")
def check_generated_field():
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    gen = _load_geojson(path).get("generated")
    if not gen:
        raise SchemaViolation(
            "closures.geojson has no top-level `generated` field.",
            hint="merge.py should stamp this on write; index.html may read it "
                 "to display an 'as of' banner.",
        )
    try:
        datetime.fromisoformat(str(gen).replace("Z", "+00:00"))
    except ValueError:
        raise SchemaViolation(f"`generated` = {gen!r} is not parseable as ISO-8601.")

@check("DATA-002", "closures.geojson is fresh (< 8 hours old)")
def check_freshness():
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    gen = _load_geojson(path).get("generated")
    if not gen:
        return
    try:
        ts = datetime.fromisoformat(str(gen).replace("Z", "+00:00"))
    except ValueError:
        return
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_h = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    if age_h > 8:
        raise DataStale(
            f"closures.geojson was generated {age_h:.1f}h ago.",
            hint="Re-run `python3 Scraping/merge.py`, or wire up the GitHub "
                 "Actions cron job (Immediate next steps #4).",
            severity="warning",
        )

@check("DATA-003", "No PAST closures leaked into closures.geojson")
def check_no_past_closures():
    path = DATA / "closures.geojson"
    if not path.exists():
        return
    fc = _load_geojson(path)
    bad = [
        i for i, f in enumerate(fc.get("features", []))
        if (f.get("properties") or {}).get("calgary_temporal_status") == "PAST"
    ]
    if bad:
        raise SchemaViolation(
            f"{len(bad)} PAST closure(s) present in closures.geojson "
            f"(indices {bad[:5]}{'...' if len(bad) > 5 else ''}).",
            hint="merge.py is supposed to drop PAST closures — check the filter "
                 "against the `calgary_temporal_status` field.",
        )

# ---------------------------------------------------------------------------
# Web assets
# ---------------------------------------------------------------------------

@check("WEB-001", "index.html references the data files it needs")
def check_web_refs():
    path = WEB / "index.html"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    for needle in ("network.geojson", "closures.geojson"):
        if needle not in text:
            raise WebAssetProblem(
                f"web/index.html does not reference {needle!r}.",
                hint="The page should fetch ../data/network.geojson and "
                     "../data/closures.geojson relative to web/.",
            )

@check("WEB-002", "index.html carries required attributions")
def check_web_attributions():
    path = WEB / "index.html"
    if not path.exists():
        return
    low = path.read_text(encoding="utf-8").lower()
    missing = []
    if not any(t in low for t in ("attributioncontrol", "attribution",
                                  "attributions")):
        missing.append("MapLibre AttributionControl")
    if "openstreetmap" not in low and "osm" not in low and "©" not in low:
        missing.append("OpenStreetMap / ODbL credit")
    if "calgary" not in low:
        missing.append("City of Calgary Open Government Licence credit")
    if missing:
        hits = _grep_lines(path, ["attrib", "osm", "openstreetmap", "calgary"])
        body = ("\n        relevant lines in index.html:\n          "
                + "\n          ".join(hits)) if hits else \
               "\n        (no line mentioning attrib/osm/openstreetmap/calgary was found)"
        raise WebAssetProblem(
            f"index.html appears to be missing: {', '.join(missing)}." + body,
            hint="Both sources are licensed and require visible attribution.",
        )

# ---------------------------------------------------------------------------
# Git hygiene
# ---------------------------------------------------------------------------

@check("GIT-001", "data/combined.geojson is gitignored")
def check_combined_ignored():
    combined = DATA / "combined.geojson"
    if not combined.exists():
        return

    info = _git_info()
    if not info["is_repo"]:
        raise GitIgnoreProblem(
            "Not inside a git repository; cannot verify ignore status.",
            severity="warning",
            hint="Run `git init` at the repo root if this is a fresh checkout.",
        )

    rel = str(combined.relative_to(REPO_ROOT))
    r = subprocess.run(["git", "check-ignore", "-v", "--", rel],
                       cwd=REPO_ROOT, capture_output=True, text=True)
    if r.returncode == 0:
        return  # ignored — good

    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel],
        cwd=REPO_ROOT, capture_output=True, text=True,
    ).returncode == 0

    ignores = info["ignore_files"] or []
    gi_list = "\n          ".join(str(p) for p in ignores) if ignores else "(none found)"
    msg = (
        f"{rel} is NOT gitignored.\n"
        f"        git repo root    : {info['root']}\n"
        f"        working dir      : {REPO_ROOT}\n"
        f"        .gitignore files : \n          {gi_list}\n"
        f"        file is tracked  : {tracked}"
    )
    hint = (
        "Two common causes:\n"
        "          (1) Your git root is above this directory, and the "
        "`.gitignore` rule is anchored to the wrong folder. Either move "
        "`.gitignore` to the repo root, or use an un-anchored pattern like "
        "`combined.geojson` or `**/data/combined.geojson`.\n"
        "          (2) The file is already committed — .gitignore does not "
        "un-track. Run `git rm --cached data/combined.geojson` (keep it on "
        "disk) and re-run."
    )
    raise GitIgnoreProblem(msg, hint=hint)

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

@dataclass
class Outcome:
    code: str
    name: str
    error: DoctorError | None

def _run_all() -> list[Outcome]:
    outcomes = []
    for code, name, fn in CHECKS:
        try:
            fn()
        except DoctorError as e:
            outcomes.append(Outcome(code, name, e))
        except Exception as e:
            outcomes.append(Outcome(code, name, DoctorError(
                f"check crashed with {type(e).__name__}: {e}",
                hint="This is a bug in doctor.py, not in your project.",
            )))
        else:
            outcomes.append(Outcome(code, name, None))
    return outcomes

def _print_pretty(outcomes):
    print("Calgary Cycling Closures Map — Doctor")
    print("=" * 66)
    print(f"Repo root : {REPO_ROOT}")
    print(f"Platform  : {platform.system()} {platform.release()}")
    print(f"Python    : {sys.version.split()[0]}")
    print()
    for o in outcomes:
        if o.error is None:
            print(f"  PASS  {o.code}  {o.name}")
            continue
        tag = "WARN" if o.error.severity == "warning" else "FAIL"
        print(f"  {tag}  {o.code}  {o.name}")
        print(f"        [{type(o.error).__name__}] {o.error.message}")
        if o.error.hint:
            print(f"        hint: {o.error.hint}")
        print()
    n = len(outcomes)
    fails = sum(1 for o in outcomes if o.error and o.error.severity == "error")
    warns = sum(1 for o in outcomes if o.error and o.error.severity == "warning")
    print(f"{n} checks: {n - fails - warns} passed, {warns} warnings, {fails} failures")

def _print_json(outcomes):
    payload = {
        "repo_root": str(REPO_ROOT),
        "platform": platform.system(),
        "python": sys.version.split()[0],
        "outcomes": [
            {
                "code": o.code,
                "name": o.name,
                "status": "pass" if o.error is None
                          else "warn" if o.error.severity == "warning"
                          else "fail",
                "error_type": type(o.error).__name__ if o.error else None,
                "message": o.error.message if o.error else None,
                "hint": o.error.hint if o.error else None,
            } for o in outcomes
        ],
    }
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")

def main() -> int:
    ap = argparse.ArgumentParser(description="Project preflight diagnostics.")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable output for CI")
    args = ap.parse_args()
    outcomes = _run_all()
    _print_json(outcomes) if args.json else _print_pretty(outcomes)
    return 1 if any(o.error and o.error.severity == "error" for o in outcomes) else 0

if __name__ == "__main__":
    sys.exit(main())