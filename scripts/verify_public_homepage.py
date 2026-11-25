#!/usr/bin/env python3
"""After deployment, compare the public match card/poster with generated index.html.

Python 3.9 standard library only. No browser, credentials, asset downloads or
database requests. The workflow supplies the separate three-minute step limit.
"""

import argparse
from dataclasses import dataclass
from datetime import date, datetime
from html.parser import HTMLParser
import http.client
from pathlib import Path
import re
import secrets
import ssl
import time
from typing import Optional
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INDEX = ROOT / "index.html"
PUBLIC_URL = "https://calbluefc.com/"
MAX_BYTES = 2 * 1024 * 1024
ATTEMPTS = 12
INTERVAL_SECONDS = 5
TIMEOUT_SECONDS = 10
VOID_TAGS = frozenset("area base br col embed hr img input link meta param source track wbr".split())


class InvalidHomepage(ValueError):
    pass


@dataclass(frozen=True)
class MatchCard:
    datetime: Optional[str]
    date_text: str
    home: str
    away: str
    kickoff: str
    venue: str
    pending: bool


@dataclass(frozen=True)
class Poster:
    hidden: bool
    source: Optional[str]
    matchup: str
    date_text: str
    kickoff: str
    venue: str


@dataclass(frozen=True)
class Homepage:
    card: MatchCard
    poster: Optional[Poster]


class MatchParser(HTMLParser):
    """Read only the existing data hooks, not arbitrary page text or a full DOM."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.roots = {}
        self.values = {}
        self.date_value = None
        self.poster_source = None
        self.poster_images = 0

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        inherited = self.stack[-1] if self.stack else (None, None, None, None)
        _, scope, side, capture = inherited
        root = "card" if "data-next-match" in attrs else "poster" if "data-matchday-poster" in attrs else None
        if root:
            if scope or root in self.roots or tag in VOID_TAGS:
                raise InvalidHomepage()
            scope, side, capture = root, None, None
            self.roots[root] = attrs
        if scope:
            if len(attrs) != len(pairs) or tag in {"script", "style", "template"}:
                raise InvalidHomepage()
            if scope == "card":
                if "data-team-home" in attrs:
                    side = "home"
                if "data-team-away" in attrs:
                    if "data-team-home" in attrs:
                        raise InvalidHomepage()
                    side = "away"
                fields = {"data-match-date": "date", "data-match-time": "kickoff", "data-match-venue": "venue"}
                if "data-team-name" in attrs:
                    if side not in {"home", "away"}:
                        raise InvalidHomepage()
                    fields["data-team-name"] = side
            else:
                fields = {"data-poster-matchup": "matchup", "data-poster-date": "date",
                          "data-poster-kickoff": "kickoff", "data-poster-venue": "venue"}
                if "data-poster-image" in attrs:
                    self.poster_images += 1
                    if tag != "img" or self.poster_images != 1:
                        raise InvalidHomepage()
                    self.poster_source = (attrs.get("src") or "").strip() or None
            selected = [field for hook, field in fields.items() if hook in attrs]
            if selected:
                key = scope + "." + selected[0]
                if len(selected) != 1 or capture or key in self.values or tag in VOID_TAGS or "hidden" in attrs:
                    raise InvalidHomepage()
                self.values[key] = []
                capture = key
                if key == "card.date":
                    self.date_value = (attrs.get("datetime") or "").strip() or None
        if tag not in VOID_TAGS:
            self.stack.append((tag, scope, side, capture))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
        elif self.stack and self.stack[-1][1]:
            raise InvalidHomepage()
        else:
            # Unrelated page markup is outside this small parser's contract.
            for index in range(len(self.stack) - 1, -1, -1):
                if self.stack[index][0] == tag:
                    del self.stack[index:]
                    break

    def handle_data(self, value):
        capture = self.stack[-1][3] if self.stack else None
        if capture:
            self.values[capture].append(value)

    def result(self):
        if "card" not in self.roots or any(frame[1] for frame in self.stack):
            raise InvalidHomepage()

        def field(key):
            value = " ".join("".join(self.values.get(key, [])).split())
            if not value or len(value) > 4096:
                raise InvalidHomepage()
            return value

        card_attrs = self.roots["card"]
        pending = "match-card-empty" in (card_attrs.get("class") or "").split()
        if "hidden" in card_attrs or (self.date_value is None) != pending:
            raise InvalidHomepage()
        if self.date_value is not None:
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}"
                                r"(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2}))?", self.date_value):
                raise InvalidHomepage()
            date.fromisoformat(self.date_value[:10])
            if len(self.date_value) > 10:
                datetime.fromisoformat(self.date_value.replace("Z", "+00:00"))
        card = MatchCard(self.date_value, field("card.date"), field("card.home"), field("card.away"),
                         field("card.kickoff"), field("card.venue"), pending)
        poster = None
        if "poster" in self.roots:
            hidden = "hidden" in self.roots["poster"]
            if self.poster_images != 1 or (not hidden and not self.poster_source):
                raise InvalidHomepage()
            poster = Poster(hidden, self.poster_source, field("poster.matchup"), field("poster.date"),
                            field("poster.kickoff"), field("poster.venue"))
        return Homepage(card, poster)


def parse_homepage(body):
    try:
        if not isinstance(body, bytes) or len(body) > MAX_BYTES:
            raise InvalidHomepage()
        parser = MatchParser()
        parser.feed(body.decode("utf-8-sig"))
        parser.close()
        return parser.result()
    except Exception:
        # HTML/parser errors may contain page text; never echo those details.
        raise InvalidHomepage() from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def make_opener():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        NoRedirect(),
    )


def attempt(expected, opener, url):
    """Return a fixed failure category and whether another attempt is useful."""
    response = None
    try:
        request = urllib.request.Request(url, method="GET", headers={
            "Accept": "text/html", "Accept-Encoding": "identity", "Cache-Control": "no-cache",
            "User-Agent": "CalBlueHomepageVerification/1.0",
        })
        try:
            response = opener.open(request, timeout=TIMEOUT_SECONDS)
        except urllib.error.HTTPError as error:
            response = error
        if response.geturl() != url:
            return "unexpected_response", False
        status = response.getcode()
        if not isinstance(status, int) or isinstance(status, bool):
            return "unexpected_response", False
        if status != 200:
            return "http_error", status in {404, 408, 429} or 500 <= status <= 599
        types = response.headers.get_all("Content-Type", [])
        encodings = response.headers.get_all("Content-Encoding", [])
        if (len(types) != 1 or types[0].split(";", 1)[0].strip().lower() != "text/html"
                or (encodings and encodings != ["identity"])):
            return "unexpected_content_type", True
        lengths = response.headers.get_all("Content-Length", [])
        if lengths:
            if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0]):
                return "unexpected_response", False
            if int(lengths[0]) > MAX_BYTES:
                return "homepage_too_large", False
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            return "homepage_too_large", False
        try:
            actual = parse_homepage(body)
        except InvalidHomepage:
            return "invalid_public_homepage", True
        return (None, False) if actual == expected else ("homepage_mismatch", True)
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        return "network_error", True
    except Exception:
        return "request_error", False
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def run(index_path=DEFAULT_INDEX, *, opener=None, sleep=time.sleep, emit=print, nonce=None):
    try:
        with Path(index_path).open("rb") as stream:
            expected = parse_homepage(stream.read(MAX_BYTES + 1))
        nonce = secrets.token_hex(12) if nonce is None else nonce
        if not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", nonce):
            raise InvalidHomepage()
    except Exception:
        emit("verify_public_homepage: generated homepage is missing or invalid; no public request was made.")
        return 1
    try:
        client = opener if opener is not None else make_opener()
        for number in range(1, ATTEMPTS + 1):
            category, retry = attempt(expected, client, PUBLIC_URL + "?pages_verify=" + nonce + "-" + str(number))
            if category is None:
                day = expected.card.datetime[:10] if expected.card.datetime else "schedule pending"
                emit("verify_public_homepage: public match card and poster match the generated homepage (" + day + ").")
                return 0
            emit("verify_public_homepage: attempt " + str(number) + "/" + str(ATTEMPTS) + ": " + category + ".")
            if not retry or number == ATTEMPTS:
                break
            sleep(INTERVAL_SECONDS)
    except Exception:
        emit("verify_public_homepage: verification transport failed; provider details withheld.")
        return 1
    emit("verify_public_homepage: public homepage was not verified; inspect the published match details.")
    return 1


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise InvalidHomepage()


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX, metavar="PATH")
    try:
        args = parser.parse_args(argv)
    except InvalidHomepage:
        print("verify_public_homepage: invalid arguments.")
        return 1
    return run(args.index)


if __name__ == "__main__":
    raise SystemExit(main())
