#!/usr/bin/env python3
"""
Extract Shopify theme list from the theme sitemap.

    python extract_themes.py
    python extract_themes.py --json -o themes.json
    python extract_themes.py --url https://themes.shopify.com/sitemap_theme_en.xml
"""

import argparse
import csv
import gzip
import json
import re
import sys
import xml.etree.ElementTree as ET
from urllib.parse import urlparse
from urllib.request import Request, urlopen

SITEMAP = "https://themes.shopify.com/sitemap_theme_en.xml"
UA = "theme-research/1.0 (+contact: you@example.com)"

# /themes/<handle> — one path segment only, so style/preview URLs are skipped.
THEME_RE = re.compile(r"^/themes/([a-z0-9][a-z0-9\-]{1,60})$")
SKIP = {"all", "free", "paid", "new", "popular", "trending", "collections", "compare"}


def fetch(url: str) -> str:
    req = Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urlopen(req, timeout=30) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
    return raw.decode("utf-8", "replace")


def locs(xml: str) -> list[str]:
    """All <loc> values, ignoring XML namespaces."""
    root = ET.fromstring(xml)
    return [
        el.text.strip()
        for el in root.iter()
        if el.tag.rsplit("}", 1)[-1] == "loc" and el.text
    ]


def collect(url: str, seen: set[str] | None = None) -> list[dict]:
    """Read a sitemap; follow it if it turns out to be a sitemap index."""
    seen = seen if seen is not None else set()
    if url in seen or len(seen) > 50:
        return []
    seen.add(url)

    themes: dict[str, dict] = {}
    for loc in locs(fetch(url)):
        if loc.endswith(".xml"):
            for t in collect(loc, seen):
                themes[t["handle"]] = t
            continue
        m = THEME_RE.match(urlparse(loc).path)
        if m and m.group(1) not in SKIP:
            handle = m.group(1)
            themes[handle] = {
                "handle": handle,
                "name": handle.replace("-", " ").title(),
                "url": loc,
            }
    return sorted(themes.values(), key=lambda t: t["handle"])


def main() -> int:
    p = argparse.ArgumentParser(description="Extract Shopify themes from the sitemap.")
    p.add_argument("--url", default=SITEMAP)
    p.add_argument("-o", "--output")
    p.add_argument("--json", action="store_true")
    p.add_argument("--names-only", action="store_true")
    args = p.parse_args()

    try:
        themes = collect(args.url)
    except ET.ParseError as e:
        return err(f"Not valid XML ({e}). Open {args.url} in a browser to check the URL.")
    except Exception as e:
        return err(f"Fetch failed: {e}")

    if not themes:
        return err(f"No themes found in {args.url}. The sitemap may use a different name "
                   f"— check https://themes.shopify.com/robots.txt for the real one.")

    if args.names_only:
        text = "\n".join(t["name"] for t in themes) + "\n"
    elif args.json:
        text = json.dumps(themes, indent=2) + "\n"
    else:
        text = None

    if text is not None:
        if args.output:
            open(args.output, "w", encoding="utf-8").write(text)
        else:
            sys.stdout.write(text)
    else:
        fh = open(args.output, "w", newline="", encoding="utf-8") if args.output else sys.stdout
        w = csv.DictWriter(fh, fieldnames=["handle", "name", "url"])
        w.writeheader()
        w.writerows(themes)
        if args.output:
            fh.close()

    print(f"{len(themes)} themes", file=sys.stderr)
    return 0


def err(msg: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())