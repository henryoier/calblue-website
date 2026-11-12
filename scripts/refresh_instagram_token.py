#!/usr/bin/env python3
"""Keep the club's Instagram API token alive.

The deploy reads @calbluefc posts with a long-lived token kept in the IG_ACCESS_TOKEN repository
secret. A long-lived token for the Instagram API with Instagram Login lasts 60 days. Instagram extends
it for another 60 days when it is refreshed while it is still valid and at least 24 hours old:

  IG_ACCESS_TOKEN=... python3 scripts/refresh_instagram_token.py [--new-token-file PATH]

The token comes from the environment, never from the command line, and is never printed. The run exits
1 when Instagram refuses the refresh, so a dead token is a failed workflow rather than a warning inside
a green deploy. If Instagram answers with a different token string, that string is written to
--new-token-file for the workflow to store in the secret, and `changed=true` is set as a step output.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote

REFRESH_URL = "https://graph.instagram.com/refresh_access_token"
USER_AGENT = "CalBlueNewsSync/1.0 (+https://calbluefc.com/)"
NEXT_STEP = "Generate a new token in the Meta App Dashboard and paste it into the IG_ACCESS_TOKEN repository secret."


class RefreshError(Exception):
    """Instagram did not extend the token."""


def fetch_json(url: str) -> dict:
    """GET a JSON document with curl.

    The URL carries the token, so curl reads it from stdin instead of argv. --fail is left off on
    purpose: with it a refused token is a bare exit 22 and Instagram's explanation is lost.
    """
    completed = subprocess.run(
        ["curl", "--silent", "--show-error", "--location", "--max-time", "60", "--user-agent", USER_AGENT, "--config", "-"],
        input=f'url = "{url}"\n'.encode("utf-8"),
        capture_output=True,
        check=False,
    )
    if completed.returncode:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RefreshError(f"curl exited {completed.returncode}: {detail}")
    try:
        return json.loads(completed.stdout.decode("utf-8"))
    except ValueError as error:
        raise RefreshError("Instagram answered with something that is not JSON") from error


def refresh(token: str, fetch=fetch_json) -> dict:
    """Ask Instagram to extend `token`. Returns {"access_token": str, "expires_in": seconds}."""
    page = fetch(f"{REFRESH_URL}?grant_type=ig_refresh_token&access_token={quote(token, safe='')}")
    if not isinstance(page, dict):
        raise RefreshError("Instagram answered with an unexpected document")
    if "error" in page:
        problem = page["error"]
        if isinstance(problem, dict):
            message = str(problem.get("message") or problem)
            if problem.get("code") is not None:
                message = f"{message} (code {problem['code']})"
        else:
            message = str(problem)
        raise RefreshError(message)
    new_token = page.get("access_token")
    lifetime = page.get("expires_in")
    if not new_token or isinstance(lifetime, bool) or not isinstance(lifetime, (int, float)) or lifetime <= 0:
        raise RefreshError("Instagram's answer has no usable access_token and expires_in")
    return {"access_token": str(new_token), "expires_in": int(lifetime)}


def redact(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[token]").replace(quote(secret, safe=""), "[token]")
    return text


def write_private(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(value)        # no trailing newline: the file is piped straight into the secret


def main(argv=None, env=None, fetch=fetch_json, now=None, out=None) -> int:
    env = os.environ if env is None else env
    out = sys.stdout if out is None else out
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--new-token-file", help="where to write the token if Instagram issues a different string")
    parser.add_argument("--min-days", type=float, default=30, help="fail if the refreshed token lasts fewer days than this")
    args = parser.parse_args(argv)

    in_actions = env.get("GITHUB_ACTIONS") == "true"

    def say(level: str, message: str) -> None:
        print(f"::{level}::{message}" if in_actions else f"refresh_instagram_token: {message}", file=out)

    token = (env.get("IG_ACCESS_TOKEN") or "").strip()
    if not token:
        say("error", "IG_ACCESS_TOKEN is not set, so there is no token to refresh.")
        return 1
    try:
        page = refresh(token, fetch)
    except RefreshError as error:
        say("error", redact(f"Instagram refused the token refresh: {error}. {NEXT_STEP}", token))
        return 1

    new_token = page["access_token"]
    changed = new_token != token
    if changed and in_actions:
        print(f"::add-mask::{new_token}", file=out)     # must precede anything else this run prints
    now = datetime.now(timezone.utc) if now is None else now
    expires_at = now + timedelta(seconds=page["expires_in"])
    days = page["expires_in"] / 86400
    if changed and args.new_token_file:
        write_private(Path(args.new_token_file), new_token)
    if env.get("GITHUB_OUTPUT"):
        with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as handle:
            handle.write(f"changed={'true' if changed else 'false'}\n")
            handle.write(f"expires_at={expires_at:%Y-%m-%d}\n")

    message = f"Instagram token extended: valid for {days:.0f} days, until {expires_at:%Y-%m-%d}."
    if changed:
        message += " Instagram issued a different token string, which has to replace the IG_ACCESS_TOKEN secret."
    say("notice", message)
    if days < args.min_days:
        say("error", f"The refreshed token lasts only {days:.0f} days (expected about 60). {NEXT_STEP}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
