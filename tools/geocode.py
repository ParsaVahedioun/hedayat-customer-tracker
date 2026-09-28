# -*- coding: utf-8 -*-
"""
geocode.py  —  fill latitude/longitude for customers in data/customers.json.

Uses the Photon geocoder (photon.komoot.io, OpenStreetMap based, no API key).
Nominatim is not usable here (this host is blocked by the OSMF policy), Photon is.

Strategy per customer
---------------------
1. Build a *cleaned* street query: strip phone numbers and descriptive noise
   ("روبروی", "جنب", "نبش", "طبقه", "فروشگاه ..."), keep the first street-like
   part, then append the city name.
2. Ask Photon for several candidates, biased towards the region centroid.
3. Accept a candidate only if it is within MAX_KM of the region centroid AND its
   city/county/state text mentions the expected city (this is what rejects
   Photon's frequent wrong-city matches, e.g. "خیابان طالقانی اصفهان" -> Kashan).
4. Otherwise the customer keeps latitude/longitude = null and simply shows up in
   the app's "مشتریان بدون موقعیت" list. Nothing is ever invented.

Geocoded rows get locationStatus="approximate" plus geoPrecision / geoDistanceKm
/ geoQuery so the UI can be explicit that the point is an estimate.

The run is resumable: every query/answer is cached in tools/geocode-cache.json,
so a run can be split across several invocations with --budget.

Usage:
    python tools/geocode.py [--budget SECONDS] [--workers N] [--limit N] [--sample N]
"""
import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refdata import CITIES, PROVINCES, REGION_CENTROIDS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data", "customers.json")
CACHE = os.path.join(HERE, "geocode-cache.json")

API = "https://photon.komoot.io/api/"
HEADERS = {"User-Agent": "hedayat-customer-tracker/1.0 (static customer map)"}
MAX_KM = 30.0
LIMIT = 6
# Whole-city / province matches are just centroids — they would stack every
# customer of a city on one dot, which is exactly the fake-looking result we
# want to avoid. Neighbourhood ("locality") and district matches are fine.
REJECT_TYPES = {"city", "state", "county", "country", "region"}

NOISE = [
    "رو به روی", "روبروی", "روبرو", "جنب", "نبش", "نرسیده به", "بعد از", "قبل از",
    "حد فاصل", "مابین", "بین ", "ابتدای", "انتهای", "انتهای", "سمت", "طرف", "داخل",
    "طبقه", "واحد", "پلاک", "مغازه", "فروشگاه", "کارگاه", "مجتمع تجاری", "مجتمع",
    "داخلی", "شماره", "تلفن", "همراه", "دفتر", "انبار", "پاساژ", "مرکز خرید",
]
STREET_HINTS = ("خیابان", "خ ", "کوچه", "میدان", "بلوار", "چهارراه", "سه راه", "بزرگراه",
                "اتوبان", "شهرک", "خیابان‌", "فلکه", "میدون", "پل ", "کوی", "مکینه", "بازار")


def norm_digits(s):
    return (s or "").translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))


def _strip_noise(text):
    for token in NOISE:
        text = text.replace(token, " ")
    text = re.sub(r"\b\d+\b", " ", text)
    text = re.sub(r"[()\[\]{}«»\"'؛،:;,.!؟?*+/\\|]+", " ", text)
    return re.sub(r"\s+", " ", text).strip(" -–—")


def clean_address(address):
    """Strip phones + descriptive noise, return a short locator string."""
    t = norm_digits(address)
    t = re.sub(r"\+?98|0\d{2,3}[\s-]?\d{7,8}|09\d{9}|\b\d{8,}\b", " ", t)
    t = t.replace("_", " ").replace("\u200c", " ")
    parts = [_strip_noise(p) for p in re.split(r"[-–—،,:;]", t)]
    parts = [p for p in parts if len(p) > 2]
    return " ".join(parts)


def street_phrase(address, city):
    """The first meaningful street phrase of the address (city prefix removed).

    Long noisy queries ("خ فردوسی رو به روی آبمیوه دریا جنب بانک... اصفهان")
    make Photon return nothing useful, while the bare street phrase
    ("فردوسی اصفهان") resolves cleanly. So this is tried FIRST.
    """
    t = norm_digits(address)
    t = re.sub(r"\+?98|0\d{2,3}[\s-]?\d{7,8}|09\d{9}|\b\d{8,}\b", " ", t)
    t = t.replace("_", " ").replace("\u200c", " ")
    segments = [s.strip(" -–—") for s in re.split(r"[-–—،,:;]", t)]
    segments = [s for s in segments if s]
    while segments:
        head = segments[0]
        if head in CITIES or head in PROVINCES or (city and head.startswith(city)):
            segments.pop(0)
        else:
            break
    if not segments:
        return ""
    words = _strip_noise(segments[0]).split()
    words = [w for w in words if len(w) > 1]
    return " ".join(words[:3])


def build_queries(customer):
    city = (customer.get("city") or "").strip()
    address = customer.get("address", "")
    phrase = street_phrase(address, city)
    cleaned = clean_address(address)
    raw = norm_digits(address).replace("_", " ")

    queries = []
    if phrase:
        queries.append(f"{phrase} {city}".strip())
    if cleaned and cleaned != phrase:
        queries.append(f"{cleaned[:70]} {city}".strip())
    if raw and raw[:70] != cleaned[:70]:
        queries.append(f"{raw[:70]} {city}".strip())
    # NOTE: deliberately no "city name only" fallback — that would just stack
    # every customer of a city on the same city-centre point.
    return queries


def haversine(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    x = (0.5 - math.cos((la2 - la1) * p) / 2
         + math.cos(la1 * p) * math.cos(la2 * p) * (1 - math.cos((lo2 - lo1) * p)) / 2)
    return 12742 * math.asin(math.sqrt(x))


def photon(query, bias):
    params = {"q": query, "limit": LIMIT}
    if bias:
        params["lat"], params["lon"] = bias
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.loads(r.read().decode("utf-8")).get("features", [])
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return []


def city_matches(props, city):
    if not city:
        return True
    hay = " ".join(str(props.get(k, "")) for k in
                   ("city", "district", "county", "state", "name", "locality", "suburb"))
    return city in hay


def _tokens(text):
    return {t for t in re.split(r"[\s\-–—،,:;()]+", text or "") if len(t) >= 3}


def overlaps(query, props):
    """Does the matched feature's name share a real word with the query?

    Used as a preference, not a hard filter: when a query matches nothing real,
    Photon happily returns some random POI in the same city (e.g. a shop called
    "اصفهانی"), and those junk hits are the ones that get reused across dozens
    of unrelated customers.
    """
    return bool(_tokens(query) & _tokens(str(props.get("name", ""))))


def pick(features, bias, city, query):
    """Best candidate: prefer the feature whose NAME is literally in the query.

    For the query "خیابان فردوسی اصفهان" the correct answer is the street named
    "فردوسی" (which appears in the query), not some shop on that street whose
    name merely contains "فردوسی" — otherwise one random business ends up
    absorbing dozens of unrelated customers.
    """
    best = None
    for f in features:
        lo, la = f["geometry"]["coordinates"]
        km = haversine(bias, (la, lo)) if bias else 0.0
        if km > MAX_KM:
            continue
        props = f.get("properties", {})
        if props.get("type") in REJECT_TYPES:
            continue
        if not city_matches(props, city):
            continue
        name = str(props.get("name", ""))
        exact = 0 if (len(name) >= 4 and name in query) else 1
        score = (exact,
                 0 if overlaps(query, props) else 1,
                 0 if props.get("type") in ("house", "street") else 1,
                 km)
        if best is None or score < best[0]:
            best = (score, la, lo, props, km)
    return best


def geocode(customer, cache):
    bias = REGION_CENTROIDS.get(customer.get("regionCode") or "")
    if bias is None:
        return None
    city = (customer.get("city") or "").strip()
    for query in build_queries(customer):
        key = f"{query}|{bias[0]:.4f},{bias[1]:.4f}"
        if key in cache:
            feats = cache[key]
        else:
            feats = photon(query, bias)
            cache[key] = feats
        hit = pick(feats, bias, city, query)
        if hit:
            _, la, lo, props, km = hit
            return {
                "latitude": round(la, 6),
                "longitude": round(lo, 6),
                "geoPrecision": props.get("type", ""),
                "geoDistanceKm": round(km, 2),
                "geoQuery": query,
                "geoMatchedName": props.get("name", ""),
                "geoMatchedCity": props.get("city", "") or props.get("county", ""),
            }
    return None


def drop_overused_points(customers, max_shared_street=200, max_shared_other=3):
    """Guard against a single coordinate being a junk match for many customers.

    Sharing is NOT suspicious per se: many shops sit on the same street, so a
    street-level match is legitimately reused (a street can hold dozens of
    customers — "خیابان فردوسی" ends up with 50). A *building/POI* match reused
    by many different customers is the signature of Photon returning one random
    POI for unrelated queries, so only those are trimmed.
    """
    groups = {}
    for c in customers:
        if c.get("latitude") is None:
            continue
        key = (round(c["latitude"], 4), round(c["longitude"], 4))
        groups.setdefault(key, []).append(c)

    def clear(c):
        c["latitude"] = None
        c["longitude"] = None
        c["locationStatus"] = "unknown"
        for k in ("geoPrecision", "geoDistanceKm", "geoMatchedName", "geoMatchedCity"):
            c.pop(k, None)

    dropped = 0
    for key, rows in groups.items():
        streets = [c for c in rows if c.get("geoPrecision") == "street"]
        others = [c for c in rows if c.get("geoPrecision") != "street"]
        if len(others) > max_shared_other:
            for c in others:
                clear(c)
                dropped += 1
        if len(streets) > max_shared_street:
            for c in streets:
                clear(c)
                dropped += 1
    return dropped


def load_cache():
    if os.path.exists(CACHE):
        try:
            with open(CACHE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_cache(cache):
    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=480, help="seconds to work before saving & exiting")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="max customers this run (0 = all pending)")
    ap.add_argument("--sample", type=int, default=0, help="only process every Nth pending customer")
    ap.add_argument("--reset", action="store_true", help="clear previously applied coordinates first")
    ap.add_argument("--max-shared-street", type=int, default=200)
    ap.add_argument("--max-shared-other", type=int, default=3)
    args = ap.parse_args()

    with open(DATA, encoding="utf-8") as f:
        doc = json.load(f)
    customers = doc["customers"]

    if args.reset:
        for c in customers:
            c["latitude"] = None
            c["longitude"] = None
            c["locationStatus"] = "unknown"
            for k in ("geoPrecision", "geoDistanceKm", "geoQuery", "geoMatchedName", "geoMatchedCity"):
                c.pop(k, None)
        print("[geo] reset: all coordinates cleared")

    cache = load_cache()

    pending = [c for c in customers
               if c.get("latitude") is None and c.get("hasAddress")
               and c.get("regionCode") and c.get("regionCode") != "60"]
    if args.sample:
        pending = pending[::args.sample]
    if args.limit:
        pending = pending[:args.limit]

    done_already = sum(1 for c in customers if c.get("latitude") is not None)
    print(f"[geo] total={len(customers)} already-located={done_already} pending={len(pending)} "
          f"workers={args.workers} budget={args.budget:.0f}s")

    start = time.time()
    results = {}
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(geocode, c, cache): c for c in pending}
        for i, fut in enumerate(futures, 1):
            c = futures[fut]
            try:
                results[c["customerCode"]] = fut.result()
            except Exception as e:
                results[c["customerCode"]] = None
                print(f"      ! {c['customerCode']}: {e}")
            if i % 25 == 0 or i == len(futures):
                hits = sum(1 for v in results.values() if v)
                print(f"      {i}/{len(futures)} done | hits={hits} | {time.time() - start:.0f}s")
            if time.time() - start > args.budget:
                print(f"[geo] budget reached after {i} of {len(futures)}; saving progress")
                for f2 in futures:
                    f2.cancel()
                break

    applied = 0
    for c in customers:
        if c["customerCode"] in results and results[c["customerCode"]]:
            r = results[c["customerCode"]]
            c.update(r)
            c["locationStatus"] = "approximate"
            applied += 1

    dropped = drop_overused_points(customers, args.max_shared_street, args.max_shared_other)

    with open(DATA, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    save_cache(cache)

    located = sum(1 for c in customers if c.get("latitude") is not None)
    remaining = len([c for c in customers
                     if c.get("latitude") is None and c.get("hasAddress")
                     and c.get("regionCode") not in (None, "", "60")])
    print(f"[geo] applied={applied}  dropped-as-shared={dropped}  located={located}/{len(customers)}  "
          f"remaining pending={remaining}")


if __name__ == "__main__":
    main()
