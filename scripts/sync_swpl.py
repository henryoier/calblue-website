#!/usr/bin/env python3
"""Build the public CalBlue schedule snapshot from the official SWPL page."""

from __future__ import annotations

import argparse
from datetime import date, datetime
from hashlib import sha256
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


SOURCE_URL = "https://pacific.swplsoccer.com/teams/calblue-fc"
PACIFIC = ZoneInfo("America/Los_Angeles")
MAX_RESPONSE_BYTES = 5_000_000
VOID_ELEMENTS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "source",
    "track",
    "wbr",
}


def clean_text(value: str) -> str:
    return " ".join(value.split())


def absolute_https_url(value: str | None) -> str | None:
    if not value:
        return None
    absolute = urljoin(SOURCE_URL, value)
    parsed = urlparse(absolute)
    if parsed.scheme not in {"http", "https"}:
        return None
    return parsed._replace(scheme="https").geturl()


class SWPLTeamParser(HTMLParser):
    """Parse only the stable, public fields used by the CalBlue site."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.team_name = ""
        self.team_meta = ""
        self.team_logo: str | None = None
        self.schedule_found = False
        self.rows: list[dict[str, object]] = []

        self._capture: str | None = None
        self._capture_depth = 0
        self._capture_text: list[str] = []
        self._logo_depth = 0
        self._in_schedule = False
        self._table_depth = 0
        self._row: dict[str, object] | None = None
        self._cell: dict[str, object] | None = None

    @staticmethod
    def _attrs(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {key: value or "" for key, value in attrs}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = self._attrs(attrs)
        classes = set(values.get("class", "").split())

        if self._capture and tag not in VOID_ELEMENTS:
            self._capture_depth += 1
        elif tag == "div" and "teamPageName" in classes:
            self._capture = "team_name"
            self._capture_depth = 1
            self._capture_text = []
        elif tag == "div" and "teamPageConference" in classes:
            self._capture = "team_meta"
            self._capture_depth = 1
            self._capture_text = []

        if self._logo_depth:
            if tag not in VOID_ELEMENTS:
                self._logo_depth += 1
            if tag == "img" and not self.team_logo:
                self.team_logo = absolute_https_url(values.get("src"))
        elif tag == "div" and "teamPageLogo" in classes:
            self._logo_depth = 1

        if tag == "table" and values.get("id") == "scheduleTable":
            self.schedule_found = True
            self._in_schedule = True
            self._table_depth = 1
            return
        if self._in_schedule and tag == "table":
            self._table_depth += 1

        if not self._in_schedule:
            return
        if tag == "tr":
            self._row = {"classes": classes, "cells": []}
        elif tag == "td" and self._row is not None:
            self._cell = {"classes": classes, "text": [], "links": [], "logos": []}
        elif tag == "a" and self._cell is not None:
            href = absolute_https_url(values.get("href"))
            if href:
                self._cell["links"].append(href)
        elif tag == "div" and self._cell is not None:
            style = values.get("style", "")
            match = re.search(r"background-image\s*:\s*url\(['\"]?([^)'\"]+)", style, re.I)
            if match:
                logo = absolute_https_url(match.group(1))
                if logo:
                    self._cell["logos"].append(logo)

    def handle_endtag(self, tag: str) -> None:
        if self._capture:
            self._capture_depth -= 1
            if self._capture_depth == 0:
                value = clean_text("".join(self._capture_text))
                setattr(self, self._capture, value)
                self._capture = None
                self._capture_text = []

        if self._logo_depth:
            self._logo_depth -= 1

        if not self._in_schedule:
            return
        if tag == "td" and self._cell is not None and self._row is not None:
            self._cell["text"] = clean_text("".join(self._cell["text"]))
            self._row["cells"].append(self._cell)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None
        elif tag == "table":
            self._table_depth -= 1
            if self._table_depth == 0:
                self._in_schedule = False

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._capture_text.append(data)
        if self._cell is not None:
            self._cell["text"].append(data)


def is_calblue(name: str) -> bool:
    return re.sub(r"[^a-z0-9]", "", name.lower()) in {"calblue", "calbluefc"}


def parse_start(date_label: str, time_label: str) -> tuple[str, str | None]:
    game_date = datetime.strptime(clean_text(date_label), "%a %m/%d/%Y").date()
    time_match = re.search(r"(\d{1,2}:\d{2}\s*[ap]m)", time_label, re.I)
    if not time_match:
        return game_date.isoformat(), None
    local = datetime.strptime(
        f"{game_date.isoformat()} {time_match.group(1).upper()}", "%Y-%m-%d %I:%M %p"
    ).replace(tzinfo=PACIFIC)
    return game_date.isoformat(), local.isoformat()


def team_from_cell(cell: dict[str, object]) -> dict[str, str | None]:
    text = str(cell.get("text", ""))
    links = cell.get("links", [])
    logos = cell.get("logos", [])
    return {
        "name": text,
        "url": links[0] if links else None,
        "logo": logos[0] if logos else None,
    }


def parse_fixtures(parser: SWPLTeamParser, today: date) -> tuple[list[dict[str, object]], int]:
    current_date = ""
    fixtures: list[dict[str, object]] = []
    ignored_rows = 0

    for row in parser.rows:
        classes = row["classes"]
        cells = row["cells"]
        if "dayRow" in classes and cells:
            current_date = str(cells[0]["text"])
            continue
        if "dataRow" not in classes or len(cells) < 7 or not current_date:
            continue

        home = team_from_cell(cells[2])
        away = team_from_cell(cells[4])
        if not (is_calblue(str(home["name"])) or is_calblue(str(away["name"]))):
            ignored_rows += 1
            continue

        game_date, starts_at = parse_start(current_date, str(cells[0]["text"]))
        result = clean_text(str(cells[3]["text"]))
        status = "completed" if re.search(r"\d\s*-\s*\d", result) else "scheduled"
        if date.fromisoformat(game_date) < today or status == "completed":
            continue

        venue_links = cells[5].get("links", [])
        source = "|".join(
            [game_date, str(cells[0]["text"]), str(home["name"]), str(away["name"])]
        )
        fixtures.append(
            {
                "id": sha256(source.encode("utf-8")).hexdigest()[:16],
                "date": game_date,
                "startsAt": starts_at,
                "timeLabel": clean_text(str(cells[0]["text"])) or "Time TBA",
                "competition": clean_text(str(cells[1]["text"])) or "SWPL",
                "home": home,
                "away": away,
                "venue": {
                    "name": clean_text(str(cells[5]["text"])) or "Venue TBA",
                    "mapUrl": venue_links[0] if venue_links else None,
                },
                "conference": clean_text(str(cells[6]["text"])),
                "sourceUrl": SOURCE_URL,
                "status": status,
            }
        )

    fixtures.sort(key=lambda fixture: (fixture["date"], fixture["startsAt"] or ""))
    return fixtures, ignored_rows


def fixture_key(fixture: dict[str, object]) -> tuple[str, tuple[str, str]]:
    teams = tuple(
        sorted(
            re.sub(r"[^a-z0-9]", "", str(fixture[side]["name"]).lower())
            for side in ("home", "away")
        )
    )
    return str(fixture["date"]), teams


def matchup_key(fixture: dict[str, object]) -> tuple[str, str]:
    return tuple(
        sorted(
            re.sub(r"[^a-z0-9]", "", str(fixture[side]["name"]).lower())
            for side in ("home", "away")
        )
    )


def merge_overrides(
    fixtures: list[dict[str, object]], overrides: list[dict[str, object]], today: date
) -> list[dict[str, object]]:
    merged = list(fixtures)
    existing = {fixture_key(fixture) for fixture in fixtures}
    official_matchups = {matchup_key(fixture) for fixture in fixtures}
    for override in overrides:
        if not isinstance(override, dict):
            raise ValueError("SWPL override fixtures must be JSON objects")
        try:
            game_date = date.fromisoformat(str(override["date"]))
            home_name = str(override["home"]["name"])
            away_name = str(override["away"]["name"])
            venue_name = str(override["venue"]["name"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("SWPL override fixture is missing a valid date, teams, or venue") from error
        if not (is_calblue(home_name) or is_calblue(away_name)):
            raise ValueError("SWPL override fixture does not involve CalBlue FC")
        if not venue_name:
            raise ValueError("SWPL override fixture venue cannot be empty")
        if game_date < today:
            continue
        if override.get("eventOnly"):
            official_cup_on_date = any(
                str(fixture["date"]) == str(override["date"])
                and "abronzino" in str(fixture.get("competition", "")).lower()
                for fixture in fixtures
            )
            if official_cup_on_date:
                continue
        elif matchup_key(override) in official_matchups:
            continue
        key = fixture_key(override)
        if key not in existing:
            merged.append(override)
            existing.add(key)
    merged.sort(key=lambda fixture: (fixture["date"], fixture.get("startsAt") or ""))
    return merged


def build_snapshot(
    html: str,
    checked_at: datetime,
    overrides: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    parser = SWPLTeamParser()
    parser.feed(html)
    if not is_calblue(parser.team_name):
        raise ValueError("SWPL page did not identify CalBlue FC; refusing to publish unknown data")
    if not parser.schedule_found:
        raise ValueError("SWPL schedule table was not found; the upstream page may have changed")

    checked_at = checked_at.astimezone(PACIFIC)
    fixtures, ignored_rows = parse_fixtures(parser, checked_at.date())
    fixtures = merge_overrides(fixtures, overrides or [], checked_at.date())
    meta_parts = [part.strip() for part in parser.team_meta.split("-") if part.strip()]
    return {
        "schemaVersion": 1,
        "source": SOURCE_URL,
        "checkedAt": checked_at.isoformat(timespec="seconds"),
        "team": {
            "name": parser.team_name,
            "competition": meta_parts[0] if meta_parts else "SWPL Pacific",
            "location": " - ".join(meta_parts[1:]) if len(meta_parts) > 1 else "",
            "logo": parser.team_logo,
        },
        "fixtures": fixtures,
        "diagnostics": {
            "ignoredNonCalBlueRows": ignored_rows,
            "editorialOverrides": sum(bool(fixture.get("editorial")) for fixture in fixtures),
        },
    }


def fetch_source(url: str) -> str:
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "CalBlueScheduleSync/1.0 (+https://calbluefc.com/)",
        },
    )
    with urlopen(request, timeout=25) as response:
        content = response.read(MAX_RESPONSE_BYTES + 1)
        if len(content) > MAX_RESPONSE_BYTES:
            raise ValueError("SWPL response exceeded the 5 MB safety limit")
        charset = response.headers.get_content_charset() or "utf-8"
    return content.decode(charset, errors="replace")


def write_json(path: Path, snapshot: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-url", default=SOURCE_URL)
    parser.add_argument("--source-file", type=Path)
    parser.add_argument("--overrides", type=Path, default=Path("data/swpl-overrides.json"))
    parser.add_argument("--output", type=Path, default=Path("data/swpl.json"))
    parser.add_argument("--checked-at", help="ISO timestamp used for reproducible tests")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    checked_at = (
        datetime.fromisoformat(args.checked_at)
        if args.checked_at
        else datetime.now(tz=PACIFIC)
    )
    try:
        if args.source_file and str(args.source_file) == "-":
            content = sys.stdin.buffer.read(MAX_RESPONSE_BYTES + 1)
            if len(content) > MAX_RESPONSE_BYTES:
                raise ValueError("SWPL response exceeded the 5 MB safety limit")
            html = content.decode("utf-8", errors="replace")
        elif args.source_file:
            html = args.source_file.read_text(encoding="utf-8")
        else:
            html = fetch_source(args.source_url)
        override_fixtures: list[dict[str, object]] = []
        if args.overrides.exists():
            override_payload = json.loads(args.overrides.read_text(encoding="utf-8"))
            if not isinstance(override_payload.get("fixtures"), list):
                raise ValueError("SWPL overrides must contain a fixtures list")
            override_fixtures = override_payload["fixtures"]
        snapshot = build_snapshot(html, checked_at, override_fixtures)
        write_json(args.output, snapshot)
    except (OSError, ValueError) as error:
        print(f"SWPL sync failed: {error}", file=sys.stderr)
        return 1

    count = len(snapshot["fixtures"])
    ignored = snapshot["diagnostics"]["ignoredNonCalBlueRows"]
    print(f"Synced {count} upcoming CalBlue fixture(s); ignored {ignored} unrelated row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
