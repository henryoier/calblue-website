#!/usr/bin/env python3
"""Check two fixed Supabase projects with anonymous, read-only HEAD requests.

This checks a real public games-table projection. It does not sign in, read row
bodies, write database data, or guarantee a provider's inactivity policy.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import http.client
import json
from pathlib import Path
import re
import ssl
import time
from typing import Callable, Optional
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / ".github" / "supabase-activity.json"
PROJECTS = (
    ("website", "rmksoklavpoartewjvus"),
    ("verification-test", "njsprzewuxmrfpgwktmf"),
)
MAX_CONFIG_BYTES = 4096
TIMEOUT_SECONDS = 20
MAX_ATTEMPTS = 2
RETRY_DELAY_SECONDS = 2
PUBLIC_KEY = re.compile(r"sb_publishable_[A-Za-z0-9_-]{16,128}\Z")
READ_PATH = "/rest/v1/games?select=id&limit=1"


class InvalidConfig(ValueError):
    """Only a fixed category, never configuration values or file paths."""


@dataclass(frozen=True)
class Project:
    label: str
    ref: str
    publishable_key: str = field(repr=False)


@dataclass(frozen=True)
class Outcome:
    status: Optional[int] = None
    category: Optional[str] = None
    retryable: bool = False

    @property
    def ok(self) -> bool:
        return self.status in (200, 206) and self.category is None


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidConfig("invalid_config")
        result[key] = value
    return result


def load_projects(config_path: Path) -> tuple[Project, ...]:
    """Validate the complete bounded config before creating any network client."""
    try:
        with Path(config_path).open("rb") as stream:
            raw = stream.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise InvalidConfig("invalid_config")
        config = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object)
        if not isinstance(config, dict) or set(config) != {"projects"}:
            raise InvalidConfig("invalid_config")
        entries = config["projects"]
        if not isinstance(entries, list) or len(entries) != len(PROJECTS):
            raise InvalidConfig("invalid_config")
        expected = dict(PROJECTS)
        found = {}
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {"label", "ref", "publishable_key"}:
                raise InvalidConfig("invalid_config")
            label, ref, key = entry["label"], entry["ref"], entry["publishable_key"]
            if not all(isinstance(value, str) for value in (label, ref, key)):
                raise InvalidConfig("invalid_config")
            if label not in expected or label in found or ref != expected[label]:
                raise InvalidConfig("invalid_config")
            if not PUBLIC_KEY.fullmatch(key):
                raise InvalidConfig("invalid_config")
            found[label] = Project(label, ref, key)
        if set(found) != set(expected):
            raise InvalidConfig("invalid_config")
        # Deterministic fixed ordering, independent of the file's array order.
        return tuple(found[label] for label, _ in PROJECTS)
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        raise InvalidConfig("invalid_config") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def make_opener():
    """Verified TLS, no environment proxy, redirects, cookies or auth handlers."""
    context = ssl.create_default_context()
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=context),
        NoRedirect(),
    )


def _http_outcome(status) -> Outcome:
    if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599:
        return Outcome(category="invalid_response")
    return Outcome(status=status, retryable=status in (408, 429) or 500 <= status <= 599)


def _json_content_type(headers) -> bool:
    # Duplicate Content-Type headers are ambiguous; accept one JSON media type.
    values = headers.get_all("Content-Type", [])
    return (len(values) == 1 and isinstance(values[0], str) and len(values[0]) <= 128
            and values[0].split(";", 1)[0].strip().lower() == "application/json")


def _attempt(project: Project, opener) -> Outcome:
    url = "https://" + project.ref + ".supabase.co" + READ_PATH
    response = None
    try:
        request = urllib.request.Request(url, method="HEAD", headers={
            "apikey": project.publishable_key,
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "CalBlueSupabaseActivity/1.0",
        })
        try:
            response = opener.open(request, timeout=TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            # HTTPError owns a response stream too: inspect status only and close
            # it below, without reading/printing its body, reason, URL or headers.
            response = error
        if response.geturl() != url:
            return Outcome(category="invalid_response")
        outcome = _http_outcome(response.getcode())
        if outcome.status in (200, 206) and not _json_content_type(response.headers):
            return Outcome(category="invalid_content_type")
        return outcome
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        return Outcome(category="network_error", retryable=True)
    except Exception:
        # Even unexpected provider/library exceptions can contain request keys.
        return Outcome(category="request_error")
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def check_project(project: Project, opener, sleep: Callable[[float], None]) -> Outcome:
    for attempt in range(MAX_ATTEMPTS):
        outcome = _attempt(project, opener)
        if not outcome.retryable or attempt == MAX_ATTEMPTS - 1:
            return outcome
        sleep(RETRY_DELAY_SECONDS)
    return Outcome(category="request_error")  # Defensive; MAX_ATTEMPTS is fixed.


def run(config_path: Path = DEFAULT_CONFIG, *, opener=None,
        sleep: Callable[[float], None] = time.sleep, emit: Callable[[str], None] = print) -> int:
    try:
        projects = load_projects(config_path)
    except InvalidConfig:
        emit("configuration: invalid_config")
        return 1
    try:
        client = opener if opener is not None else make_opener()
    except Exception:
        for project in projects:
            emit(project.label + ": request_error")
        return 1
    failed = False
    for project in projects:
        try:
            outcome = check_project(project, client, sleep)
        except Exception:
            outcome = Outcome(category="request_error")
        failed = failed or not outcome.ok
        detail = outcome.category if outcome.category is not None else "HTTP " + str(outcome.status)
        emit(project.label + ": " + detail)
    return int(failed)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error can echo unrecognized arguments or paths.
        raise InvalidConfig("invalid_arguments")


def main(argv=None) -> int:
    parser = SafeParser(description="Check the two configured projects with anonymous HEAD requests.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG, metavar="PATH",
                        help="JSON configuration path; project references remain fixed")
    try:
        arguments = parser.parse_args(argv)
    except InvalidConfig:
        print("configuration: invalid_arguments")
        return 1
    return run(arguments.config)


if __name__ == "__main__":
    raise SystemExit(main())
