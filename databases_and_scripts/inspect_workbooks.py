#!/usr/bin/env python3
"""
inspect_workbooks.py  --  pre-flight inspection for the quarterly DB pipeline.

Put this file in the SAME folder as generate_quarterly_DB.py and the two workbooks, then run:

    python inspect_workbooks.py                  # inspects every workbook referenced in generate_quarterly_DB.py's SOURCES
    python inspect_workbooks.py other_file.xlsx  # ...plus any extra workbook(s) you name

It reads the files exactly the way the generator does (same config, same header detection, same cleaning,
same damaged-styles fallback) and reports, BEFORE you build anything:
  * workbook / sheet inventory, hidden sheets, file metadata, whether styles.xml is healthy
  * header row, metadata rows above it, every column name, fill %, distinct values, type guess, samples
  * whether every DB column in the generator's TABLE_SPECS finds a matching header (with closest-name suggestions)
  * cross-sheet checks: duplicate keys, orphan project codes, review coverage, review-sheet header drift
  * data-quality flags: Excel serial dates, numbers stored as text, progress outside 0-100, bad lat/long, ...

Outputs: console summary + full text report + flat CSV column inventory (both next to this script).
Exit code: 0 = no errors, 1 = errors found (don't run the generator yet), 2 = could not start.
"""
import warnings
warnings.filterwarnings("ignore", category=UserWarning)      # hide openpyxl/numexpr cosmetic warnings

import difflib
import html
import os
import platform
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, OrderedDict
from datetime import datetime

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# ----------------------------------------------------------------------------- settings
GENERATOR_MODULE = "generate_Quarterly_DB"    # file name (without .py) of the generator script
MAX_HEADER_SCAN = 25                          # rows scanned when looking for the header row
SAMPLE_N = 3                                  # sample values shown per column
ORPHAN_LIST_N = 15                            # how many orphan codes to list

try:
    gen = __import__(GENERATOR_MODULE)
except Exception as exc:                      # noqa: BLE001
    print(f"ERROR: could not import '{GENERATOR_MODULE}.py' from {HERE}\n  -> {exc}\n"
          f"Place inspect_workbooks.py in the same folder as the generator (or change GENERATOR_MODULE).")
    sys.exit(2)

norm = gen.norm
TS = datetime.now().strftime("%Y%m%d_%H%M%S")
REPORT, ISSUES, COLUMN_RECS = [], [], []


def out(line="", console=True):
    REPORT.append(line)
    if console:
        print(line)


def issue(level, where, msg):
    ISSUES.append((level, where, msg))


def title(txt, console=True):
    out("", console)
    out("=" * 100, console)
    out(txt, console)
    out("=" * 100, console)


def col_letter(i):
    s, n = "", i + 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def trunc(s, n=40):
    s = str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


# ----------------------------------------------------------------------------- workbook level
def workbook_meta(path):
    """File-level facts straight from the .xlsx zip (works even if styles are damaged)."""
    m = {"sheets": [], "creator": "", "last_modified_by": "", "modified": "", "app": "",
         "styles": "n/a", "zip_error": None}
    try:
        with zipfile.ZipFile(path) as z:
            m["zip_error"] = z.testzip()
            names = z.namelist()
            wb = z.read("xl/workbook.xml").decode("utf-8", "ignore")
            for mt in re.finditer(r"<sheet\b([^>]*?)/?>", wb):
                a = mt.group(1)
                nm = re.search(r'name="([^"]*)"', a)
                st = re.search(r'state="([^"]*)"', a)
                m["sheets"].append((html.unescape(nm.group(1)) if nm else "?", st.group(1) if st else "visible"))
            if "docProps/core.xml" in names:
                core = z.read("docProps/core.xml").decode("utf-8", "ignore")
                for key, tag in (("creator", "dc:creator"), ("last_modified_by", "cp:lastModifiedBy"),
                                 ("modified", "dcterms:modified")):
                    g = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", core, re.S)
                    m[key] = html.unescape(g.group(1)) if g else ""
            if "docProps/app.xml" in names:
                g = re.search(r"<Application>(.*?)</Application>", z.read("docProps/app.xml").decode("utf-8", "ignore"))
                m["app"] = g.group(1) if g else ""
            if "xl/styles.xml" in names:
                try:
                    ET.fromstring(z.read("xl/styles.xml"))
                    m["styles"] = "well-formed XML"
                except ET.ParseError as e:
                    m["styles"] = f"DAMAGED ({e})"
            else:
                m["styles"] = "MISSING"
    except Exception as e:                    # noqa: BLE001
        m["zip_error"] = str(e)
    return m


def read_raw(path, sheet):
    if path.lower().endswith(".csv"):
        return pd.read_csv(path, header=None, dtype=str, encoding="utf-8-sig", low_memory=False)
    xl = gen._excel(path)
    return pd.read_excel(xl, sheet_name=sheet, header=None, dtype=str)


# ----------------------------------------------------------------------------- sheet level
_NUM = r"^-?\d+(\.\d+)?$"
_DATE = r"^(\d{4}-\d{2}-\d{2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})"


def guess_header_row(raw):
    """Independent of the generator's anchors: earliest text-heavy row that is nearly as full as the fullest row."""
    counts, texty = [], []
    for i in range(min(MAX_HEADER_SCAN, len(raw))):
        vals = [str(v).strip() for v in raw.iloc[i].tolist() if not pd.isna(v) and str(v).strip()]
        counts.append(len(vals))
        texty.append(sum(not re.match(_NUM, v) for v in vals) / len(vals) if vals else 0)
    if not counts or max(counts) == 0:
        return 0
    mx = max(counts)
    for i, (c, t) in enumerate(zip(counts, texty)):
        if c >= 0.8 * mx and t >= 0.8:
            return i
    return counts.index(mx)


def _coord_hint():
    return (" (generator converts packed DDMMSS values and blanks invalid ones)"
            if getattr(gen, "FIX_COORDINATES", False) else "")


def profile_sheet(path, sheet, anchors, cfg_hdr="auto", label=""):
    """Read one sheet and profile every column. Returns a dict (with a cleaned DataFrame for cross-checks)."""
    raw = read_raw(path, sheet)
    P = {"path": path, "sheet": sheet, "label": label, "raw_shape": raw.shape, "ok": False}
    if raw.empty:
        issue("ERROR", f"{os.path.basename(path)}::{sheet}", "sheet is empty")
        return P

    guess = guess_header_row(raw)
    anchor_row = None
    if anchors:
        try:
            anchor_row = gen._find_header_row(raw, anchors, sheet, MAX_HEADER_SCAN)
        except ValueError:
            anchor_row = None
    hdr = cfg_hdr if isinstance(cfg_hdr, int) else (anchor_row if anchor_row is not None else guess)
    where = f"{os.path.basename(path)}::{sheet}"
    if anchors and anchor_row is None and not isinstance(cfg_hdr, int):
        issue("ERROR", where, f"no header row containing {anchors} in the first {MAX_HEADER_SCAN} rows "
                              f"(generator will fail). Heuristic guess: row {guess}")
    elif anchor_row is not None and anchor_row != guess:
        issue("WARNING", where, f"header row by key column = {anchor_row} but heuristic guess = {guess}; "
                                f"check the metadata rows above the table")

    headers_raw = ["" if pd.isna(v) else str(v) for v in raw.iloc[hdr].tolist()]
    meta_rows = []
    for i in range(hdr):
        vals = [str(v).strip() for v in raw.iloc[i].tolist() if not pd.isna(v) and str(v).strip()]
        if vals:
            meta_rows.append((i, trunc(" | ".join(vals), 110)))

    body = raw.iloc[hdr + 1:].reset_index(drop=True)
    rows_before = len(body)
    cleaned = body.apply(lambda s: s.map(gen.clean_cell))
    mask = (cleaned != "").any(axis=1)
    body, cleaned = body[mask].reset_index(drop=True), cleaned[mask].reset_index(drop=True)
    n_rows = len(cleaned)

    hdr_clean = gen.dedupe_headers([gen.clean_cell(h) for h in headers_raw])
    hcount = Counter(norm(h) for h in headers_raw if h.strip())
    recs, unnamed_with_data = [], 0

    for j, h_raw in enumerate(headers_raw):
        c = cleaned.iloc[:, j]
        vals = c[c != ""]
        filled = len(vals)
        h_clean = hdr_clean[j]
        if not h_clean:
            if filled:
                unnamed_with_data += 1
            continue
        r = body.iloc[:, j].dropna().astype(str)
        newline = int(r.str.contains(r"[\r\n]").sum()) if len(r) else 0
        edge_ws = int((r != r.str.strip()).sum()) if len(r) else 0

        dateish = "date" in norm(h_clean) or norm(h_clean) == "updated on"
        n_num = int(vals.str.match(_NUM).sum()) if filled else 0
        n_date = int(vals.str.match(_DATE).sum()) if filled else 0
        serial = int(vals.str.fullmatch(r"\d{5}(\.\d+)?").sum()) if (filled and dateish) else 0

        if filled == 0:
            tguess = "empty"
        elif n_date / filled >= 0.9:
            tguess = "date"
        elif serial / filled >= 0.9:
            tguess = "date (as Excel serial)"
        elif n_num == filled:
            tguess = "numeric"
        elif n_num / filled >= 0.9:
            tguess = f"mostly numeric ({filled - n_num} non-numeric)"
        elif n_date / filled >= 0.1:
            tguess = "mixed text/date"
        else:
            tguess = "text"

        notes = []
        if hcount[norm(h_raw)] > 1:
            notes.append("duplicate header (generator renames 2nd+ to '<name>_2')")
        if h_raw != h_raw.strip() or re.search(r"[\r\n]", h_raw):
            notes.append("header has stray whitespace/newline (harmless, normalised)")
        if serial:
            notes.append(f"{serial:,} date values are Excel serial numbers (generator converts them)")
        if tguess.startswith("mostly numeric"):
            bad = vals[~vals.str.match(_NUM)].unique()[:3].tolist()
            notes.append(f"non-numeric examples: {bad}")
        if filled and n_num / filled >= 0.5:
            comma = int(vals.str.match(r"^-?[\d,]+(\.\d+)?$").sum() - n_num)
            if comma > 0:
                notes.append(f"{comma:,} numbers contain thousands separators (stored as text)")
            nums = pd.to_numeric(vals[vals.str.match(_NUM)], errors="coerce")
            hn = norm(h_clean)
            if "progress" in hn or "(in %)" in hn:
                outside = int(((nums < 0) | (nums > 100)).sum())
                if outside:
                    notes.append(f"{outside:,} progress values outside 0-100")
                elif len(nums) and nums.max() <= 1:
                    notes.append("progress values all <= 1 (fractions rather than percent?)")
            if hn == "latitude" and ((nums < -90) | (nums > 90)).any():
                notes.append(f"{int(((nums < -90) | (nums > 90)).sum())} latitude values outside -90..90" + _coord_hint())
            if hn == "longitude" and ((nums < -180) | (nums > 180)).any():
                notes.append(f"{int(((nums < -180) | (nums > 180)).sum())} longitude values outside -180..180" + _coord_hint())
        if newline:
            notes.append(f"{newline:,} cells contain line breaks (generator flattens them)")
        if edge_ws:
            notes.append(f"{edge_ws:,} cells have leading/trailing spaces (generator strips them)")

        distinct = int(vals.nunique()) if filled else 0
        lens = vals.str.len() if filled else pd.Series([0])
        recs.append(OrderedDict(
            workbook=os.path.basename(path), sheet=sheet, position=j + 1, excel_col=col_letter(j), header=h_clean,
            filled=filled, empty=n_rows - filled, fill_pct=round(filled / n_rows * 100, 1) if n_rows else 0.0,
            distinct=distinct, type_guess=tguess, min_len=int(lens.min()), max_len=int(lens.max()),
            samples=" | ".join(trunc(v, 30) for v in vals.drop_duplicates().head(SAMPLE_N)),
            notes="; ".join(notes)))
        for n in notes:
            if any(k in n for k in ("outside", "fractions", "serial", "thousands", "duplicate header")):
                issue("WARNING", f"{where}[{h_clean}]", n)

    if unnamed_with_data:
        issue("WARNING", where, f"{unnamed_with_data} column(s) have data but NO header name (the generator ignores them)")

    keep = [j for j, h in enumerate(hdr_clean) if h]
    df = cleaned.iloc[:, keep].copy()
    df.columns = [hdr_clean[j] for j in keep]

    P.update(ok=True, hdr=hdr, guess=guess, anchor_row=anchor_row, meta_rows=meta_rows, n_rows=n_rows,
             empty_rows_removed=rows_before - n_rows, n_cols=len(keep), recs=recs, df=df,
             headers=[hdr_clean[j] for j in keep])
    COLUMN_RECS.extend(recs)
    return P


def write_profile(P):
    """Full per-column detail -> report file only."""
    out(f"\n--- {os.path.basename(P['path'])} :: {P['sheet']} " + (f"[{P['label']}]" if P.get("label") else ""), False)
    if not P["ok"]:
        out("    (could not be profiled)", False)
        return
    out(f"    raw grid: {P['raw_shape'][0]:,} rows x {P['raw_shape'][1]} cols | header row (0-based): {P['hdr']} "
        f"(key-column match: {P['anchor_row']}, heuristic: {P['guess']}) | data rows: {P['n_rows']:,} "
        f"(+{P['empty_rows_removed']:,} empty rows dropped) | named columns: {P['n_cols']}", False)
    for i, txt in P["meta_rows"]:
        out(f"    metadata row {i}: {txt}", False)
    out(f"    {'#':>3} {'Col':<4} {'Header':<42} {'Filled':>8} {'Fill%':>6} {'Distinct':>8}  {'Type':<24} Samples", False)
    for r in P["recs"]:
        out(f"    {r['position']:>3} {r['excel_col']:<4} {trunc(r['header'], 42):<42} {r['filled']:>8,} "
            f"{r['fill_pct']:>6.1f} {r['distinct']:>8,}  {trunc(r['type_guess'], 24):<24} {r['samples']}", False)
        if r["notes"]:
            out(f"        ! {r['notes']}", False)


# ----------------------------------------------------------------------------- config / mapping checks
def match_headers(P, aliases):
    """First alias that exists among the sheet's headers -> (header_text, fill_pct) or None."""
    hm = {norm(r["header"]): r for r in P["recs"]}
    for a in aliases:
        if a in hm:
            return hm[a]["header"], hm[a]["fill_pct"]
    return None


def closest(P, aliases, n=3):
    heads = {norm(r["header"]): r["header"] for r in P["recs"]}
    found = []
    for a in aliases:
        for m in difflib.get_close_matches(a, list(heads), n=n, cutoff=0.5):
            if heads[m] not in found:
                found.append(heads[m])
    return found[:n]


def check_table(table, P):
    """Mapping report for one main table sheet."""
    spec = gen.TABLE_SPECS[table]
    where = f"{table} <- {os.path.basename(P['path'])}::{P['sheet']}"
    out(f"\n[{table}]  {os.path.basename(P['path'])} :: {P['sheet']}")
    out(f"    header row {P['hdr']} | data rows {P['n_rows']:,} | named columns {P['n_cols']} "
        f"| {len(P['meta_rows'])} metadata row(s) above header")
    names = [c[0] for c in spec["cols"]]
    key_aliases = spec["cols"][names.index(spec["key"])][1]
    ks = key_series(P["df"], key_aliases)
    if ks is None:
        issue("ERROR", where, f"key column {key_aliases} not found - generator would insert 0 rows")
    else:
        n_key = int((ks != "").sum())
        out(f"    rows with a {spec['key']}: {n_key:,} (generator will insert these) | rows without: {len(ks) - n_key:,}")
        if n_key == 0:
            issue("ERROR", where, "0 rows have a key value")
        if spec["pk"]:
            d = ks[ks != ""]
            dups = int(d.duplicated().sum())
            if dups:
                issue("WARNING", where, f"{dups:,} duplicate {spec['key']} value(s) (generator keeps the LAST one)")
                out(f"    duplicate {spec['key']} rows: {dups:,}")
        P["expected_inserts"] = int((ks != "").sum() - (ks[ks != ""].duplicated().sum() if spec["pk"] else 0))

    used = set()
    out(f"    {'DB column':<30} {'Status':<8} {'Header in sheet':<40} {'Fill%':>6}", False)
    miss = low = ok = 0
    for name, aliases, src in spec["cols"]:
        if src != "main":
            continue
        used.update(aliases)
        m = match_headers(P, aliases)
        if m is None:
            miss += 1
            sug = closest(P, aliases)
            out(f"    {name:<30} {'MISSING':<8} closest: {sug}", False)
            out(f"    ! {name}: no header matches {aliases}; closest in sheet: {sug}")
            issue("ERROR" if name == spec["key"] else "WARNING", where,
                  f"DB column '{name}' has no matching header (accepted: {aliases}; closest: {sug})")
        else:
            h, fp = m
            flag = "LOW" if fp < 5 else "OK"
            if flag == "LOW":
                low += 1
                issue("WARNING", where, f"DB column '{name}' matched header '{h}' but is only {fp}% filled")
                out(f"    ! {name}: matched '{h}' but only {fp}% filled", True)
            else:
                ok += 1
            out(f"    {name:<30} {flag:<8} {trunc(h, 40):<40} {fp:>6.1f}", False)
    unused = [r["header"] for r in P["recs"] if norm(r["header"]) not in used]
    out(f"    mapped OK: {ok} | low fill: {low} | missing: {miss} | sheet columns the generator ignores: {len(unused)}")
    out(f"    ignored columns: {unused}", False)


def key_series(df, aliases):
    cm = {norm(c): c for c in df.columns}
    for a in aliases:
        if a in cm:
            return df[cm[a]]
    return None


def check_reviews(review_profiles):
    spec = gen.TABLE_SPECS["project_details"]
    rev_cols = [(n, al) for n, al, src in spec["cols"] if src == "review"]
    out(f"\n[reviews]  {len(review_profiles)} sheet(s), applied oldest -> newest")
    out(f"    {'sheet':<22} {'rows':>7} {'unique codes':>13} {'dup codes':>10} {'with phone/e-mail':>18}  {'fields matched':<14}")
    base, partial, drift = None, [], []
    usage = {n: Counter() for n, _ in rev_cols}
    union_codes = set()
    for P in review_profiles:
        where = f"{os.path.basename(P['path'])}::{P['sheet']}"
        ks = key_series(P["df"], [norm("Project Code"), norm("Project ID")])
        if ks is None:
            issue("ERROR", where, "no 'Project Code'/'Project ID' column - this review sheet contributes nothing")
            codes, dups = set(), 0
        else:
            d = ks[ks != ""]
            codes, dups = set(d), int(d.duplicated().sum())
            union_codes |= codes
        matched = 0
        for n, al in rev_cols:
            m = match_headers(P, al)
            if m:
                matched += 1
                usage[n][m[0]] += 1
        P["codes"] = codes
        ra = dict(rev_cols)
        has = pd.Series(False, index=P["df"].index)
        for fld in ("contact", "email"):
            ser = key_series(P["df"], ra[fld])
            if ser is not None:
                has |= (ser != "")
        out(f"    {trunc(P['sheet'], 22):<22} {P['n_rows']:>7,} {len(codes):>13,} {dups:>10,} {int(has.sum()):>18,}  "
            f"{matched}/{len(rev_cols)}")
        if matched == 0:
            issue("ERROR", where, "none of the review fields (IRMA personnel, contact, e-mail, ...) match any header")
        elif matched < len(rev_cols):
            partial.append(f"{P['sheet']} ({matched}/{len(rev_cols)})")
        if dups:
            issue("WARNING", where, f"{dups:,} duplicate project code(s) inside this review sheet")
        hs = {norm(h) for h in P["headers"]}
        if base is None:
            base = (P["sheet"], hs)
        elif hs != base[1]:
            add, rem = sorted(hs - base[1]), sorted(base[1] - hs)
            out(f"    header drift vs '{base[0]}': +{add[:6]} -{rem[:6]}", False)
            drift.append(P["sheet"])
    if partial:
        issue("WARNING", "reviews", f"{len(partial)} sheet(s) contain only some review fields: {partial[:12]}")
    if drift:
        issue("WARNING", "reviews", f"{len(drift)} sheet(s) have headers that differ from '{base[0]}' "
                                    f"(details in the report file): {drift[:12]}")
    out("    review field -> header text actually used (count of sheets):")
    for n, _ in rev_cols:
        used = dict(usage[n])
        out(f"      {n:<18} {used if used else 'NOT FOUND IN ANY SHEET'}")
        if not used:
            issue("ERROR", "reviews", f"DB column '{n}' is not found in any review sheet")
    return union_codes


def cross_checks(profiles, union_codes):
    title("CROSS-SHEET CHECKS")
    P_, T_, O_ = profiles.get("project_details"), profiles.get("tenders"), profiles.get("observations")
    if not (P_ and P_["ok"]):
        out("  project_details not available - skipped")
        return
    spec = gen.TABLE_SPECS
    pk = key_series(P_["df"], spec["project_details"]["cols"][0][1])
    if pk is None:
        return
    proj = set(pk[pk != ""])
    out(f"  projects in project_details: {len(proj):,}")

    def orphans(P, table, label):
        if not (P and P["ok"]):
            return
        ks = key_series(P["df"], spec[table]["cols"][0][1])
        if ks is None:
            return
        codes = set(ks[ks != ""])
        orph = sorted(codes - proj)
        up = {c.upper() for c in proj}
        resolvable = [c for c in orph if c.upper() in up]
        out(f"  {label}: {len(codes):,} distinct codes | not in project_details: {len(orph):,}"
            f" (would match if case-insensitive: {len(resolvable)})")
        if orph:
            out(f"      first {min(ORPHAN_LIST_N, len(orph))}: {orph[:ORPHAN_LIST_N]}")
            issue("WARNING", label, f"{len(orph):,} code(s) not found in project_details "
                                    f"({len(resolvable)} differ only by letter case)")
        no_obs = len(proj - codes)
        out(f"      projects in project_details with no rows in {label}: {no_obs:,}")

    orphans(T_, "tenders", "tenders")
    orphans(O_, "observations", "observations")

    if union_codes:
        no_rev = proj - union_codes
        extra = union_codes - proj
        out(f"  review coverage: {len(proj) - len(no_rev):,}/{len(proj):,} projects appear in at least one review sheet"
            f" | without any review: {len(no_rev):,} | review codes not in project_details: {len(extra):,}")
        if extra:
            out(f"      first review-only codes: {sorted(extra)[:ORPHAN_LIST_N]}")
            issue("WARNING", "reviews", f"{len(extra):,} review project code(s) not in project_details")


# ----------------------------------------------------------------------------- main
def main():
    t0 = datetime.now()
    title(f"WORKBOOK PRE-FLIGHT INSPECTION   {t0:%Y-%m-%d %H:%M}")
    out(f"  folder          : {HERE}")
    out(f"  generator config: {GENERATOR_MODULE}.py  (DATA_DATE={gen.DATA_DATE}, input dir: {gen.INPUT_DIR})")
    try:
        import openpyxl
        ov = openpyxl.__version__
    except Exception:                          # noqa: BLE001
        ov = "NOT INSTALLED"
    try:
        import python_calamine  # noqa: F401
        cal = "installed"
    except Exception:                          # noqa: BLE001
        cal = "not installed (optional)"
    out(f"  python {platform.python_version()} | pandas {pd.__version__} | openpyxl {ov} | calamine {cal}", False)

    # ---- which files
    cfg_entries = []                           # (label, table_or_'reviews', cfg)
    for table in ("tenders", "project_details", "observations"):
        if gen.SOURCES.get(table):
            cfg_entries.append((table, table, gen.SOURCES[table]))
    for i, c in enumerate(gen.SOURCES.get("reviews", []), 1):
        cfg_entries.append((f"review_{c.get('number', i)}", "reviews", c))

    files = OrderedDict()
    for _, _, c in cfg_entries:
        files[os.path.join(gen.INPUT_DIR, c["file"])] = "config"
    for a in sys.argv[1:]:
        if not a.startswith("-"):
            files.setdefault(os.path.abspath(a), "extra")
    others = [f for f in sorted(os.listdir(gen.INPUT_DIR))
              if f.lower().endswith((".xlsx", ".xlsm", ".csv")) and not f.startswith(("~$", "repaired_"))
              and os.path.join(gen.INPUT_DIR, f) not in files]

    # ---- workbook inventory
    title("1. WORKBOOKS")
    wb_info = {}
    for path, why in files.items():
        name = os.path.basename(path)
        if not os.path.exists(path):
            out(f"\n  {name}: FILE NOT FOUND")
            issue("ERROR", name, f"file not found in {os.path.dirname(path)}")
            continue
        size = os.path.getsize(path) / 1_048_576
        out(f"\n  {name}   ({size:.1f} MB, modified {datetime.fromtimestamp(os.path.getmtime(path)):%Y-%m-%d %H:%M}, "
            f"{'used by config' if why == 'config' else 'extra'})")
        if path.lower().endswith(".csv"):
            wb_info[path] = {"xl": None, "meta": None}
            continue
        meta = workbook_meta(path)
        out(f"      creator: {meta['creator'] or '-'} | last modified by: {meta['last_modified_by'] or '-'} | "
            f"saved: {meta['modified'] or '-'} | app: {meta['app'] or '-'}")
        out(f"      styles.xml: {meta['styles']}")
        if meta["zip_error"]:
            issue("ERROR", name, f"corrupt zip member: {meta['zip_error']}")
        before = len(gen.LOG_LINES)
        try:
            xl = gen._excel(path)
            note = [m for m in gen.LOG_LINES[before:] if "NOTE" in m]
            if note:
                out("      reader: the default reader (openpyxl) rejected this file's style table, so the generator's "
                    "fallback reader is used. Cell data is unaffected.")
                issue("INFO", name, "default reader rejected the style table; fallback reader used "
                                    "(re-saving the file in Excel fixes this permanently)")
            wb_info[path] = {"xl": xl, "meta": meta}
        except Exception as e:                 # noqa: BLE001
            out(f"      UNREADABLE: {str(e)[:200]}")
            issue("ERROR", name, f"workbook cannot be read: {str(e)[:150]}")
            continue
        hidden = [s for s, st in meta["sheets"] if st != "visible"]
        out(f"      {len(meta['sheets'])} sheet(s): {[s for s, _ in meta['sheets']]}" +
            (f"  | hidden: {hidden}" if hidden else ""))
    if others:
        out(f"\n  other data files in the folder (not inspected): {others}", False)

    # ---- resolve config -> sheets
    title("2. SHEETS USED BY THE GENERATOR CONFIG")
    profiles, review_profiles, referenced = {}, [], set()
    for label, kind, cfg in cfg_entries:
        path = os.path.join(gen.INPUT_DIR, cfg["file"])
        info = wb_info.get(path)
        if info is None:
            continue
        anchors = gen.ANCHORS.get(kind)
        try:
            if info["xl"] is not None:
                sheet = gen._resolve_sheet(info["xl"], cfg["sheet"], path)
            else:
                sheet = cfg.get("sheet", "")
        except ValueError:
            avail = info["xl"].sheet_names
            sug = difflib.get_close_matches(cfg["sheet"], avail, n=3, cutoff=0.4)
            out(f"  [{label}] SHEET NOT FOUND: '{cfg['sheet']}'  | available: {avail}  | closest: {sug}")
            issue("ERROR" if not cfg.get("optional") else "WARNING", label,
                  f"sheet '{cfg['sheet']}' not found in {cfg['file']} (closest: {sug})")
            continue
        referenced.add((path, sheet))
        P = profile_sheet(path, sheet, anchors, cfg.get("header_row", "auto"), label)
        if kind == "reviews":
            review_profiles.append(P)
        else:
            profiles[kind] = P
        if P["ok"]:
            out(f"  [{label:<16}] {sheet:<22} header row {P['hdr']:<2} rows {P['n_rows']:>8,}  cols {P['n_cols']:>4}", True)

    # ---- other sheets: dimensions only
    out("\n  sheets in the workbooks NOT used by the config (dimensions only):")
    any_other = False
    for path, info in wb_info.items():
        if info["xl"] is None:
            continue
        for s in info["xl"].sheet_names:
            if (path, s) in referenced:
                continue
            any_other = True
            try:
                raw = read_raw(path, s)
                g = guess_header_row(raw) if len(raw) else 0
                hd = [str(v).strip() for v in raw.iloc[g].tolist() if not pd.isna(v)][:8] if len(raw) else []
                out(f"    {os.path.basename(path)} :: {s}: {raw.shape[0]:,} rows x {raw.shape[1]} cols; "
                    f"probable headers: {hd}")
            except Exception as e:             # noqa: BLE001
                out(f"    {os.path.basename(path)} :: {s}: unreadable ({str(e)[:80]})")
    if not any_other:
        out("    (none)")

    # ---- mapping checks
    title("3. DATABASE COLUMN MAPPING  (does every DB column find its header?)")
    out("  Full per-column mapping table is in the report file; problems are shown here.")
    for table in ("tenders", "project_details", "observations"):
        P = profiles.get(table)
        if P and P["ok"]:
            check_table(table, P)
        elif gen.SOURCES.get(table):
            out(f"\n[{table}] could not be profiled (see errors)")
    union_codes = set()
    if review_profiles:
        union_codes = check_reviews([p for p in review_profiles if p["ok"]])

    cross_checks(profiles, union_codes)

    # ---- full detail to file only
    out("\n\n" + "#" * 100, False)
    out("APPENDIX: FULL COLUMN PROFILES (every column of every sheet used by the config)", False)
    out("#" * 100, False)
    for P in list(profiles.values()) + review_profiles:
        write_profile(P)

    # ---- verdict
    title("VERDICT")
    errs = [i for i in ISSUES if i[0] == "ERROR"]
    warns = [i for i in ISSUES if i[0] == "WARNING"]
    infos = [i for i in ISSUES if i[0] == "INFO"]
    for lvl, lst in (("ERRORS", errs), ("WARNINGS", warns), ("INFO", infos)):
        if lst:
            out(f"\n  {lvl} ({len(lst)}):")
            for _, where, msg in lst:
                out(f"    - [{where}] {msg}")
    exp = {t: p.get("expected_inserts") for t, p in profiles.items() if p.get("expected_inserts") is not None}
    if exp:
        out(f"\n  Expected rows after the build (compare with the generator's output): {exp}")
    out("")
    if errs:
        out(f"  RESULT: {len(errs)} error(s) - fix these before running the generator.")
    elif warns:
        out(f"  RESULT: no blocking errors, {len(warns)} warning(s) - review them, then run the generator "
            f"(try --dry-run first).")
    else:
        out("  RESULT: all checks passed - safe to run the generator.")

    rpt = os.path.join(HERE, f"workbook_inspection_{TS}.txt")
    csv = os.path.join(HERE, f"workbook_columns_{TS}.csv")
    with open(rpt, "w", encoding="utf-8") as fh:
        fh.write("\n".join(REPORT))
    pd.DataFrame(COLUMN_RECS).to_csv(csv, index=False, encoding="utf-8-sig")
    out(f"\n  Full report : {rpt}")
    out(f"  Column CSV  : {csv}   (open in Excel to filter/sort every column of every sheet)")
    out(f"  Took {(datetime.now() - t0).total_seconds():.1f}s")
    return 1 if errs else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)