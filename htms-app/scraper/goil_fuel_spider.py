"""
GOIL diesel-price scraper for HTMS.

Runs as a SCHEDULED JOB (GitHub Action cron / container) — never inside a
user-facing request. Scrapes the current diesel (AGO) price from goil.com.gh,
validates it hard, and upserts one row into Supabase `weekly_fuel`.

Because this number scales EVERY invoice, the safety rules are non-negotiable:
  * reject non-numeric / out-of-range prices
  * reject a price that deviates > FUEL_MAX_WEEKLY_DEVIATION from last week
    (write status='flagged' for human review instead of poisoning billing)
  * on any failure, DO NOT write — keep last-known-good and exit non-zero so
    the scheduler alerts.

Run:  python goil_fuel_spider.py
Env:  FUEL_SCRAPER_SUPABASE_URL, FUEL_SCRAPER_SUPABASE_KEY,
      FUEL_MIN_PRICE, FUEL_MAX_PRICE, FUEL_MAX_WEEKLY_DEVIATION,
      GOIL_FUEL_URL (default https://goil.com.gh/), GOIL_PRICE_SELECTOR (optional CSS/regex hint)
"""
from __future__ import annotations

import os
import re
import sys
import json
from datetime import date, timedelta

import requests
import scrapy
from scrapy.crawler import CrawlerProcess


GOIL_URL = os.environ.get("GOIL_FUEL_URL", "https://goil.com.gh/")
# Diesel is also called AGO (Automotive Gas Oil) in Ghana.
PRICE_LABELS = re.compile(r"(diesel|ago|gas\s*oil)", re.I)
# A Ghana pump price looks like 12.34 / GHS 12.34 / ₵12.34
PRICE_RE = re.compile(r"(?:gh[sc]|₵)?\s*([0-9]{1,2}\.[0-9]{1,2})", re.I)


def monday_of_week(d: date) -> date:
    return d - timedelta(days=d.weekday())


class GoilFuelSpider(scrapy.Spider):
    name = "goil_fuel"
    start_urls = [GOIL_URL]
    custom_settings = {
        "ROBOTSTXT_OBEY": True,
        "USER_AGENT": "HTMS-FuelBot/1.0 (+ministry energy haulage; contact admin)",
        "DOWNLOAD_TIMEOUT": 20,
        "RETRY_TIMES": 2,
        "LOG_LEVEL": "ERROR",
    }

    def __init__(self, sink: list, *a, **kw):
        super().__init__(*a, **kw)
        self._sink = sink

    def parse(self, response):
        # Strategy: find text nodes mentioning diesel/AGO and grab the nearest price.
        candidates: list[float] = []
        for node in response.xpath("//*[normalize-space(text())]"):
            txt = " ".join(node.xpath(".//text()").getall())
            if PRICE_LABELS.search(txt):
                for m in PRICE_RE.finditer(txt):
                    candidates.append(float(m.group(1)))
        # Fallback: optional explicit selector hint.
        sel = os.environ.get("GOIL_PRICE_SELECTOR")
        if not candidates and sel:
            for t in response.css(sel + " ::text").getall():
                for m in PRICE_RE.finditer(t):
                    candidates.append(float(m.group(1)))
        if candidates:
            # Diesel is typically the highest of the common fuels listed; pick a robust value.
            self._sink.append(max(candidates))


def scrape_price() -> float | None:
    sink: list[float] = []
    process = CrawlerProcess(settings={"TELNETCONSOLE_ENABLED": False})
    process.crawl(GoilFuelSpider, sink=sink)
    process.start()  # blocks until done
    return sink[0] if sink else None


def upsert(price: float, status: str) -> None:
    url = os.environ["FUEL_SCRAPER_SUPABASE_URL"].rstrip("/")
    key = os.environ["FUEL_SCRAPER_SUPABASE_KEY"]
    week = monday_of_week(date.today()).isoformat()
    payload = {
        "week_start": week,
        "price_per_litre": price,
        "source_url": GOIL_URL,
        "scraped_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
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
    print(f"weekly_fuel upserted: {week} = {price} ({status})")


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


def main() -> int:
    pmin = float(os.environ.get("FUEL_MIN_PRICE", "1.0"))
    pmax = float(os.environ.get("FUEL_MAX_PRICE", "50.0"))
    max_dev = float(os.environ.get("FUEL_MAX_WEEKLY_DEVIATION", "0.25"))

    price = scrape_price()
    if price is None:
        print("ERROR: could not extract a diesel price from GOIL. Keeping last-known-good.", file=sys.stderr)
        return 2

    if not (pmin <= price <= pmax):
        print(f"ERROR: scraped price {price} out of sane range [{pmin}, {pmax}]. Not writing.", file=sys.stderr)
        return 3

    prev = last_known_price()
    status = "ok"
    if prev and abs(price - prev) / prev > max_dev:
        # Suspicious jump — write but FLAG for human review so it isn't trusted blindly.
        status = "flagged"
        print(f"WARN: {price} deviates >{max_dev:.0%} from last {prev}. Writing as 'flagged'.", file=sys.stderr)

    upsert(price, status)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
