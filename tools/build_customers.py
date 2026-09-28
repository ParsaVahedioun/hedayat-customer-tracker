# -*- coding: utf-8 -*-
"""
build_customers.py  —  xlsx  ->  data/customers.json

Reads "لیست مشتریان به همراه آدرس(1).xlsx" with only the standard library
(zipfile + xml.etree), merges Sheet1 + Sheet2, de-duplicates by account code,
drops the hierarchy/group rows, parses every code LEFT -> RIGHT via
refdata.parse_customer_code, derives province/city, extracts any embedded
phone numbers, and writes the customer dataset consumed by the web app.

Usage:
    python tools/build_customers.py [path-to-xlsx]
"""
import glob
import json
import os
import re
import sys
import zipfile
from collections import Counter, OrderedDict
from xml.etree import ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refdata import (  # noqa: E402
    ALLOWED_PROVINCES,
    CITIES,
    PROVINCES,
    REGION_CODES,
    REGION_PROVINCE_CITY,
    parse_customer_code,
)

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_XLSX = os.path.join(os.path.expanduser("~"), "Downloads", "لیست مشتریان به همراه آدرس(1).xlsx")
OUT = os.path.join(ROOT, "data", "customers.json")


# --------------------------------------------------------------------------- #
# xlsx reading
# --------------------------------------------------------------------------- #
def _shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    return ["".join(t.text or "" for t in si.iter(NS + "t")) for si in root.findall(NS + "si")]


def _read_sheet(z, name, shared):
    """Return a list of dicts {colLetter: value} for every row."""
    root = ET.fromstring(z.read(name))
    rows = []
    for row in root.findall(NS + "sheetData/" + NS + "row"):
        cells = {}
        for c in row.findall(NS + "c"):
            ref = c.get("r") or ""
            col = "".join(ch for ch in ref if ch.isalpha())
            t = c.get("t")
            v = c.find(NS + "v")
            isv = c.find(NS + "is")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr" and isv is not None:
                val = "".join(x.text or "" for x in isv.iter(NS + "t"))
            elif v is not None:
                val = v.text
            else:
                val = ""
            cells[col] = (val or "").strip()
        rows.append(cells)
    return rows


def _norm_digits(s):
    return (s or "").translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))


def extract_phones(*texts):
    """Pull mobile/landline numbers embedded in free text."""
    mobile, phone = "", ""
    for text in texts:
        t = _norm_digits(text or "")
        for run in re.findall(r"\d[\d\-\s]{6,}\d", t):
            digits = re.sub(r"\D", "", run)
            if digits.startswith("0098"):
                digits = "0" + digits[4:]
            if len(digits) == 14 and digits.startswith("98"):
                digits = "0" + digits[2:]
            if not mobile and len(digits) == 11 and digits.startswith("09"):
                mobile = digits
            elif not mobile and len(digits) == 10 and digits.startswith("9"):
                mobile = "0" + digits
            elif not phone and len(digits) == 11 and digits.startswith("0"):
                phone = digits
            elif not phone and len(digits) == 8:
                phone = digits
    return phone, mobile


def guess_place(address, region_code):
    """Best-effort city/province from the address text; region is the fallback.

    Matching is anchored to the START of the address, because that is where the
    city/province actually appears ("اصفهان- چهارراه مصدق", "تهران لاله زار").
    Street names later in the string frequently collide with place names
    ("پاساژ گلستان", "خیابان همدانیان"), so they are ignored.
    """
    default_prov, default_city = REGION_PROVINCE_CITY.get(region_code, ("نامشخص", ""))
    stripped = (address or "").strip()
    city = ""
    explicit_province = ""
    for token in sorted(CITIES, key=len, reverse=True):
        if stripped.startswith(token):
            city, explicit_province = CITIES[token]
            break
    if not explicit_province:
        for token in sorted(PROVINCES, key=len, reverse=True):
            if stripped.startswith(token):
                explicit_province = PROVINCES[token]
                break
    allowed = ALLOWED_PROVINCES.get(region_code, set())
    conflict = bool(explicit_province) and explicit_province not in allowed
    return (explicit_province or default_prov), (city or default_city), conflict


def split_name(raw):
    """'نام‌خانوادگی- نام- فروشگاه- 1' -> (display name, company name)."""
    parts = [p.strip() for p in re.split(r"[-–—]", raw or "") if p.strip()]
    if len(parts) >= 3:
        return f"{parts[0]} {parts[1]}".strip(), parts[2]
    if len(parts) == 2:
        return f"{parts[0]} {parts[1]}".strip(), ""
    return (raw or "").strip(), ""


def is_group_row(code):
    """Hierarchy rows in Sheet1 (type '12', region '1200XX') are not customers."""
    if len(code) == 2:
        return True
    if len(code) == 6 and code.startswith("1200"):
        return True
    return False


def main():
    xlsx = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSX
    if not os.path.exists(xlsx):
        candidates = glob.glob(os.path.join(os.path.dirname(xlsx), "*.xlsx"))
        if not candidates:
            sys.exit(f"xlsx not found: {xlsx}")
        xlsx = candidates[0]
    print(f"[build] source: {os.path.basename(xlsx)}")

    with zipfile.ZipFile(xlsx) as z:
        shared = _shared_strings(z)
        s1 = _read_sheet(z, "xl/worksheets/sheet1.xml", shared)[1:]
        s2 = _read_sheet(z, "xl/worksheets/sheet2.xml", shared)[1:]

    merged = OrderedDict()
    skipped = 0
    for sheet_name, rows in (("sheet1", s1), ("sheet2", s2)):
        for r in rows:
            code = str(r.get("A", "")).strip()
            if not code:
                continue
            if is_group_row(code):
                skipped += 1
                continue
            address = str(r.get("C", "")).strip()
            label = str(r.get("B", "")).strip()
            rec = merged.get(code)
            if rec is None:
                merged[code] = {
                    "code": code,
                    "nameRaw": label,
                    "address": address,
                    "sheets": {sheet_name},
                }
            else:
                rec["sheets"].add(sheet_name)
                # Prefer Sheet2's "نام" (usually the cleaner customer name),
                # otherwise keep the first non-empty label.
                if sheet_name == "sheet2" and label:
                    rec["nameRaw"] = label
                if not rec["address"] and address:
                    rec["address"] = address

    customers = []
    warnings_index = Counter()
    for i, (code, rec) in enumerate(sorted(merged.items()), start=1):
        parsed = parse_customer_code(code)
        warnings = []

        if not parsed["valid"]:
            if len(code) != 10:
                warnings.append("طول کد مشتری ۱۰ رقم نیست")
            if not code.isdigit():
                warnings.append("کد مشتری شامل حروف است")
            warnings.append("نوع مشتری نامعتبر")
            warnings.append("کد منطقه نامعتبر")
        else:
            if parsed["customerType"] == "نامشخص":
                warnings.append("نوع مشتری نامعتبر")
            if parsed["regionCode"] not in REGION_CODES:
                warnings.append("کد منطقه نامعتبر")

        address = rec["address"]
        has_addr = address not in ("", "ندارد", "-")
        if not has_addr:
            warnings.append("آدرس ثبت نشده است")

        province, city, conflict = guess_place(address, parsed["regionCode"])
        if conflict:
            warnings.append("استان آدرس با کد منطقه هم‌خوانی ندارد")

        phone, mobile = extract_phones(rec["nameRaw"], address)
        name, company = split_name(rec["nameRaw"])

        for w in warnings:
            warnings_index[w] += 1

        customers.append(OrderedDict([
            ("id", f"customer-{i:06d}"),
            ("customerCode", parsed["code"]),
            ("customerTypeCode", parsed["customerTypeCode"]),
            ("customerType", parsed["customerType"]),
            ("regionCode", parsed["regionCode"]),
            ("regionName", parsed["regionName"]),
            ("province", province),
            ("city", city),
            ("name", name),
            ("companyName", company),
            ("phone", phone),
            ("mobile", mobile),
            ("address", address),
            ("latitude", None),
            ("longitude", None),
            ("salesType", ""),
            ("balance", None),
            ("locationStatus", "unknown"),
            ("nameRaw", rec["nameRaw"]),
            ("serial", parsed["serial"]),
            ("hasAddress", has_addr),
            ("sourceSheet", "both" if len(rec["sheets"]) > 1 else next(iter(rec["sheets"]))),
            ("warnings", warnings),
        ]))

    data = OrderedDict([
        ("meta", OrderedDict([
            ("source", os.path.basename(xlsx)),
            ("generatedBy", "tools/build_customers.py"),
            ("count", len(customers)),
            ("groupRowsSkipped", skipped),
            ("note", "Customer Code is a 10-digit account code parsed LEFT->RIGHT: "
                     "chars[0:2]=type, chars[2:4]='00' pad, chars[4:6]=region, chars[6:10]=serial."),
        ])),
        ("customers", customers),
    ])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    # ---- report ---------------------------------------------------------- #
    print(f"[build] wrote {OUT}")
    print(f"[build] customers={len(customers)}  group/header rows skipped={skipped}")
    types = Counter(c["customerType"] for c in customers)
    print(f"[build] types: {dict(types)}")
    regions = Counter(c["regionCode"] for c in customers)
    print(f"[build] distinct regions={len(regions)}  (invalid={sum(v for k, v in regions.items() if k not in REGION_CODES)})")
    provinces = Counter(c["province"] for c in customers)
    print(f"[build] distinct provinces={len(provinces)}  top5={provinces.most_common(5)}")
    with_addr = sum(1 for c in customers if c["hasAddress"])
    print(f"[build] with address={with_addr}  without={len(customers) - with_addr}")
    print(f"[build] phones found: mobile={sum(1 for c in customers if c['mobile'])}  "
          f"landline={sum(1 for c in customers if c['phone'])}")
    print("[build] warnings:")
    for w, n in warnings_index.most_common():
        print(f"          - {w}: {n}")


if __name__ == "__main__":
    main()
