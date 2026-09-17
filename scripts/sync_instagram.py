#!/usr/bin/env python3
"""Import recent @calbluefc Instagram posts into data/instagram.json and assets/news/instagram/.

Instagram does not serve post data to anonymous readers, so this runs with credentials a club
maintainer holds and its output is committed:

  # Instagram API with Instagram Login (business/creator account)
  python3 scripts/sync_instagram.py --token "$IG_ACCESS_TOKEN" [--limit 12]

  # A saved API response (for example from the Graph API Explorer)
  python3 scripts/sync_instagram.py --source-file media.json

  # Specific public posts, one URL per line (uses Instagram's public embed page for each post)
  python3 scripts/sync_instagram.py --post-urls posts.txt

Only the caption, permalink, timestamp and one image per post are stored. Nothing else about the
account or its followers is read. Run scripts/build_news.py afterwards to refresh the news feed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "instagram.json"
MEDIA_DIR = ROOT / "assets" / "news" / "instagram"
FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp"
GRAPH_URL = "https://graph.instagram.com/me/media"
USER_AGENT = "CalBlueNewsSync/1.0 (+https://calbluefc.com/)"


def curl(url: str, *extra: str) -> bytes:
    completed = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "60", "--user-agent", USER_AGENT, *extra, url],
        capture_output=True,
        check=True,
    )
    return completed.stdout


def fetch_json(url: str) -> dict:
    return json.loads(curl(url).decode("utf-8"))


def fetch_text(url: str) -> str:
    return curl(url).decode("utf-8", errors="replace")


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(curl(url))


def graph_media(token: str, limit: int, fetch=fetch_json) -> list[dict]:
    """All media pages from the Instagram API with Instagram Login, up to `limit` posts."""
    items: list[dict] = []
    url = f"{GRAPH_URL}?fields={FIELDS}&limit={min(limit, 50)}&access_token={token}"
    while url and len(items) < limit:
        page = fetch(url)
        if "error" in page:
            raise SystemExit(f"sync_instagram: API error {page['error'].get('message', page['error'])}")
        items.extend(page.get("data", []))
        url = page.get("paging", {}).get("next")
    return items[:limit]


def shortcode(url: str) -> str | None:
    match = re.search(r"instagram\.com/(?:p|reel)/([A-Za-z0-9_-]+)", url)
    return match.group(1) if match else None


def parse_embed(code: str, page: str) -> dict | None:
    """Caption, image and time from Instagram's public captioned embed page for one post."""
    image = re.search(r'class="EmbeddedMediaImage"[^>]*src="([^"]+)"', page) or re.search(r'<img[^>]+src="(https://[^"]+)"', page)
    caption_block = re.search(r'class="Caption"[^>]*>(.*?)</div>', page, re.S)
    caption = ""
    if caption_block:
        text = re.sub(r"<br\s*/?>", "\n", caption_block.group(1))
        text = re.sub(r'<a[^>]*class="CaptionUsername"[^>]*>.*?</a>', "", text, flags=re.S)
        text = re.sub(r'<div class="CaptionComments">.*', "", text, flags=re.S)
        caption = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
    when = re.search(r'datetime="([^"]+)"', page)
    if not image:
        return None
    return {
        "id": code,
        "caption": caption,
        "media_type": "IMAGE",
        "media_url": html.unescape(image.group(1)),
        "permalink": f"https://www.instagram.com/p/{code}/",
        "timestamp": when.group(1) if when else "",
    }


def embed_media(urls: list[str], fetch=fetch_text) -> list[dict]:
    items = []
    for line in urls:
        parts = line.split()
        if not parts or parts[0].startswith("#"):
            continue
        code = shortcode(parts[0])
        if not code:
            print(f"sync_instagram: skipping {parts[0]!r} (not a post URL)")
            continue
        parsed = parse_embed(code, fetch(f"https://www.instagram.com/p/{code}/embed/captioned/"))
        if not parsed:
            print(f"sync_instagram: no media found for {code}")
            continue
        if len(parts) > 1 and re.match(r"\d{4}-\d{2}-\d{2}$", parts[1]):
            parsed["timestamp"] = parsed["timestamp"] or f"{parts[1]}T12:00:00+0000"
        items.append(parsed)
    return items


def normalise(media: list[dict], root: Path, fetch_image=download) -> list[dict]:
    """Keep image posts (video thumbnails count), store one JPEG per post under assets/news/instagram/."""
    items = []
    for post in media:
        media_type = post.get("media_type", "IMAGE")
        image_url = post.get("thumbnail_url") if media_type == "VIDEO" else post.get("media_url")
        if not image_url or not post.get("id") or not post.get("permalink"):
            continue
        post_id = re.sub(r"[^A-Za-z0-9_-]", "", str(post["id"]))
        relative = f"assets/news/instagram/{post_id}.jpg"
        target = root / relative
        if not target.exists():
            fetch_image(image_url, target)
        timestamp = post.get("timestamp") or ""
        try:
            when = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc).isoformat()
        except ValueError:
            try:
                when = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
            except ValueError:
                when = ""   # undated posts sort last and are dropped by build_news
        items.append(
            {
                "id": post_id,
                "permalink": post["permalink"],
                "timestamp": when,
                "mediaType": media_type,
                "caption": (post.get("caption") or "").strip(),
                "image": relative,
            }
        )
    items.sort(key=lambda item: item["timestamp"], reverse=True)
    return items


def write(items: list[dict], target: Path = DATA) -> None:
    target.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "account": "calbluefc",
                "note": "Written by scripts/sync_instagram.py. Instagram does not expose posts to anonymous readers, so this file is refreshed by a maintainer with API access and committed.",
                "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "items": items,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--token", help="Instagram API access token for the club account")
    source.add_argument("--source-file", help="saved API media response (JSON with a data list)")
    source.add_argument("--post-urls", help="text file with one public post URL per line (optional date after it)")
    parser.add_argument("--limit", type=int, default=12)
    args = parser.parse_args()
    if args.token:
        media = graph_media(args.token, args.limit)
    elif args.source_file:
        media = json.loads(Path(args.source_file).read_text(encoding="utf-8")).get("data", [])[: args.limit]
    else:
        media = embed_media(Path(args.post_urls).read_text(encoding="utf-8").splitlines())[: args.limit]
    items = normalise(media, ROOT)
    write(items)
    print(f"sync_instagram: {len(items)} posts written to data/instagram.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
