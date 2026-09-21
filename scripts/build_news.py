#!/usr/bin/env python3
"""Build data/news.json: the club's "Latest" feed, merged from sources that already live in this repository.

Sources (newest first in the output):
  - data/news-posts.json      hand-written club posts (title, summary, body paragraphs, image)
  - data/swpl.json, data/nccsf.json   published wins and draws -> "Result" cards (losses are not announced)
  - gallery.html              match albums -> "Gallery" cards
  - data/matchday-posters.json + fixtures   next fixture with artwork -> one "Match day" preview card
  - data/instagram.json       posts imported by scripts/sync_instagram.py -> "Instagram" cards
  - data/roster-history.json  players who joined a league roster after the season squad -> "Squad" cards

Run: python3 scripts/build_news.py [--today YYYY-MM-DD] [--check]
"""

from __future__ import annotations

import argparse
from datetime import date, datetime
import json
from pathlib import Path
import re
import sys
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
PACIFIC = ZoneInfo("America/Los_Angeles")
CLUB_CREST = "assets/calblue-logo-web.jpg"
DEFAULT_IMAGE = ""   # no borrowed photos: cards without their own image get a generated tile in news.js
CATEGORY_ORDER = {"Club": 0, "Match day": 1, "Result": 2, "Squad": 3, "Gallery": 4, "Instagram": 5}
LEAGUE_LABEL = {"swpl": "SWPL Pacific Premier League", "nccsf": "NCCSF Fall League"}
LEAGUE_PAGE = {"swpl": "competition-swpl.html#roster", "nccsf": "competition-nccsf.html#roster"}
LEAGUE_ORDER = {"swpl": 0, "nccsf": 1}   # SWPL first when cards share a day


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def load_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def is_calblue(name: str) -> bool:
    return name.strip().lower().replace(" ", "").startswith("calblue")


def competition_label(feed_name: str, fixture: dict) -> str:
    raw = str(fixture.get("competition") or "")
    if feed_name == "swpl":
        if "cup" in raw.lower():
            return "Abronzino Cup"
        return "SWPL Pacific Premier League"
    return raw or "NCCSF"


def parse_gallery(html: str) -> list[dict]:
    """Album cards from gallery.html, with the competition heading of the section they sit in."""
    albums: list[dict] = []
    for section in re.finditer(r'<section class="gallery-category"(.*?)</section>', html, re.S):
        block = section.group(1)
        heading = re.search(r'<h3 id="[^"]*">(.*?)</h3>', block, re.S)
        competition = re.sub(r"<[^>]+>", "", heading.group(1)).strip() if heading else ""
        for card in re.finditer(
            r'<a class="album-card" href="([^"]+)">\s*<img src="([^"]+)" alt="([^"]*)"[^>]*>\s*'
            r'<div class="album-card-copy"><span>([^<]*)</span><h3>([^<]*)</h3>'
            r'<span class="album-card-meta"><span>([^<]*)</span>',
            block,
            re.S,
        ):
            href, image, alt, date_note, title, count = card.groups()
            date_text, _, note = date_note.partition(" • ")
            try:
                iso = datetime.strptime(date_text.strip(), "%B %d, %Y").date().isoformat()
            except ValueError:
                continue
            albums.append(
                {
                    "href": href,
                    "image": image,
                    "alt": alt,
                    "date": iso,
                    "note": note.strip(),
                    "title": title.strip(),
                    "count": count.strip(),
                    "competition": competition,
                    "opponent": title.split(" vs ", 1)[1].strip() if " vs " in title else "",
                }
            )
    return albums


def gallery_items(albums: list[dict]) -> list[dict]:
    items = []
    for album in albums:
        slug = "gallery-" + slugify(f"{album['date']}-{album['opponent'] or album['title']}")
        items.append(
            {
                "id": slug,
                "slug": slug,
                "category": "Gallery",
                "date": album["date"],
                "title": f"Photos: {album['title']}",
                "summary": " · ".join(part for part in (album["count"], album["competition"], album["note"]) if part),
                "image": album["image"],
                "imageAlt": album["alt"] or album["title"],
                "href": album["href"],
                "cta": "Open the album",
            }
        )
    return items


def result_items(feeds: dict[str, dict | None], albums: list[dict]) -> list[dict]:
    items = []
    for feed_name, data in feeds.items():
        if not data:
            continue
        for result in data.get("results", []) or []:
            score = result.get("score") or {}
            if score.get("home") is None or score.get("away") is None:
                continue
            home = result["home"]["name"]
            away = result["away"]["name"]
            calblue_home = is_calblue(home)
            opponent = away if calblue_home else home
            scored = score["home"] if calblue_home else score["away"]
            conceded = score["away"] if calblue_home else score["home"]
            outcome = "Win" if scored > conceded else "Draw" if scored == conceded else "Loss"
            if outcome == "Loss":
                continue   # club decision: losses are not announced in the news feed (they stay on the competition pages)
            album = next(
                (a for a in albums if a["date"] == result["date"] and slugify(a["opponent"]) and slugify(a["opponent"]) in slugify(opponent)),
                None,
            )
            competition = competition_label(feed_name, result)
            slug = "result-" + slugify(f"{result['date']}-{opponent}")
            items.append(
                {
                    "id": slug,
                    "slug": slug,
                    "category": "Result",
                    "outcome": outcome,
                    "date": result["date"],
                    "title": f"CalBlue {scored}-{conceded} {opponent}",
                    "summary": " · ".join(
                        [outcome, "Home" if calblue_home else "Away", competition, str(result.get("venue", {}).get("name") or "")]
                    ).rstrip(" ·"),
                    "image": album["image"] if album else "",
                    "imageAlt": album["alt"] if album else f"CalBlue FC against {opponent}",
                    "scoreline": {
                        "home": {"name": home, "logo": CLUB_CREST if calblue_home else (result["home"].get("logo") or "")},
                        "away": {"name": away, "logo": CLUB_CREST if not calblue_home else (result["away"].get("logo") or "")},
                        "score": {"home": score["home"], "away": score["away"]},
                    },
                    "href": album["href"] if album else ("competition-nccsf.html" if feed_name == "nccsf" else "competition-swpl.html"),
                    "cta": "See the photos" if album else "Full results and table",
                }
            )
    return items


def preview_item(manifest: dict | None, feeds: dict[str, dict | None], today: date) -> list[dict]:
    if not manifest or not manifest.get("fixtures"):
        return []
    swpl = feeds.get("swpl") or {}
    upcoming = sorted(
        (f for f in swpl.get("fixtures", []) if f.get("date") and f["date"] >= today.isoformat()),
        key=lambda f: (f["date"], f.get("startsAt") or ""),
    )
    for fixture in upcoming:
        opponent = fixture["away"]["name"] if is_calblue(fixture["home"]["name"]) else fixture["home"]["name"]
        entry = manifest["fixtures"].get(f"{fixture['date']}-{slugify(opponent)}")
        if not entry or not entry.get("posters"):
            continue
        calblue_home = is_calblue(fixture["home"]["name"])
        when = datetime.fromisoformat(fixture["date"] + "T12:00:00")
        kickoff = fixture.get("timeLabel") or ""
        kickoff = "Kickoff TBA" if not kickoff or "tba" in kickoff.lower() else kickoff
        storylines = entry.get("storylines") or []
        summary = " · ".join(
            [when.strftime("%A, %B %-d"), kickoff, fixture.get("venue", {}).get("name") or ""] + storylines
        ).rstrip(" ·")
        slug = "matchday-" + slugify(f"{fixture['date']}-{opponent}")
        return [
            {
                "id": slug,
                "slug": slug,
                "category": "Match day",
                "date": fixture["date"],
                "title": f"Match day: {'CalBlue FC vs ' + opponent if calblue_home else opponent + ' vs CalBlue FC'}",
                "summary": summary,
                "image": entry["posters"][0]["src"],
                "imageAlt": f"Match-day poster: CalBlue FC vs {opponent}",
                "href": "index.html#matchday",
                "cta": "See the poster",
                "poster": True,
            }
        ]
    return []


def instagram_items(data: dict | None) -> list[dict]:
    items = []
    for post in (data or {}).get("items", []) or []:
        caption = (post.get("caption") or "").strip()
        first, _, rest = caption.partition("\n")
        title = first.strip() or "On Instagram"
        if len(title) > 90:
            title = title[:87].rsplit(" ", 1)[0] + "…"
        slug = "instagram-" + slugify(str(post.get("id") or post.get("permalink") or title))
        items.append(
            {
                "id": slug,
                "slug": slug,
                "category": "Instagram",
                "date": str(post.get("timestamp") or "")[:10],
                "title": title,
                "summary": rest.strip().replace("\n", " ")[:180],
                "image": post.get("image") or "",
                "imageAlt": f"Instagram post by @calbluefc: {title}",
                "href": post.get("permalink") or "https://www.instagram.com/calbluefc/",
                "external": True,
                "cta": "View on Instagram",
            }
        )
    return [item for item in items if re.match(r"\d{4}-\d{2}-\d{2}$", item["date"])]


def squad_items(history: dict | None) -> list[dict]:
    """One card per league per day on which new players first appeared on the official roster."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for entry in ((history or {}).get("players") or {}).values():
        if entry.get("seeded") or not entry.get("firstSeen"):
            continue
        groups.setdefault((entry["league"], entry["firstSeen"]), []).append(entry)
    items = []
    for (league, day), players in sorted(groups.items(), key=lambda item: (item[0][1], LEAGUE_ORDER.get(item[0][0], 9), item[0][0])):
        players.sort(key=lambda p: p["name"])
        names = [p["name"] for p in players]
        label = LEAGUE_LABEL.get(league, league.upper())
        slug = "squad-" + slugify(f"{day}-{league}")
        listed = ", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1] if names else ""
        items.append(
            {
                "id": slug,
                "slug": slug,
                "category": "Squad",
                "date": day,
                "title": f"{len(names)} new {'face' if len(names) == 1 else 'faces'} on the {label.split()[0]} roster",
                "summary": f"Welcome {listed}, now registered for the {label}.",
                "image": next((p["photo"] for p in players if p.get("photo")), ""),
                "imageAlt": f"{names[0]}, newly registered with CalBlue FC" if names else "CalBlue FC",
                "href": LEAGUE_PAGE.get(league, "players.html"),
                "cta": "Meet the squad",
                "players": [{"name": p["name"], "photo": p.get("photo") or CLUB_CREST, "profile": p.get("profile") or ""} for p in players],
            }
        )
    return items


def post_items(data: dict | None) -> list[dict]:
    items = []
    for post in (data or {}).get("posts", []) or []:
        slug = post.get("slug") or slugify(f"{post['date']}-{post['title']}")
        items.append(
            {
                "id": "post-" + slug,
                "slug": slug,
                "category": post.get("category") or "Club",
                "date": post["date"],
                "title": post["title"],
                "summary": post.get("summary") or "",
                "image": post.get("image") or "",
                "imageAlt": post.get("imageAlt") or post["title"],
                "href": f"news.html?post={slug}",
                "cta": "Read more",
                "body": post.get("body") or [],
                "author": post.get("author") or "",
            }
        )
    return items


def build(root: Path, today: date) -> dict:
    feeds = {"swpl": load_json(root / "data" / "swpl.json"), "nccsf": load_json(root / "data" / "nccsf.json")}
    albums = parse_gallery((root / "gallery.html").read_text(encoding="utf-8")) if (root / "gallery.html").exists() else []
    items = (
        post_items(load_json(root / "data" / "news-posts.json"))
        + preview_item(load_json(root / "data" / "matchday-posters.json"), feeds, today)
        + result_items(feeds, albums)
        + squad_items(load_json(root / "data" / "roster-history.json"))
        + gallery_items(albums)
        + instagram_items(load_json(root / "data" / "instagram.json"))
    )
    seen: set[str] = set()
    unique = []
    for item in items:
        if item["slug"] in seen:
            raise SystemExit(f"build_news: duplicate slug {item['slug']}")
        seen.add(item["slug"])
        unique.append(item)
    unique.sort(key=lambda item: (item["date"], -CATEGORY_ORDER.get(item["category"], 9)), reverse=True)
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now(PACIFIC).isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "items": unique,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--today", help="override today's date (YYYY-MM-DD, Pacific)")
    parser.add_argument("--check", action="store_true", help="fail if data/news.json items differ from a fresh build")
    parser.add_argument("--root", default=str(ROOT))
    args = parser.parse_args()
    root = Path(args.root)
    today = date.fromisoformat(args.today) if args.today else datetime.now(PACIFIC).date()
    feed = build(root, today)
    target = root / "data" / "news.json"
    if args.check:
        current = load_json(target) or {}
        if current.get("items") != feed["items"]:
            print("build_news: data/news.json is stale; run python3 scripts/build_news.py")
            return 1
        print(f"build_news: data/news.json is current ({len(feed['items'])} items)")
        return 0
    target.write_text(json.dumps(feed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    by_category: dict[str, int] = {}
    for item in feed["items"]:
        by_category[item["category"]] = by_category.get(item["category"], 0) + 1
    print(f"build_news: wrote {len(feed['items'])} items to data/news.json {by_category}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
