# -*- coding: utf-8 -*-
"""
export_js.py  —  mirror data/customers.json into data/customers.js

Opening index.html straight from disk (file://) makes browsers refuse the
fetch() of a local .json file. The app therefore also ships the same dataset as
a plain JS global, which a <script> tag can always load. Run this after
build_customers.py / geocode.py.

Usage:  python tools/export_js.py
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "customers.json")
OUT = os.path.join(ROOT, "data", "customers.js")

with open(SRC, encoding="utf-8") as f:
    doc = json.load(f)

with open(OUT, "w", encoding="utf-8") as f:
    f.write("/* Auto-generated from data/customers.json by tools/export_js.py.\n")
    f.write("   Fallback dataset so the app also works over file:// (no fetch). */\n")
    f.write("window.CUSTOMERS_DATA = ")
    json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

print(f"[export] {OUT}  ({os.path.getsize(OUT) / 1024:.0f} KB, {len(doc['customers'])} customers)")
