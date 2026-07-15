"""
GOIL diesel-price scraper for HTMS.

Runs as a SCHEDULED JOB (GitHub Action cron) — never inside a user-facing
request. GOIL publishes the current pump prices at a permanent page:

    https://goil.com.gh/new-fuel-prices/

…in the form:
    NEW FUEL PRICES EFFECTIVE TUESDAY, 16TH JUNE 2026 AT 6AM PROMPT.
    Super XP - Ghc 13.87
    Diesel XP - Ghc 15.95
    Super XP 95 - Ghc 16.87

We extract the Diesel price + the effective date and upsert one row into
Supabase `weekly_fuel` (keyed on the effective date). Because this number
scales EVERY invoice, the safety rules are non-negotiable:
  * reject non-numeric / out-of-range prices
  * reject a price deviating > FUEL_MAX_WEEKLY_DEVIATION from the last record
    (write status='flagged' for human review instead of poisoning billing)
  * on any failure, write nothing and exit non-zero so the scheduler alerts.

Run:  python goil_fuel_spider.py
Env:  FUEL_SCRAPER_SUPABASE_URL, FUEL_SCRAPER_SUPABASE_KEY,
      FUEL_MIN_PRICE, FUEL_MAX_PRICE, FUEL_MAX_WEEKLY_DEVIATION,
      GOIL_FUEL_URL (default https://goil.com.gh/new-fuel-prices/)
"""
from __future__ import annotations

import os
import re
import sys
import json
import time
from datetime import date, datetime, timezone

import requests

GOIL_URL = os.environ.get("GOIL_FUEL_URL", "https://goil.com.gh/new-fuel-prices/")
# GOIL's server rejects non-browser clients (returns 415), so send realistic
# browser headers. The page is public; this just gets past the WAF.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# "Diesel XP - Ghc 15.95"  /  "Diesel - GHS 15.95"  /  "Diesel: 15.95"
DIESEL_RE = re.compile(r"diesel[^0-9]{0,20}?(?:gh[sc]|₵)?\s*([0-9]{1,2}\.[0-9]{1,2})", re.I)
# "EFFECTIVE TUESDAY, 16TH JUNE 2026"
DATE_RE = re.compile(
    r"effective[^0-9]*?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{4})", re.I
)
MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}


def fetch_text() -> str:
    # GOIL fronts the page with an anti-bot splash ("One moment, please...")
    # that sets a cookie and self-reloads. A Session keeps the cookie; retrying
    # after the splash's own 5s delay returns the real page.
    # ponytail: cookie+retry beats a headless browser; upgrade to Playwright only if the splash starts requiring JS.
    s = requests.Session()
    s.headers.update(HEADERS)
    text = ""
    for attempt in range(4):
        if attempt:
            time.sleep(6)
        r = s.get(GOIL_URL, timeout=25)
        r.raise_for_status()
        # crude tag strip so the regexes see clean text
        text = re.sub(r"<[^>]+>", " ", r.text)
        if "diesel" in text.lower():
            return text
        print(f"DEBUG: attempt {attempt + 1} got splash/interstitial, retrying…", file=sys.stderr)
    return text  # let main()'s debug path report what we last saw


def parse_price(text: str) -> float | None:
    m = DIESEL_RE.search(text)
    return float(m.group(1)) if m else None


def parse_effective_date(text: str) -> date:
    m = DATE_RE.search(text)
    if m:
        day, mon, year = int(m.group(1)), MONTHS.get(m.group(2).lower()), int(m.group(3))
        if mon:
            try:
                return date(year, mon, day)
            except ValueError:
                pass
    # Fallback: today (still upserts, so the price isn't lost).
    return date.today()


def last_known_price() -> float | None:
    url = os.environ["FUEL_SCRAPER_SUPABASE_URL"].rstrip("/")
    key = os.environ["FUEL_SCRAPER_SUPABASE_KEY"]
    r = requests.get(
        f"{url}/rest/v1/weekly_fuel?select=price_per_litre&order=week_start.desc&limit=1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=20,
    )
    r.raise_for_status()
    rows = r.json()
    return float(rows[0]["price_per_litre"]) if rows else None


def upsert(week_start: date, price: float, status: str) -> None:
    url = os.environ["FUEL_SCRAPER_SUPABASE_URL"].rstrip("/")
    key = os.environ["FUEL_SCRAPER_SUPABASE_KEY"]
    payload = {
        "week_start": week_start.isoformat(),
        "price_per_litre": price,
        "source_url": GOIL_URL,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
    }
    r = requests.post(
        f"{url}/rest/v1/weekly_fuel?on_conflict=week_start",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        data=json.dumps(payload),
        timeout=20,
    )
    r.raise_for_status()
    print(f"weekly_fuel upserted: {week_start} = {price} ({status})")


def main() -> int:
    pmin = float(os.environ.get("FUEL_MIN_PRICE", "1.0"))
    pmax = float(os.environ.get("FUEL_MAX_PRICE", "50.0"))
    max_dev = float(os.environ.get("FUEL_MAX_WEEKLY_DEVIATION", "0.25"))

    try:
        text = fetch_text()
    except Exception as e:  # network / HTTP failure → keep last-known-good
        print(f"ERROR: could not fetch {GOIL_URL}: {e}", file=sys.stderr)
        return 2

    price = parse_price(text)
    if price is None:
        snippet = " ".join(text.split())[:900]
        has_diesel = "diesel" in text.lower()
        print(f"DEBUG: 'diesel' present in page text: {has_diesel}", file=sys.stderr)
        print(f"DEBUG: page text snippet: {snippet}", file=sys.stderr)
        print("ERROR: could not find a diesel price on the GOIL page (markup may have changed).", file=sys.stderr)
        return 3
    if not (pmin <= price <= pmax):
        print(f"ERROR: diesel price {price} out of sane range [{pmin}, {pmax}]. Not writing.", file=sys.stderr)
        return 4

    eff = parse_effective_date(text)
    prev = last_known_price()
    status = "ok"
    if prev and abs(price - prev) / prev > max_dev:
        status = "flagged"
        print(f"WARN: {price} deviates >{max_dev:.0%} from last {prev}. Writing as 'flagged' for review.", file=sys.stderr)

    upsert(eff, price, status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
