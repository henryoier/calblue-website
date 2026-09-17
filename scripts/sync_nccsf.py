#!/usr/bin/env python3
"""Build the public CalBlue schedule snapshot from the official NCCSF API."""

from __future__ import annotations

import argparse
from datetime import date, datetime
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


LEAGUE_ID = 36
SEASON_YEAR = 2026
TEAM_ID = 621
API_URL = f"https://nccsf.org/en/league/game?a=ag&lid={LEAGUE_ID}"
TEAM_LIST_URL = f"https://nccsf.org/en/league/team?a=teams&lid={LEAGUE_ID}"
GOALS_URL = f"https://nccsf.org/en/league/game?a=ajaxGoalList&lid={LEAGUE_ID}"
GOALS_CACHE = Path("data/nccsf-goals.json")
PACIFIC = ZoneInfo("America/Los_Angeles")
MAX_RESPONSE_BYTES = 5_000_000


class FragmentParser(HTMLParser):
    """Extract public anchor text and URL from an NCCSF table cell fragment."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.href: str | None = None
        self._anchor_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        self._anchor_depth += 1
        if self.href is None:
            self.href = dict(attrs).get("href")

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._anchor_depth:
            self._anchor_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._anchor_depth:
            self.text.append(data)


class TeamDirectoryParser(HTMLParser):
    """Extract team IDs, names, profile URLs, and official crests."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found_table = False
        self.teams: dict[int, dict[str, str]] = {}
        self._table_depth = 0
        self._team: dict[str, object] | None = None
        self._anchor_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "table" and values.get("id") == "teamList":
            self.found_table = True
            self._table_depth = 1
            return
        if not self._table_depth:
            return
        if tag == "table":
            self._table_depth += 1
        if tag == "a" and self._team is None:
            identifier = team_id(values.get("href"))
            if identifier is not None:
                self._team = {
                    "id": identifier,
                    "name": [],
                    "url": absolute_https_url(values.get("href"), TEAM_LIST_URL) or "",
                    "logo": "",
                }
                self._anchor_depth = 1
        elif tag == "a" and self._team is not None:
            self._anchor_depth += 1
        elif tag == "img" and self._team is not None:
            self._team["logo"] = absolute_https_url(values.get("src"), TEAM_LIST_URL) or ""

    def handle_endtag(self, tag: str) -> None:
        if not self._table_depth:
            return
        if tag == "a" and self._team is not None:
            self._anchor_depth -= 1
            if self._anchor_depth == 0:
                identifier = int(self._team["id"])
                logo = str(self._team["logo"])
                if logo:
                    self.teams[identifier] = {
                        "name": clean_text("".join(self._team["name"])),
                        "url": str(self._team["url"]),
                        "logo": logo,
                    }
                self._team = None
        elif tag == "table":
            self._table_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._team is not None and self._anchor_depth:
            self._team["name"].append(data)


def clean_text(value: str) -> str:
    return " ".join(value.split())


def absolute_https_url(value: str | None, base: str) -> str | None:
    if not value:
        return None
    absolute = urljoin(base, value)
    parsed = urlparse(absolute)
    if parsed.scheme not in {"http", "https"}:
        return None
    return parsed._replace(scheme="https").geturl()


def parse_fragment(value: object) -> tuple[str, str | None]:
    parser = FragmentParser()
    parser.feed(str(value or ""))
    text = clean_text("".join(parser.text))
    if not parser.href:
        return text, None
    return text, absolute_https_url(parser.href, "https://nccsf.org/en/league/")


def team_id(value: object) -> int | None:
    match = re.search(r"[?&]tid=(\d+)", str(value or ""))
    return int(match.group(1)) if match else None


def game_id(value: object) -> str:
    match = re.search(r"[?&]gid=(\d+)", str(value or ""))
    return match.group(1) if match else ""


def parse_team_directory(content: str) -> dict[int, dict[str, str]]:
    parser = TeamDirectoryParser()
    parser.feed(content)
    if not parser.found_table:
        raise ValueError("NCCSF team directory was not found; the upstream page may have changed")
    if TEAM_ID not in parser.teams or parser.teams[TEAM_ID]["name"] != "CalBlue":
        raise ValueError("NCCSF team directory did not identify CalBlue")
    return parser.teams


def parse_start(value: object, season_year: int) -> tuple[str, str, str]:
    raw = clean_text(str(value or ""))
    try:
        local = datetime.strptime(f"{season_year}-{raw}", "%Y-%m-%d %H:%M").replace(
            tzinfo=PACIFIC
        )
    except ValueError as error:
        raise ValueError(f"NCCSF returned an invalid fixture date: {raw!r}") from error
    time_label = local.strftime("%I:%M %p").lstrip("0") + " PT"
    return local.date().isoformat(), local.isoformat(), time_label


def build_snapshot(
    content: str,
    team_directory_html: str,
    checked_at: datetime,
    *,
    season_year: int = SEASON_YEAR,
    league_id: int = LEAGUE_ID,
    calblue_team_id: int = TEAM_ID,
) -> dict[str, object]:
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise ValueError("NCCSF response was not valid JSON") from error
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("NCCSF response did not contain a game list")

    teams = parse_team_directory(team_directory_html)
    checked_at = checked_at.astimezone(PACIFIC)
    competition = f"{season_year} NCCSF Fall League"
    fixtures: list[dict[str, object]] = []
    results: list[dict[str, object]] = []
    calblue_rows = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        home_id = team_id(row.get("home"))
        away_id = team_id(row.get("away"))
        if calblue_team_id not in {home_id, away_id}:
            continue
        calblue_rows += 1
        home_name, home_url = parse_fragment(row.get("home"))
        away_name, away_url = parse_fragment(row.get("away"))
        if not home_name or not away_name:
            raise ValueError("NCCSF returned a CalBlue fixture without both team names")
        if (home_id == calblue_team_id and home_name != "CalBlue") or (
            away_id == calblue_team_id and away_name != "CalBlue"
        ):
            raise ValueError("NCCSF team ID no longer identifies CalBlue; refusing unknown data")
        for identifier, name in ((home_id, home_name), (away_id, away_name)):
            directory_team = teams.get(identifier or -1)
            if not directory_team or directory_team["name"] != name:
                raise ValueError(f"NCCSF team directory is missing a matching crest for {name}")

        fixture_date, starts_at, time_label = parse_start(row.get("date"), season_year)
        score = clean_text(str(row.get("score") or ""))
        score_match = re.fullmatch(r"(\d+)\s*[:–-]\s*(\d+)", score)
        completed = bool(score_match) and date.fromisoformat(fixture_date) <= checked_at.date()
        if date.fromisoformat(fixture_date) < checked_at.date() and not completed:
            continue
        venue_name, map_url = parse_fragment(row.get("field"))
        round_name, _ = parse_fragment(row.get("game"))
        gid = game_id(row.get("game"))
        (results if completed else fixtures).append(
            {
                "id": f"nccsf-{gid}" if gid else f"nccsf-{fixture_date}-{home_id}-{away_id}",
                "date": fixture_date,
                "startsAt": starts_at,
                "timeLabel": time_label,
                "competition": competition,
                "round": round_name,
                "home": {
                    "name": home_name,
                    "url": home_url,
                    "logo": teams[home_id]["logo"],
                },
                "away": {
                    "name": away_name,
                    "url": away_url,
                    "logo": teams[away_id]["logo"],
                },
                "venue": {
                    "name": venue_name or "Venue TBA",
                    "mapUrl": map_url,
                },
                "conference": clean_text(str(row.get("division") or "")),
                "sourceUrl": f"https://nccsf.org/en/league/game?a=games&lid={league_id}",
                "status": "completed" if completed else "scheduled",
                **({"score": {"home": int(score_match[1]), "away": int(score_match[2])}} if completed else {}),
            }
        )

    if not calblue_rows:
        raise ValueError("NCCSF game list did not identify CalBlue; refusing unknown data")
    fixtures.sort(key=lambda fixture: str(fixture["startsAt"]))
    results.sort(key=lambda fixture: str(fixture["startsAt"]), reverse=True)
    return {
        "schemaVersion": 1,
        "source": f"https://nccsf.org/en/league/game?a=ag&lid={league_id}",
        "sourcePage": f"https://nccsf.org/en/league/game?a=games&lid={league_id}",
        "checkedAt": checked_at.isoformat(timespec="seconds"),
        "season": {
            "name": competition,
            "year": season_year,
            "leagueId": league_id,
        },
        "team": {
            "name": "CalBlue",
            "id": calblue_team_id,
            "url": teams[calblue_team_id]["url"],
            "logo": teams[calblue_team_id]["logo"],
        },
        "fixtures": fixtures,
        "results": results,
        "diagnostics": {
            "publishedCalBlueFixtures": calblue_rows,
            "upcomingCalBlueFixtures": len(fixtures),
        },
    }


# ---------------- goal scorers (NCCSF "Goals & Highlights") ----------------
def player_display_name(value: str) -> str:
    """NCCSF lists players as 'Last, First'; show 'First Last'. A trailing * marks a highlight clip, not a goal."""
    name = value.strip().rstrip("*").strip()
    if "," in name:
        last, _, first = name.partition(",")
        return f"{first.strip()} {last.strip()}".strip()
    return name


def parse_goals(content: str) -> dict[str, list[dict[str, object]]]:
    """Goals grouped by NCCSF game id from the public goal list endpoint (a=ajaxGoalList)."""
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise ValueError("NCCSF goal list was not valid JSON") from error
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("NCCSF goal list did not contain a data list")
    goals: dict[str, list[dict[str, object]]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        gid_match = re.search(r"gid=(\d+)", str(row.get("week") or ""))
        if not gid_match:
            continue
        raw_name, _ = parse_fragment(row.get("player"))
        raw_name = clean_text(raw_name)
        if not raw_name:
            continue
        pid_match = re.search(r"pid=(\d+)", str(row.get("player") or ""))
        team_name, _ = parse_fragment(row.get("team"))
        goals.setdefault(gid_match.group(1), []).append(
            {
                "player": player_display_name(raw_name),
                "playerId": int(pid_match.group(1)) if pid_match else None,
                "team": team_name,
                "teamId": team_id(row.get("team")),
                "week": clean_text(str(row.get("week") or "")),
                "highlight": raw_name.endswith("*"),
            }
        )
    return goals


def load_goal_cache(path: Path) -> dict[str, list[dict[str, object]]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    games = payload.get("games") if isinstance(payload, dict) else None
    return {str(gid): rows for gid, rows in (games or {}).items() if isinstance(rows, list)}


def merge_goals(cache: dict[str, list[dict[str, object]]], fresh: dict[str, list[dict[str, object]]]) -> dict[str, list[dict[str, object]]]:
    """Fresh games replace cached ones; games the endpoint no longer lists (earlier weeks) are kept."""
    merged = dict(cache)
    merged.update(fresh)
    return dict(sorted(merged.items(), key=lambda item: int(item[0]) if item[0].isdigit() else 0))


def attach_goals(snapshot: dict[str, object], goals_by_game: dict[str, list[dict[str, object]]]) -> int:
    """Add a `goals` list (player, playerId, side, highlight) to each completed result that has published scorers."""
    attached = 0
    for result in snapshot.get("results", []) or []:
        gid = str(result.get("id", "")).removeprefix("nccsf-")
        entries = goals_by_game.get(gid)
        if not entries:
            continue
        sides = {team_id(result["home"].get("url")): "home", team_id(result["away"].get("url")): "away"}
        goals = []
        for entry in entries:
            side = sides.get(entry.get("teamId"))
            if not side:
                continue
            goals.append({"player": entry["player"], "playerId": entry.get("playerId"), "side": side, "highlight": bool(entry.get("highlight"))})
        if not goals:
            continue
        result["goals"] = goals
        counted = {"home": 0, "away": 0}
        for goal in goals:
            if not goal["highlight"]:
                counted[goal["side"]] += 1
        score = result.get("score") or {}
        if counted != {"home": score.get("home"), "away": score.get("away")}:
            result["goalsNote"] = "partial"   # the league has not published every scorer yet
        attached += 1
    return attached


def write_goal_cache(path: Path, goals_by_game: dict[str, list[dict[str, object]]], checked_at: datetime) -> None:
    write_json(
        path,
        {
            "schemaVersion": 1,
            "source": GOALS_URL,
            "note": "Published NCCSF scorers by game id, accumulated across weeks so earlier games keep their scorers if the league endpoint only lists the current week. Refreshed by scripts/sync_nccsf.py.",
            "checkedAt": checked_at.isoformat(timespec="seconds"),
            "games": goals_by_game,
        },
    )


def fetch_source(url: str, accept: str) -> str:
    request = Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "CalBlueScheduleSync/1.0 (+https://calbluefc.com/)",
        },
    )
    with urlopen(request, timeout=25) as response:
        content = response.read(MAX_RESPONSE_BYTES + 1)
        if len(content) > MAX_RESPONSE_BYTES:
            raise ValueError("NCCSF response exceeded the 5 MB safety limit")
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
    parser.add_argument("--source-url", default=API_URL)
    parser.add_argument("--source-file", type=Path)
    parser.add_argument("--teams-url", default=TEAM_LIST_URL)
    parser.add_argument("--teams-file", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/nccsf.json"))
    parser.add_argument("--goals-url", default=GOALS_URL)
    parser.add_argument("--goals-file", type=Path, help="saved goal list response (a=ajaxGoalList)")
    parser.add_argument("--goals-cache", type=Path, default=GOALS_CACHE, help="accumulated scorers by game id")
    parser.add_argument("--skip-goals", action="store_true", help="do not fetch or attach scorers")
    parser.add_argument("--checked-at", help="ISO timestamp used for reproducible tests")
    parser.add_argument("--season-year", type=int, default=SEASON_YEAR)
    parser.add_argument("--league-id", type=int, default=LEAGUE_ID)
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
                raise ValueError("NCCSF response exceeded the 5 MB safety limit")
            source = content.decode("utf-8", errors="replace")
        elif args.source_file:
            source = args.source_file.read_text(encoding="utf-8")
        else:
            source = fetch_source(args.source_url, "application/json")
        if args.teams_file:
            team_directory = args.teams_file.read_text(encoding="utf-8")
        else:
            team_directory = fetch_source(args.teams_url, "text/html,application/xhtml+xml")
        snapshot = build_snapshot(
            source,
            team_directory,
            checked_at,
            season_year=args.season_year,
            league_id=args.league_id,
        )
        attached = 0
        if not args.skip_goals:
            cached = load_goal_cache(args.goals_cache)
            fresh: dict[str, list[dict[str, object]]] = {}
            try:
                goals_source = (
                    args.goals_file.read_text(encoding="utf-8")
                    if args.goals_file
                    else fetch_source(args.goals_url, "application/json")
                )
                fresh = parse_goals(goals_source)
            except (OSError, ValueError) as error:
                # Scorers are an enrichment: keep deploying with the cached list rather than failing the schedule sync.
                print(f"NCCSF goal list unavailable ({error}); using {len(cached)} cached game(s).", file=sys.stderr)
            merged = merge_goals(cached, fresh)
            if merged != cached:
                write_goal_cache(args.goals_cache, merged, checked_at)
            attached = attach_goals(snapshot, merged)
        write_json(args.output, snapshot)
    except (OSError, ValueError) as error:
        print(f"NCCSF sync failed: {error}", file=sys.stderr)
        return 1

    count = len(snapshot["fixtures"])
    print(f"Synced {count} upcoming CalBlue NCCSF fixture(s); scorers attached to {attached} result(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
