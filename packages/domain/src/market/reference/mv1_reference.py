"""Reference implementation of market value method mv-1 (spec 6.2, ADR 0040).

Written apart from market-value.ts, in another language, to produce the expected values of the
golden fixture. It builds synthetic sets from a seeded generator, computes each with the method
below and writes market-cases.v1.json next to market-value.ts.

Run from the repo root:
    python3 packages/domain/src/market/reference/mv1_reference.py

Standard library only.
"""

import json
import math
import random
from pathlib import Path

METHOD_VERSION = "mv-1"
AT = "2026-10-22T02:10:00.000Z"
DAY_MS = 86_400_000
HALF_LIFE_DAYS = 14.0
POOL_DAYS = 30
TOO_CHEAP_SHARE = 0.6
MAD_SCALE = 1.4826
OUTLIER_Z = 3.5
TOLERANCE = 1e-12

OUT = Path(__file__).resolve().parent.parent / "market-cases.v1.json"


def ms_ago(days):
    return round(days * DAY_MS)


def quantile(points, p):
    """Lowest price whose cumulative weight reaches p of the total; the middle of it and the
    next price when the cumulative weight lands exactly on p of the total."""
    pts = sorted(points)
    total = sum(w for _, w in pts)
    target = p * total
    tol = TOLERANCE * total
    cum = 0.0
    for i, (x, w) in enumerate(pts):
        cum += w
        if cum < target - tol:
            continue
        if i + 1 < len(pts) and abs(cum - target) <= tol:
            return (x + pts[i + 1][0]) / 2
        return x
    return pts[-1][0]


def half_up(x):
    return math.floor(x + 0.5)


def mv1(case):
    inp = case["input"]
    window_ms = POOL_DAYS * DAY_MS
    counts = {}
    asks = []
    for r in case["rows"]:
        if r["conditionGroup"] != inp["conditionGroup"]:
            continue
        if r["matchVersion"] != inp["matchVersion"] or r["source"] != inp["source"]:
            continue
        if ms_ago(r["lastSeenDaysAgo"]) > window_ms:
            continue
        if r["excludedReason"] is not None:
            reason = r["excludedReason"]
        elif r["key"] in inp["wrongProductItemKeys"]:
            reason = "wrong_product"
        elif inp["perGb"] and r["unitTotal"] is None:
            reason = "unknown_total"
        else:
            reason = None
        if reason is not None:
            counts[reason] = counts.get(reason, 0) + 1
            continue
        origin = r["originDaysAgo"] if r["originDaysAgo"] is not None else r["firstSeenDaysAgo"]
        age_days = max(0, ms_ago(origin)) / DAY_MS
        weight = 0.5 ** (age_days / HALF_LIFE_DAYS)
        price = r["landedCents"] / r["unitTotal"] if inp["perGb"] else r["landedCents"]
        asks.append((price, weight, r["bestOffer"]))

    empty = {
        "status": "none", "n": 0, "neff": 0, "mCents": None, "p25Cents": None, "p75Cents": None,
        "loCents": None, "hiCents": None, "halfWidth": None, "bestOfferShare": None,
        "valueCents": None, "counts": counts,
    }
    if not asks:
        return empty

    points = [(x, w) for x, w, _ in asks]
    m0 = quantile(points, 0.5)
    step1 = [a for a in asks if a[0] >= TOO_CHEAP_SHARE * m0]
    if len(asks) - len(step1):
        counts["too_cheap"] = len(asks) - len(step1)

    m1 = quantile([(x, w) for x, w, _ in step1], 0.5)
    s = MAD_SCALE * quantile([(abs(x - m1), w) for x, w, _ in step1], 0.5)
    step2 = step1 if s == 0 else [a for a in step1 if (a[0] - m1) / s <= OUTLIER_Z]
    if len(step1) - len(step2):
        counts["outlier"] = len(step1) - len(step2)

    pts = [(x, w) for x, w, _ in step2]
    sum_w = sum(w for _, w in pts)
    sum_w2 = sum(w * w for _, w in pts)
    neff = sum_w * sum_w / sum_w2
    m = quantile(pts, 0.5)
    reach = 0.98 / math.sqrt(neff)
    lo = quantile(pts, max(0.0, 0.5 - reach))
    hi = quantile(pts, min(1.0, 0.5 + reach))
    half_width = max(m - lo, hi - m) / m if m > 0 else None
    if neff < 8:
        status = "none"
    elif neff >= 15 and half_width is not None and half_width <= 0.15:
        status = "ok"
    else:
        status = "rough"
    return {
        "status": status,
        "n": len(step2),
        "neff": neff,
        "mCents": half_up(m),
        "p25Cents": half_up(quantile(pts, 0.25)),
        "p75Cents": half_up(quantile(pts, 0.75)),
        "loCents": half_up(lo),
        "hiCents": half_up(hi),
        "halfWidth": half_width,
        "bestOfferShare": sum(1 for a in step2 if a[2]) / len(step2),
        "valueCents": half_up(m),
        "counts": counts,
    }


class Rows:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.count = 0
        self.rows = []

    def add(self, landed, age, **extra):
        self.count += 1
        row = {
            "key": f"k{self.count}",
            "landedCents": landed,
            "originDaysAgo": round(age, 2),
            "firstSeenDaysAgo": round(age, 2),
            "lastSeenDaysAgo": round(self.rng.uniform(0, min(age, 2)), 2),
            "conditionGroup": "used",
            "matchVersion": 3,
            "source": "ebay",
            "unitTotal": None,
            "bestOffer": self.rng.random() < 0.3,
            "excludedReason": None,
        }
        row.update(extra)
        self.rows.append(row)
        return row

    def market(self, count, base, spread, max_age=28.0):
        for _ in range(count):
            self.add(round(base * self.rng.uniform(1 - spread, 1 + spread)), self.rng.uniform(0, max_age))


def input_of(**extra):
    base = {
        "conditionGroup": "used",
        "matchVersion": 3,
        "source": "ebay",
        "perGb": False,
        "capped": False,
        "wrongProductItemKeys": [],
    }
    base.update(extra)
    return base


def case(case_id, note, rows, **inp):
    return {"id": case_id, "note": note, "at": AT, "input": input_of(**inp), "rows": rows.rows}


def build():
    cases = []

    r = Rows(1)
    r.market(45, 61_000, 0.12)
    cases.append(case("ok-used-45", "45 used asks within 12 % of EUR 610 over 4 weeks", r))

    r = Rows(2)
    r.market(30, 24_000, 0.1)
    for _ in range(4):
        r.add(round(24_000 * r.rng.uniform(0.15, 0.5)), r.rng.uniform(0, 10))
    for _ in range(3):
        r.add(round(24_000 * r.rng.uniform(1.8, 3.0)), r.rng.uniform(0, 10))
    cases.append(case("scams-and-dealers", "30 asks, 4 scams below 0.6 x and 3 bundle or dealer asks", r))

    r = Rows(3)
    r.market(10, 15_500, 0.08, max_age=6)
    cases.append(case("rough-ten", "10 fresh asks: neff between 8 and 14", r))

    r = Rows(4)
    r.market(5, 9_900, 0.05)
    cases.append(case("none-five", "5 asks: not enough listings", r))

    r = Rows(5)
    r.market(25, 120_000, 0.4, max_age=5)
    cases.append(case("rough-wide", "25 fresh asks spread 40 % either side: interval too wide", r))

    r = Rows(6)
    for _ in range(30):
        r.add(round(48_000 * r.rng.uniform(0.9, 1.1)), r.rng.uniform(20, 29.5))
    for _ in range(6):
        r.add(round(42_000 * r.rng.uniform(0.95, 1.05)), r.rng.uniform(0, 2))
    cases.append(case("old-and-fresh", "30 asks 3 to 4 weeks old and 6 cheaper fresh ones", r))

    r = Rows(7)
    for _ in range(36):
        total = r.rng.choice([16, 32, 64])
        r.add(round(total * r.rng.uniform(140, 190)), r.rng.uniform(0, 25), unitTotal=total)
    r.add(5_000, 1.0)
    cases.append(case("per-gb", "36 kits priced per GB and one without a total", r, perGb=True))

    r = Rows(8)
    r.market(20, 33_000, 0.1)
    r.add(1_000, 1.0, conditionGroup="new")
    r.add(1_000, 1.0, matchVersion=2)
    r.add(1_000, 1.0, source="kleinanzeigen")
    r.add(1_000, 31.0, lastSeenDaysAgo=30.5)
    r.add(1_000, 1.0, excludedReason="unknown_shipping")
    r.add(1_000, 1.0, excludedReason="unknown_shipping")
    r.add(1_000, 1.0, excludedReason="auction")
    r.add(1_000, 1.0, conditionGroup=None, excludedReason="no_condition_group")
    wrong = [r.add(30_000, 1.0)["key"], r.add(31_000, 2.0)["key"]]
    cases.append(case(
        "mixed-pool",
        "rows of other groups, versions, sources and older than 30 days, excluded rows and wrong products",
        r,
        wrongProductItemKeys=wrong,
    ))

    r = Rows(9)
    for _ in range(18):
        r.add(19_900, r.rng.uniform(0, 20))
    r.add(29_900, 1.0)
    cases.append(case("zero-spread", "18 asks at the same price: the outlier step is skipped", r))

    r = Rows(10)
    r.market(24, 72_000, 0.1)
    for row in r.rows[:8]:
        row["originDaysAgo"] = None
    cases.append(case("unknown-origin", "8 of 24 rows without an origin date: weighted by first sighting", r))

    r = Rows(11)
    r.market(60, 8_000, 0.15)
    cases.append(case("capped", "60 asks from a snapshot that hit its page cap: a warning only", r, capped=True))

    r = Rows(13)
    r.market(40, 36_000, 0.1, max_age=3)
    pts = [(row["landedCents"], 0.5 ** (row["originDaysAgo"] / HALF_LIFE_DAYS)) for row in r.rows]
    centre = quantile(pts, 0.5)
    spread = MAD_SCALE * quantile([(abs(x - centre), w) for x, w in pts], 0.5)
    r.add(round(centre + 3.4 * spread), 1.0)
    r.add(round(centre + 4.0 * spread), 1.0)
    cases.append(case("near-fence", "two high asks, one 3.4 and one 4 spreads above the median", r))

    r = Rows(14)
    for price in (51_000, 52_000, 54_500, 56_000, 56_500, 58_500, 72_000, 10_000):
        r.add(price, 2.0)
    cases.append(case(
        "scam-keeps-fence",
        "a dropped scam does not widen the spread: centred on the median after step 1",
        r,
    ))

    r = Rows(12)
    r.add(1_000, 1.0, excludedReason="unknown_shipping")
    r.add(1_000, 1.0, excludedReason="best_offer_only")
    cases.append(case("only-excluded", "every row excluded: no value", r))

    for c in cases:
        c["expect"] = mv1(c)
    return {"methodVersion": METHOD_VERSION, "cases": cases}


def dump(fixture):
    """JSON with one line per row, so the fixture stays small and diffs stay readable."""
    out = ["{", f' "methodVersion": {json.dumps(fixture["methodVersion"])},', ' "cases": [']
    for i, c in enumerate(fixture["cases"]):
        out.append("  {")
        for key in ("id", "note", "at", "input", "expect"):
            out.append(f"   {json.dumps(key)}: {json.dumps(c[key])},")
        out.append('   "rows": [')
        out.append(",\n".join(f"    {json.dumps(r)}" for r in c["rows"]))
        out.append("   ]")
        out.append("  }" + ("," if i + 1 < len(fixture["cases"]) else ""))
    out.append(" ]")
    out.append("}")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    OUT.write_text(dump(build()))
    print(f"wrote {OUT}")
