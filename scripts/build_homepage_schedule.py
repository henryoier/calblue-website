#!/usr/bin/env python3
"""Render the homepage's initial match center and poster from the schedule snapshots.

Run after schedule syncs: python3 scripts/build_homepage_schedule.py
The browser can still refresh/expand these sections. HTML-only readers also see
the current fixture instead of an old hardcoded match-day poster.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime
from html import escape
import json
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
PACIFIC = ZoneInfo("America/Los_Angeles")
CLUB_CREST = "assets/calblue-logo-web.jpg"


def text(value) -> str:
    return escape(str(value or ""), quote=True)


def is_calblue(name: str) -> bool:
    return re.sub(r"[^a-z0-9]", "", name.lower()) in {"calblue", "calbluefc"}


def https_url(value) -> str | None:
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        return None
    try:
        parsed = urlsplit(value)
        return value if (parsed.scheme == "https" and parsed.netloc
                         and parsed.username is None and parsed.password is None) else None
    except ValueError:
        return None


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name}: expected a JSON object")
    return value


def upcoming_fixtures(feeds: dict[str, dict], today: date) -> list[dict]:
    fixtures = []
    for feed in feeds.values():
        entries = feed.get("fixtures")
        if not isinstance(entries, list):
            raise ValueError("Schedule snapshot must contain a fixtures list")
        for fixture in entries:
            if not isinstance(fixture, dict):
                continue
            try:
                fixture_date = date.fromisoformat(fixture.get("date", ""))
            except (TypeError, ValueError):
                continue
            if fixture_date < today or fixture.get("status") in {"completed", "cancelled"}:
                continue
            if not all(isinstance(fixture.get(side), dict)
                       and isinstance(fixture[side].get("name"), str)
                       and fixture[side]["name"].strip() for side in ("home", "away", "venue")):
                continue
            if not any(is_calblue(fixture[side]["name"]) for side in ("home", "away")):
                continue
            fixtures.append(fixture)
    # Keep the same ordering as the browser, including end-of-day placement for TBA.
    fixtures.sort(key=lambda fixture: fixture.get("startsAt") or fixture["date"] + "T23:59:59")
    return fixtures


def kind(fixture: dict) -> str:
    competition = str(fixture.get("competition") or "").lower()
    return "cup" if "abronzino" in competition else "nccsf" if "nccsf" in competition else "swpl"


def destination(fixture: dict) -> tuple[str, str]:
    return ("competition-nccsf.html", "NCCSF") if kind(fixture) == "nccsf" else ("competition-swpl.html", "SWPL")


def format_date(fixture: dict, pattern: str) -> str:
    return date.fromisoformat(fixture["date"]).strftime(pattern)


def opponent(fixture: dict) -> dict:
    return fixture["away"] if is_calblue(fixture["home"]["name"]) else fixture["home"]


def kickoff(fixture: dict) -> str:
    return str(fixture.get("timeLabel") or "TBA")


def countdown(fixture: dict, today: date, poster: bool = False) -> str:
    days = (date.fromisoformat(fixture["date"]) - today).days
    return "Match day" if days == 0 else "Tomorrow" if days == 1 else (
        f"{days} days to kickoff" if poster else f"In {days} days")


def crest(team: dict, side: str | None = None) -> str:
    name = team["name"]
    logo = CLUB_CREST if side and is_calblue(name) else https_url(team.get("logo"))
    placeholder = "?" if re.search(r"tba|unknown|undecided", name, re.I) else name[0].upper()
    if side:
        image = f'<img data-team-crest src="{text(logo)}" alt="{text(name)} crest" width="90" height="90" />' if logo else '<img data-team-crest alt="" width="90" height="90" hidden />'
        return image + f'<div class="crest-placeholder" data-team-placeholder{" hidden" if logo else ""} aria-hidden="true">{text(placeholder)}</div>'
    image = f'<img src="{text(logo)}" alt="{text(name)} crest" loading="lazy" />' if logo else text(placeholder)
    return f'<span class="fixture-row-crest">{image}</span>'


def team_side(team: dict, side: str) -> str:
    classes = "club-side" + (" opponent" if not is_calblue(team["name"]) else "")
    return f'''              <div class="{classes}" data-team-{side} data-side="{side}">
                {crest(team, side)}
                <span class="team-role" data-team-role>{side.title()}</span>
                <strong data-team-name>{text(team["name"])}</strong>
              </div>'''


def fixture_row(fixture: dict) -> str:
    event = fixture.get("eventOnly")
    summary = f'Abronzino Cup · {fixture.get("round") or "Fixture TBA"}' if event else (
        f'{"Home" if is_calblue(fixture["home"]["name"]) else "Away"} vs {opponent(fixture)["name"]}')
    href, label = destination(fixture)
    metadata = " · ".join(str(part) for part in (
        fixture.get("competition") or "CalBlue fixture", fixture.get("round"),
        kickoff(fixture), fixture["venue"]["name"], "View schedule →") if part)
    return f'''              <li class="is-{kind(fixture)}"><time datetime="{text(fixture.get("startsAt") or fixture["date"])}">{text(format_date(fixture, "%b %-d"))}</time><a class="fixture-row-link" href="{href}" aria-label="{text(summary)} — view {label} schedule">{crest(opponent(fixture))}<div><strong>{text(summary)}</strong><span>{text(metadata)}</span></div></a></li>'''


def render_schedule(fixtures: list[dict], today: date) -> str:
    if fixtures:
        fixture = fixtures[0]
        href, label = destination(fixture)
        card = f'''          <div class="match-card is-{kind(fixture)}" data-next-match data-schedule-as-of="{today.isoformat()}" aria-live="polite">
            <div class="match-meta">
              <em class="next-match-countdown" data-match-countdown>{countdown(fixture, today)}</em>
              <span data-match-competition>{text(fixture.get("competition") or "CalBlue fixture")}</span>
              <strong><time data-match-date datetime="{text(fixture.get("startsAt") or fixture["date"])}">{text(format_date(fixture, "%A, %B %-d"))}</time></strong>
              <small data-match-venue>{text(fixture["venue"]["name"])}</small>
            </div>
            <div class="matchup">
{team_side(fixture["home"], "home")}
              <div class="versus"><span>VS</span><small data-match-time>{text(kickoff(fixture))}</small></div>
{team_side(fixture["away"], "away")}
            </div>
            <a class="button button-dark" data-match-link href="{href}">View {label} schedule →</a>
          </div>'''
    else:
        card = f'''          <div class="match-card match-card-empty" data-next-match data-schedule-as-of="{today.isoformat()}" aria-live="polite">
            <div class="match-meta"><em class="next-match-countdown" data-match-countdown>Awaiting fixtures</em><span data-match-competition>CalBlue fixtures</span><strong><time data-match-date>Schedule pending</time></strong><small data-match-venue>No upcoming CalBlue fixture is published yet</small></div>
            <div class="matchup">
{team_side({"name": "CalBlue FC"}, "home")}
              <div class="versus"><span>VS</span><small data-match-time>TBA</small></div>
{team_side({"name": "Opponent TBA"}, "away")}
            </div>
            <a class="button button-dark" data-match-link href="competition-swpl.html">Check official schedule →</a>
          </div>'''
    rows = "\n".join(fixture_row(fixture) for fixture in fixtures[1:5])
    return card + f'''

          <div class="upcoming-fixtures" data-upcoming-fixtures{" hidden" if len(fixtures) < 2 else ""}>
            <div><span>On deck</span><h3>Upcoming matches</h3><button class="fixture-list-toggle" type="button" data-fixture-toggle aria-expanded="false" hidden>View all</button></div>
            <ol data-fixture-list>
{rows}
            </ol>
          </div>'''


def poster_for(root: Path, fixture: dict, manifest: dict) -> dict | None:
    if fixture.get("eventOnly"):
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", opponent(fixture)["name"].lower()).strip("-")
    entries = manifest.get("fixtures")
    if not isinstance(entries, dict):
        return None
    entry = entries.get(f'{fixture["date"]}-{slug}')
    if not isinstance(entry, dict) or not isinstance(entry.get("posters"), list):
        return None
    for poster in entry["posters"]:
        if not isinstance(poster, dict) or not isinstance(poster.get("src"), str):
            continue
        source = poster["src"]
        path = PurePosixPath(source)
        if (not source.startswith("assets/matchday/") or path.suffix != ".webp"
                or ".." in path.parts or "\\" in source or "?" in source or "#" in source
                or not (root / path).is_file()):
            continue
        return poster
    return None


def render_poster(root: Path, fixtures: list[dict], manifest: dict, today: date) -> str:
    selected = None
    for candidate in fixtures:
        candidate_poster = poster_for(root, candidate, manifest)
        if candidate_poster:
            selected = candidate, candidate_poster
            break
    # Keep every browser hook even without an initial poster: a later successful
    # fetch can reveal it without trying to update missing DOM elements.
    fixture, poster = selected if selected else ({
        "date": today.isoformat(), "home": {"name": "CalBlue FC"},
        "away": {"name": "Opponent TBA"}, "venue": {"name": "Venue TBA"},
    }, {})
    home = is_calblue(fixture["home"]["name"])
    host, guest = ("CalBlue FC", opponent(fixture)["name"]) if home else (opponent(fixture)["name"], "CalBlue FC")
    kickoff_label = kickoff(fixture)
    kickoff_label = "Kickoff TBA" if "tba" in kickoff_label.lower() else kickoff_label
    alt = f'Match-day poster for {host} versus {guest} on {format_date(fixture, "%A, %B %-d, %Y")}, {kickoff_label}, {fixture["venue"]["name"]}' if selected else ""
    source = poster.get("src") or "#schedule"
    image_source = f' src="{text(source)}"' if selected else ""
    date_label = format_date(fixture, "%A, %B %-d") if selected else "Schedule pending"
    return f'''      <section class="matchday-poster section" id="matchday" data-matchday-poster data-poster-style="{text(poster.get("style"))}" aria-labelledby="matchday-poster-title"{" hidden" if not selected else ""}>
        <div class="shell matchday-poster-grid">
          <figure class="matchday-poster-art"><a data-poster-link href="{text(source)}" target="_blank" rel="noopener" aria-label="Open the full-size CalBlue match-day poster"><img data-poster-image{image_source} alt="{text(alt)}" width="1296" height="1616" loading="lazy" decoding="async" /></a></figure>
          <div class="matchday-poster-copy">
            <p class="section-tag light" data-poster-competition>{text(fixture.get("competition") or "CalBlue fixture")}</p>
            <span class="poster-countdown" data-matchday-countdown>{countdown(fixture, today, poster=True) if selected else "Awaiting fixtures"}</span>
            <h2 id="matchday-poster-title">Match<br />day.</h2>
            <p class="poster-matchup" data-poster-matchup>{text(host)} <span>vs</span> {text(guest)}</p>
            <dl class="poster-details"><div><dt>Date</dt><dd data-poster-date>{text(date_label)}</dd></div><div><dt>Kickoff</dt><dd data-poster-kickoff>{text(kickoff_label)}</dd></div><div><dt>Venue</dt><dd data-poster-venue>{text(fixture["venue"]["name"])}</dd></div></dl>
            <p data-poster-note>{"Home match. Save the poster, share it, and come loud." if home else "Away day. Save the poster, share it, and travel loud."}</p>
            <div class="poster-actions"><a class="button" href="#schedule">View match center</a><a class="text-link" data-poster-link href="{text(source)}" target="_blank" rel="noopener">Open full poster <span aria-hidden="true">↗</span></a></div>
          </div>
        </div>
      </section>'''


def replace_region(source: str, name: str, content: str) -> str:
    start, end = f"<!-- {name}:start -->", f"<!-- {name}:end -->"
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f"index.html: expected one {name} marker pair")
    pattern = re.compile(rf"(^[ \t]*{re.escape(start)}\n).*?(^[ \t]*{re.escape(end)})", re.M | re.S)
    result, count = pattern.subn(lambda match: match[1] + content + "\n" + match[2], source)
    if count != 1:
        raise ValueError(f"index.html: invalid {name} marker order")
    return result


def build(root: Path, today: date) -> str:
    feeds = {name: load_json(root / "data" / f"{name}.json") for name in ("swpl", "nccsf")}
    fixtures = upcoming_fixtures(feeds, today)
    source = (root / "index.html").read_text(encoding="utf-8")
    source = replace_region(source, "homepage-poster", render_poster(
        root, fixtures, load_json(root / "data" / "matchday-posters.json"), today))
    source = replace_region(source, "homepage-schedule", render_schedule(fixtures, today))
    source = re.sub(r'(<b data-swpl-status-text>)[^<]*(</b>)',
                    lambda match: match[1] + "Official SWPL + NCCSF schedules" + match[2], source)
    checked = []
    for feed in feeds.values():
        try:
            stamp = datetime.fromisoformat(feed.get("checkedAt", ""))
            if stamp.tzinfo is not None:
                checked.append(stamp.astimezone(PACIFIC))
        except (TypeError, ValueError):
            pass
    checked_label = "Schedules checked " + min(checked).strftime("%b %-d, %-I:%M %p %Z") if checked else (
        "Use the official schedules for the latest update.")
    return re.sub(r'(<span data-swpl-checked>)[^<]*(</span>)',
                  lambda match: match[1] + text(checked_label) + match[2], source)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--today", type=date.fromisoformat,
                        help="date used to select future fixtures (Pacific)")
    parser.add_argument("--check", action="store_true", help="verify the marked HTML matches the snapshots")
    args = parser.parse_args(argv)
    try:
        rendered = build(args.root, args.today or datetime.now(PACIFIC).date())
        target = args.root / "index.html"
        if args.check:
            if target.read_text(encoding="utf-8") != rendered:
                print("build_homepage_schedule: homepage match details are stale")
                return 1
            print("build_homepage_schedule: homepage match details are current")
        else:
            target.write_text(rendered, encoding="utf-8")
            print("build_homepage_schedule: refreshed homepage match details")
        return 0
    except (OSError, ValueError, TypeError) as error:
        print(f"build_homepage_schedule: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
