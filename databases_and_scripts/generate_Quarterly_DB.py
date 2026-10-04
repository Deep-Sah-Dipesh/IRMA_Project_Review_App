#!/usr/bin/env python3
"""
Quarterly data pipeline:  Excel workbook(s)  ->  CSV export  ->  clean  ->  SQLite  ->  validate/analyze

Usage:
    python build_quarterly_db.py             # build + swap in the new DB
    python build_quarterly_db.py --dry-run   # build + analyze in a temp file, keep nothing

Each quarter you normally only edit the CONFIG block below (DATA_DATE + file/sheet names).
Requires: pandas, openpyxl
"""
import math
import os
import re
import sys
import shutil
import sqlite3
import time
from collections import Counter
from datetime import datetime

import pandas as pd

# =============================================================================
# CONFIG  -- edit this section each quarter
# =============================================================================
DATA_DATE = "20261004-new"                       # used in the output DB / CSV folder names

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR  = BASE_DIR                        # folder containing the workbooks
OUTPUT_DIR = BASE_DIR                        # where the .db / CSV folder are written

DB_NAME    = f"mainDataBase_{DATA_DATE}.db"
EXPORT_CSVS = True                           # also dump every extracted sheet as a CSV for inspection
CSV_DIR    = os.path.join(OUTPUT_DIR, f"extracted_csv_{DATA_DATE}")

# ----- Review sheets ---------------------------------------------------------------------------
REVIEW_FILE = "IRMA-Review-Pro-Data-Oct.xlsx"
REVIEW_SHEET_TEMPLATE = "IRMA-Reviewed-{n}"      # sheet name; {n} is replaced by each number below

# Which review sheets to read. Edit freely: add a number to include a review, remove it to skip that review.
# Any order, gaps are fine, e.g. [1, 2, 3, 4, 5, 7, 9, 10]
REVIEW_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

# Whose contact details are saved in project_details (the IRMA person AND the State Officer).
# Reviews listed here are consulted FIRST, in this order. A review is only used for a project if it actually has a
# phone number or e-mail for that person; otherwise the next review is tried (priority ones first, then the rest).
# Use [] for no priority (fallback order below only).
REVIEW_PRIORITY = [9, 8, 7]

# Order in which reviews NOT listed in REVIEW_PRIORITY are tried afterwards:
#   "newest_first" = highest review number first (10, 7, 6, ...)    "oldest_first" = lowest first (1, 2, 3, ...)
REVIEW_FALLBACK_ORDER = "newest_first"

# "block" = the whole contact block (name, designation, phone, e-mail) comes from ONE review, so a name is never paired
#           with someone else's phone number. IRMA person and State Officer blocks are chosen independently.
# "field" = every field is taken separately from the first review that has a value (can mix people - not recommended).
REVIEW_CONTACT_MODE = "block"

# True = a review sheet that does not exist is skipped with a warning instead of stopping the build.
REVIEW_SKIP_MISSING = False

# Each source: workbook file + sheet name (case-insensitive).
#   "header_row": "auto" finds the header row by looking for the key column (handles the
#                 5 metadata rows above Project Details), or give a 0-based row number.
#   A ".csv" file name also works if a sheet ever arrives as CSV instead of Excel.
SOURCES = {
    "tenders":         {"file": "Project-Monitoring-Form-Data-Oct.xlsx", "sheet": "Tender Details",  "header_row": "auto"},
    "project_details": {"file": "Project-Monitoring-Form-Data-Oct.xlsx", "sheet": "Project Details", "header_row": "auto"},
    "observations":    {"file": "IRMA-Review-Pro-Data-Oct.xlsx",         "sheet": "Major-Observation", "header_row": "auto"},
    "reviews": [
        {"file": REVIEW_FILE, "sheet": REVIEW_SHEET_TEMPLATE.format(n=n), "header_row": "auto",
         "number": n, "optional": REVIEW_SKIP_MISSING}
        for n in dict.fromkeys(REVIEW_NUMBERS)          # duplicates ignored, your order kept
    ],
}

# Latitude/Longitude hygiene for project_details.
# Some source rows hold coordinates as packed degrees-minutes-seconds, e.g. 203614.54 = 20 deg 36' 14.54" N.
# True  = convert those to decimal degrees; anything still invalid (or outside India) is blanked, and if either of
#         a project's two coordinates is blanked, both are (a lone latitude is useless on a map).
#         Every change is listed in the log; the original values stay in the extracted CSV / source workbook.
# False = copy coordinates exactly as they appear in the sheet.
FIX_COORDINATES = True
INDIA_LAT = (6.0, 38.0)
INDIA_LON = (68.0, 98.0)

# Build is aborted (existing DB untouched) if any of these ends up with 0 rows.
REQUIRED_TABLES = ["project_details", "tenders", "observations"]

# =============================================================================
# SCHEMA  -- DB column -> accepted header names in the sheet (case/space-insensitive)
# =============================================================================
def norm(s):
    """Normalise a header/alias for matching: lowercase, collapse whitespace."""
    return re.sub(r"\s+", " ", str(s).replace("\u00a0", " ")).strip().lower()


def col(name, *aliases, src="main"):
    return (name, [norm(a) for a in aliases], src)


TABLE_SPECS = {
    "tenders": {
        "autoid": True, "pk": None, "key": "project_id", "source": "tenders",
        "cols": [
            col("project_id", "Project ID"), col("tender_id", "Tender ID"),
            col("tender_name", "Tender Name"), col("project_type", "Project Type"),
            col("project_title", "Project Title"), col("state", "State"),
            col("district", "District"), col("ulb", "ULB"),
            col("nit_date", "NIT Issued Date", "NIT Date"),
            col("award_date", "Contract Award Date", "Award Date"),
            col("bidder_name", "Successful Bidder Name", "Bidder Name"),
            col("capex", "CAPEX (in Cr.)", "Capex"),
            col("om", "O&M (in Cr.)", "O&M"),
            col("scope", "Brief Scope of Work", "Scope"),
            col("physical_progress", "Physical Progress (in %)", "Physical Progress"),
            col("financial_progress", "Financial Progress (in %)", "Financial Progress"),
            col("expenditure", "Expenditure Incurred (in Cr.)", "Expenditure"),
            col("finance_received", "Finance Received (in Cr.)", "Finance Received"),
            col("excess_expenditure", "Excess Expenditure incurred (in Cr.)", "Excess Expenditure"),
            col("justification", "Justification for excess expenditure incurred", "Justification"),
            col("actual_completion_date", "Actual Completion Date"),
            col("images", "Images"), col("updated_on", "Updated On"),
        ],
    },
    "project_details": {
        "autoid": False, "pk": "project_id", "key": "project_id", "source": "project_details",
        "cols": [
            col("project_id", "Project ID"), col("state", "State"), col("district", "District"),
            col("ulb", "ULB"), col("project_type", "Project Type"), col("project_title", "Project Title"),
            col("no_of_tenders", "No. of Tenders"),
            col("physical_progress", "Physical Progress (in %)", "Physical Progress"),
            col("financial_progress", "Financial Progress (in %)", "Financial Progress"),
            col("sch_project_completion_date", "Sch. Project Completion Date", "Scheduled Completion Date"),
            col("actual_completion_date", "Actual Completion Date"),
            col("water_body_name", "Water Body/Park Name", "Water Body Name"),
            col("area", "Area (in sq. km)", "Area"),
            col("latitude", "Latitude"), col("longitude", "Longitude"),
            col("est_capex", "Est. CAPEX (in Cr.)", "Estimated Capex (in Cr.)", "Est. Capex"),
            col("est_om", "Est. O&M (in Cr.)", "Estimated O&M (in Cr.)", "Est. O&M"),
            col("awarded_capex", "Awarded CAPEX (in Cr.)", "Awarded Capex"),
            col("awarded_om", "Awarded O&M (in Cr.)", "Awarded O&M"),
            # these come from the Review sheets, joined on project id == project code
            col("irma_personnel", "IRMA Personel", "IRMA Personnel", src="review"),
            col("designation", "Designation", src="review"),
            col("contact", "Contact Number", "Contact", src="review"),
            col("email", "E-mail", "Email", src="review"),
            col("state_officer", "State Officer", src="review"),
            col("so_contact", "State Officer Contact", src="review"),
            col("so_email", "State Officer E-mail", "State Officer Email", src="review"),
        ],
    },
    "observations": {
        "autoid": True, "pk": None, "key": "project_code", "source": "observations",
        "cols": [
            col("project_code", "Project Code", "Project ID"), col("state", "State"), col("ulb", "ULB"),
            col("project_type", "Project Type"), col("project_title", "Project Title"),
            col("visit_date", "Date of Visit"), col("form_type", "Form-Type", "Form Type"),
            col("category", "Category"), col("component", "Component"), col("severity", "Severity"),
            col("observations", "IRMA Major Observations", "Observations"),
        ],
    },
}

# Contact blocks: columns that must come from the SAME review row. 'needs_any_of' = a review only counts as having
# contact details for the block if at least one of these is filled.
CONTACT_BLOCKS = {
    "irma_person":   {"fields": ["irma_personnel", "designation", "contact", "email"],
                      "needs_any_of": ["contact", "email"]},
    "state_officer": {"fields": ["state_officer", "so_contact", "so_email"],
                      "needs_any_of": ["so_contact", "so_email"]},
}

# Header text that must be present to recognise the header row of each sheet type
ANCHORS = {
    "tenders": ["project id"], "project_details": ["project id"],
    "observations": ["project code", "project id"], "reviews": ["project code", "project id"],
}

# =============================================================================
# HELPERS
# =============================================================================
LOG_LINES = []


def log(msg=""):
    print(msg)
    LOG_LINES.append(msg)


NULL_TOKENS = {"nan", "none", "nat", "<na>", "null", ""}
_MIDNIGHT = re.compile(r"^(\d{4}-\d{2}-\d{2}) 00:00:00$")
_FLOAT_INT = re.compile(r"^-?\d+\.0$")


def clean_cell(x):
    """One cell -> clean string ('' for empty). Fixes Excel-isms: midnight timestamps, '12.0' ints, newlines."""
    if x is None or (not isinstance(x, str) and pd.isna(x)):
        return ""
    s = str(x).replace("\r\n", " ").replace("\n", " ").replace("\r", " ").replace("\u00a0", " ")
    s = re.sub(r"\s{2,}", " ", s).strip()
    if s.lower() in NULL_TOKENS:
        return ""
    s = _MIDNIGHT.sub(r"\1", s)
    if _FLOAT_INT.match(s):          # phone numbers / counters that Excel stored as numbers
        s = s[:-2]
    return s


_SERIAL = re.compile(r"^\d{5}(\.\d+)?$")


def clean_dates(df):
    """If styles were lost, Excel dates arrive as serial numbers (e.g. 46204). Convert them in date-like columns."""
    for c in df.columns:
        n = norm(c)
        if "date" in n or n == "updated on":
            def fix(v):
                if _SERIAL.match(v) and 20000 <= float(v) <= 80000:
                    return (datetime(1899, 12, 30) + pd.to_timedelta(float(v), unit="D")).strftime("%Y-%m-%d")
                return v
            df[c] = df[c].map(fix)
    return df


def dedupe_headers(headers):
    seen, out = {}, []
    for h in headers:
        if not h:
            out.append("")
            continue
        n = norm(h)
        seen[n] = seen.get(n, 0) + 1
        out.append(h if seen[n] == 1 else f"{h}_{seen[n]}")
    return out


_xl_cache = {}

_MIN_STYLES = (
    b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    b'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    b'<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    b'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    b'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    b'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    b'<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    b'</styleSheet>'
)


def _repair_xlsx(path):
    """Copy of the workbook with the (corrupt) styles replaced by a minimal valid stylesheet.
    Cell data is untouched; only formatting is lost (dates then arrive as Excel serial numbers,
    which clean_dates() converts back)."""
    import tempfile
    import zipfile
    out = os.path.join(tempfile.gettempdir(), "repaired_" + os.path.basename(path))
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/styles.xml":
                data = _MIN_STYLES
            elif item.filename.startswith("xl/worksheets/") and item.filename.endswith(".xml"):
                data = re.sub(rb'(<c\b[^>]*?) s="\d+"', rb"\1", data)
                data = re.sub(rb'(<row\b[^>]*?) s="\d+"', rb"\1", data)
                data = re.sub(rb'(<col\b[^>]*?) style="\d+"', rb"\1", data)
            zout.writestr(item, data)
    return out


def _excel(path):
    """Open a workbook, trying progressively more tolerant strategies."""
    if path in _xl_cache:
        return _xl_cache[path]
    attempts = [
        ("openpyxl", lambda: pd.ExcelFile(path, engine="openpyxl")),
        ("calamine (ignores broken styles)", lambda: pd.ExcelFile(path, engine="calamine")),
        ("style-repaired copy", lambda: pd.ExcelFile(_repair_xlsx(path), engine="openpyxl")),
    ]
    errors = []
    for i, (name, fn) in enumerate(attempts):
        try:
            xl = fn()
            if i:
                log(f"  NOTE: {os.path.basename(path)} has a damaged style table; read it using: {name}. "
                    f"Tip: opening it in Excel and re-saving as .xlsx fixes this permanently.")
            _xl_cache[path] = xl
            return xl
        except Exception as e:
            errors.append(f"{name}: {str(e).splitlines()[0][:150]}")
    raise ValueError(f"Could not read workbook {os.path.basename(path)}. Open it in Excel and "
                     f"re-save as .xlsx, then retry. Details: {errors}")


def _resolve_sheet(xl, wanted, path):
    key = lambda x: re.sub(r"[\s_\-]+", " ", str(x)).strip().lower()
    for s in xl.sheet_names:
        if key(s) == key(wanted):
            return s
    raise ValueError(
        f"Sheet '{wanted}' not found in {os.path.basename(path)}. Available sheets: {xl.sheet_names}"
    )


def _find_header_row(raw, anchors, label, max_scan=25):
    for i in range(min(max_scan, len(raw))):
        vals = {norm(v) for v in raw.iloc[i].tolist() if not pd.isna(v)}
        if any(a in vals for a in anchors):
            return i
    raise ValueError(f"[{label}] could not find a header row containing {anchors} in the first {max_scan} rows. "
                     f"Set 'header_row' explicitly in SOURCES.")


def load_sheet(cfg, anchors, label):
    """Read one sheet -> cleaned DataFrame of strings with the original header text."""
    path = os.path.join(INPUT_DIR, cfg["file"])
    if not os.path.exists(path):
        raise FileNotFoundError(f"[{label}] file not found: {path}")

    if path.lower().endswith(".csv"):
        raw = pd.read_csv(path, header=None, dtype=str, encoding="utf-8-sig", low_memory=False)
    else:
        xl = _excel(path)
        sheet = _resolve_sheet(xl, cfg["sheet"], path)
        raw = pd.read_excel(xl, sheet_name=sheet, header=None, dtype=str)

    hdr = cfg.get("header_row", "auto")
    if hdr == "auto":
        hdr = _find_header_row(raw, anchors, label)

    headers = dedupe_headers([clean_cell(h) for h in raw.iloc[hdr].tolist()])
    keep = [i for i, h in enumerate(headers) if h]            # drop unnamed/blank columns
    df = raw.iloc[hdr + 1:, keep].copy()
    df.columns = [headers[i] for i in keep]
    for c in df.columns:
        df[c] = df[c].map(clean_cell)
    df = df[(df != "").any(axis=1)].reset_index(drop=True)    # drop fully empty rows
    df = clean_dates(df)

    log(f"  [{label}] {cfg['file']} :: {cfg.get('sheet','-')}  header_row={hdr}  "
        f"-> {len(df):,} rows x {len(df.columns)} cols")

    if EXPORT_CSVS:
        os.makedirs(CSV_DIR, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", label)
        df.to_csv(os.path.join(CSV_DIR, f"{safe}.csv"), index=False, encoding="utf-8-sig")
    return df


def to_records(df):
    """DataFrame -> list of dicts keyed by normalised header."""
    return [{norm(k): v for k, v in r.items()} for r in df.to_dict("records")]


def pick(rec, aliases):
    for a in aliases:
        v = rec.get(a)
        if v:
            return v
    return ""


# =============================================================================
# DATABASE BUILD
# =============================================================================
def create_table_sql(table, spec):
    lines = []
    if spec["autoid"]:
        lines.append("id INTEGER PRIMARY KEY AUTOINCREMENT")
    for name, _, _ in spec["cols"]:
        lines.append(f'"{name}" TEXT PRIMARY KEY' if name == spec["pk"] else f'"{name}" TEXT')
    return f'CREATE TABLE "{table}" (\n    ' + ",\n    ".join(lines) + "\n)"


def review_consult_order(numbers):
    """Review numbers in the order they are consulted for contact details -> (order, ignored_priority_entries)."""
    nums = list(dict.fromkeys(numbers))
    prio = [n for n in dict.fromkeys(REVIEW_PRIORITY) if n in nums]
    ignored = [n for n in dict.fromkeys(REVIEW_PRIORITY) if n not in nums]
    rest = sorted((n for n in nums if n not in prio), reverse=(REVIEW_FALLBACK_ORDER != "oldest_first"))
    return prio + rest, ignored


def build_review_lookup(review_dfs):
    """review_dfs = [(review_number, DataFrame), ...]
    Returns (lookup, sources): lookup[code] = {db_column: value}; sources[code] = {block: which review it came from}.
    Values are resolved to DB column names per sheet BEFORE choosing, so differently spelled headers can't matter."""
    key_aliases = [norm("Project Code"), norm("Project ID")]
    rev_cols = [(n, al) for n, al, src in TABLE_SPECS["project_details"]["cols"] if src == "review"]
    per_code = {}                                            # code -> {review_number: {db_col: value}}
    for num, df in review_dfs:
        for rec in to_records(df):
            code = pick(rec, key_aliases)
            if not code:
                continue
            canon = {n: pick(rec, al) for n, al in rev_cols}
            prev = per_code.setdefault(code, {}).get(num)
            if prev and not any(canon.values()):             # duplicate row inside one sheet: keep the filled one
                canon = prev
            per_code[code][num] = canon

    order, ignored = review_consult_order([n for n, _ in review_dfs])
    log(f"  Contact details: mode='{REVIEW_CONTACT_MODE}' | reviews consulted in this order: {order}")
    if ignored:
        log(f"  WARNING: REVIEW_PRIORITY entries that are not among the loaded reviews (ignored): {ignored}")

    block_fields = {f for b in CONTACT_BLOCKS.values() for f in b["fields"]}

    def first_value(by_rev, field):
        for num in order:
            v = by_rev.get(num, {}).get(field, "")
            if v:
                return v
        return ""

    lookup, sources = {}, {}
    for code, by_rev in per_code.items():
        merged, src = {n: "" for n, _ in rev_cols}, {}
        if REVIEW_CONTACT_MODE == "field":
            for n, _ in rev_cols:
                merged[n] = first_value(by_rev, n)
            for bname, block in CONTACT_BLOCKS.items():
                src[bname] = "per-field" if any(merged[f] for f in block["fields"]) else ""
        else:
            for bname, block in CONTACT_BLOCKS.items():
                chosen = partial = None
                for num in order:
                    canon = by_rev.get(num)
                    if not canon:
                        continue
                    if any(canon[f] for f in block["needs_any_of"]):
                        chosen = num
                        break
                    if partial is None and any(canon[f] for f in block["fields"]):
                        partial = num                        # has a name/designation but no phone/e-mail
                use = chosen if chosen is not None else partial
                if use is not None:
                    for f in block["fields"]:
                        merged[f] = by_rev[use][f]
                src[bname] = "" if use is None else (str(use) if chosen is not None else f"{use} (no phone/e-mail)")
            for n, _ in rev_cols:                            # any review column outside the blocks: per-field
                if n not in block_fields:
                    merged[n] = first_value(by_rev, n)
        lookup[code], sources[code] = merged, src
    return lookup, sources


def fix_coordinate(raw, full_range, india_range):
    """-> (new_value, action) where action is '', 'converted' or 'blanked'."""
    if not raw:
        return raw, ""
    try:
        v = float(raw)
    except ValueError:
        return "", "blanked"
    if not math.isfinite(v):
        return "", "blanked"
    if full_range[0] <= v <= full_range[1]:
        return raw, ""                                   # already a valid decimal-degree value
    a = abs(v)                                           # try packed DDMMSS(.ss)
    deg = int(a // 10000)
    rem = a - deg * 10000
    mins = int(rem // 100)
    sec = rem - mins * 100
    if mins < 60 and sec < 60:
        dd = deg + mins / 60 + sec / 3600
        if india_range[0] <= dd <= india_range[1]:
            return f"{dd:.6f}", "converted"
    return "", "blanked"


def fix_row_coordinates(vals, lat_i, lon_i, pid, changes):
    lat, lon = vals[lat_i], vals[lon_i]
    new_lat, a_lat = fix_coordinate(lat, (-90, 90), INDIA_LAT)
    new_lon, a_lon = fix_coordinate(lon, (-180, 180), INDIA_LON)
    if "blanked" in (a_lat, a_lon):
        new_lat, new_lon = "", ""
        a_lat = a_lat or ("blanked" if lat else "")
        a_lon = a_lon or ("blanked" if lon else "")
    for field, raw, new, act in (("latitude", lat, new_lat, a_lat), ("longitude", lon, new_lon, a_lon)):
        if act:
            changes.append((pid, field, raw, new, act))
    vals[lat_i], vals[lon_i] = new_lat, new_lon
    return vals


def build_db(db_path, data, review_dfs):
    conn = sqlite3.connect(db_path)
    counts = {}
    try:
        cur = conn.cursor()
        for table, spec in TABLE_SPECS.items():
            cur.execute(create_table_sql(table, spec))
        cur.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)")

        review_lookup, contact_src = build_review_lookup(review_dfs) if review_dfs else ({}, {})

        for table, spec in TABLE_SPECS.items():
            df = data.get(spec["source"])
            if df is None:
                log(f"  [{table}] no source configured - table left empty")
                counts[table] = 0
                continue

            names = [c[0] for c in spec["cols"]]
            verb = "INSERT OR REPLACE" if spec["pk"] else "INSERT"
            sql = (f'{verb} INTO "{table}" ({", ".join(chr(34)+n+chr(34) for n in names)}) '
                   f'VALUES ({",".join("?" * len(names))})')

            rows, seen, skipped, dupes, no_review = [], set(), 0, 0, 0
            coord_changes, src_rows = [], []
            fix_coords = FIX_COORDINATES and table == "project_details" and {"latitude", "longitude"} <= set(names)
            lat_i = names.index("latitude") if fix_coords else None
            lon_i = names.index("longitude") if fix_coords else None
            key_idx = names.index(spec["key"])
            for rec in to_records(df):
                key = pick(rec, spec["cols"][key_idx][1])
                if not key:
                    skipped += 1
                    continue
                if spec["pk"]:
                    if key in seen:
                        dupes += 1
                    seen.add(key)
                rev = review_lookup.get(key, {}) if table == "project_details" else {}
                if table == "project_details":
                    if not any(rev.values()):
                        no_review += 1
                    cs = contact_src.get(key, {})
                    src_rows.append((key, cs.get("irma_person", ""), cs.get("state_officer", "")))
                vals = [rev.get(n, "") if src == "review" else pick(rec, al) for n, al, src in spec["cols"]]
                if fix_coords:
                    vals = fix_row_coordinates(vals, lat_i, lon_i, key, coord_changes)
                rows.append(tuple(vals))

            cur.executemany(sql, rows)
            counts[table] = len(rows) - dupes
            log(f"  [{table}] inserted {counts[table]:,} rows"
                + (f" | skipped {skipped:,} rows with no {spec['key']}" if skipped else "")
                + (f" | WARNING {dupes:,} duplicate {spec['key']} (last one kept)" if dupes else "")
                + (f" | {no_review:,} projects have no contact details in any review" if no_review else ""))
            if table == "project_details" and review_dfs:
                def _order(lbl):
                    m = re.match(r"\d+", lbl)
                    return (0, -int(m.group())) if m else (1, 0)
                for i, bname in enumerate(CONTACT_BLOCKS, 1):
                    cnt = Counter(r[i] for r in src_rows)
                    parts = [f"review {k}: {v:,}" if k and k != "per-field" else f"{k or 'none'}: {v:,}"
                             for k, v in sorted(cnt.items(), key=lambda kv: _order(kv[0]))]
                    log(f"    contact source [{bname}]: " + " | ".join(parts))
                if EXPORT_CSVS:
                    os.makedirs(CSV_DIR, exist_ok=True)
                    pd.DataFrame(src_rows, columns=["project_id", "irma_person_from_review",
                                                    "state_officer_from_review"]).to_csv(
                        os.path.join(CSV_DIR, "contact_sources.csv"), index=False, encoding="utf-8-sig")
            if coord_changes:
                n_conv = sum(1 for c in coord_changes if c[4] == "converted")
                n_blank = len({c[0] for c in coord_changes if c[4] == "blanked"})
                log(f"    coordinates: {n_conv} value(s) converted from packed DDMMSS to decimal degrees, "
                    f"{n_blank} project(s) blanked as invalid")
                for pid, field, raw, new, act in coord_changes:
                    log(f"      {pid:<22} {field:<9} {raw!s:<14} -> {new or '(blank)'}  [{act}]")

        cur.execute("CREATE INDEX idx_tenders_project ON tenders(project_id)")
        cur.execute("CREATE INDEX idx_obs_project ON observations(project_code)")

        meta = {"built_at": datetime.now().isoformat(timespec="seconds"), "data_date": DATA_DATE,
                **{f"rows_{t}": str(n) for t, n in counts.items()}}
        cur.executemany("INSERT INTO metadata VALUES (?,?)", meta.items())
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return counts


# =============================================================================
# ANALYSIS / VALIDATION
# =============================================================================
def analyze(db_path):
    """Print per-table/column fill stats. Returns (warnings, fatal_errors)."""
    warnings, fatal = [], []
    conn = sqlite3.connect(db_path)
    try:
        ic = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if ic != "ok":
            fatal.append(f"SQLite integrity_check failed: {ic}")

        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        log("=" * 80)
        log(f"Database analysis: {os.path.basename(db_path)}   ({len(tables)} tables)")
        log("=" * 80)

        for t in tables:
            cols = conn.execute(f'PRAGMA table_info("{t}")').fetchall()
            exprs = ", ".join(f'SUM(CASE WHEN "{c[1]}" IS NULL OR "{c[1]}"=\'\' THEN 1 ELSE 0 END)' for c in cols)
            res = conn.execute(f'SELECT COUNT(*), {exprs} FROM "{t}"').fetchone()   # single table scan
            total, missing = res[0], res[1:]

            log(f"\nTable: {t}   rows={total:,}   fields={len(cols)}")
            log(f"  {'Column':<30} | {'Type':<8} | {'Valid':>9} | {'Empty':>9} | Fill")
            log("  " + "-" * 74)
            for c, m in zip(cols, missing):
                m = m or 0
                valid = total - m
                pct = (valid / total * 100) if total else 0
                log(f"  {c[1]:<30} | {c[2] or '?':<8} | {valid:>9,} | {m:>9,} | {pct:5.1f}%")
                if total and c[1] != "id" and m == total and t != "metadata":
                    warnings.append(f"{t}.{c[1]} is 100% empty (check header names / alias mapping)")

            if t in REQUIRED_TABLES and total == 0:
                fatal.append(f"Required table '{t}' has 0 rows")

        # cross-table sanity: observation/tender projects that don't exist in project_details
        if {"project_details", "tenders", "observations"} <= set(tables):
            orphan_t = conn.execute("SELECT COUNT(DISTINCT project_id) FROM tenders WHERE project_id NOT IN "
                                    "(SELECT project_id FROM project_details)").fetchone()[0]
            orphan_o = conn.execute("SELECT COUNT(DISTINCT project_code) FROM observations WHERE project_code NOT IN "
                                    "(SELECT project_id FROM project_details)").fetchone()[0]
            if orphan_t:
                warnings.append(f"{orphan_t} tender project_id value(s) not found in project_details")
            if orphan_o:
                warnings.append(f"{orphan_o} observation project_code value(s) not found in project_details")
    finally:
        conn.close()
    return warnings, fatal


# =============================================================================
# MAIN
# =============================================================================
def run(dry_run=False):
    t0 = time.time()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    final_path = os.path.join(OUTPUT_DIR, DB_NAME)
    tmp_path = final_path + ".building"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    if REVIEW_CONTACT_MODE not in ("block", "field"):
        raise ValueError("REVIEW_CONTACT_MODE must be 'block' or 'field'")
    if REVIEW_FALLBACK_ORDER not in ("newest_first", "oldest_first"):
        raise ValueError("REVIEW_FALLBACK_ORDER must be 'newest_first' or 'oldest_first'")
    log(f"Pipeline start  |  DATA_DATE={DATA_DATE}  |  dry_run={dry_run}")
    log("\n[1/4] Extracting sheets")
    data = {}
    for spec in TABLE_SPECS.values():
        name = spec["source"]
        if SOURCES.get(name):
            data[name] = load_sheet(SOURCES[name], ANCHORS[name], name)
    review_dfs = []                                          # [(review_number, DataFrame)]
    for i, cfg in enumerate(SOURCES.get("reviews", []), 1):
        num = cfg.get("number", i)
        try:
            review_dfs.append((num, load_sheet(cfg, ANCHORS["reviews"], f"review_{num}_{cfg.get('sheet','csv')}")))
        except ValueError as e:
            if cfg.get("optional"):
                log(f"  WARNING: skipped review {num}: {e}")
            else:
                raise
    if EXPORT_CSVS:
        log(f"  CSVs written to: {CSV_DIR}")

    log("\n[2/4] Building database in a temporary file (existing DB untouched)")
    try:
        build_db(tmp_path, data, review_dfs)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    log("\n[3/4] Validating")
    warnings, fatal = analyze(tmp_path)
    log("\n" + "=" * 80)
    for w in warnings:
        log(f"WARNING: {w}")
    for f in fatal:
        log(f"FATAL:   {f}")

    if fatal:
        os.remove(tmp_path)
        log("\nBuild ABORTED - existing database was not modified.")
        return 1
    if dry_run:
        os.remove(tmp_path)
        log("\nDry run complete - nothing was written.")
        return 0

    log("\n[4/4] Swapping in the new database")
    if os.path.exists(final_path):
        backup = f"{final_path}.bak_{datetime.now():%Y%m%d_%H%M%S}"
        shutil.move(final_path, backup)
        log(f"  Previous DB backed up as: {os.path.basename(backup)}")
    os.replace(tmp_path, final_path)               # atomic on the same filesystem
    log(f"  OK Database ready: {final_path}")
    log(f"\nDone in {time.time() - t0:.1f}s  ({len(warnings)} warning(s))")

    with open(os.path.join(OUTPUT_DIR, f"pipeline_{DATA_DATE}.log"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(LOG_LINES))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run(dry_run="--dry-run" in sys.argv))
    except (FileNotFoundError, ValueError) as e:
        print(f"\nERROR: {e}")
        sys.exit(2)