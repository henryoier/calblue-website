#!/usr/bin/env python3
"""Small dependency-free validation for the CalBlue static site."""

from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
PAGES = tuple(ROOT.glob("*.html"))
ALBUMS = {"tiger": 135, "nbh": 58, "sfu": 24, "hehe": 66, "btg": 28}


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.references: list[str] = []
        self.has_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "title":
            self.has_title = True
        if values.get("id"):
            self.ids.add(values["id"] or "")
        for key in ("href", "src"):
            value = values.get(key)
            if value:
                self.references.append(value)


def check_page(path: Path) -> list[str]:
    parser = PageParser()
    parser.feed(path.read_text(encoding="utf-8"))
    errors: list[str] = []

    if not parser.has_title:
        errors.append(f"{path.name}: missing title")

    for reference in parser.references:
        if reference.startswith("#"):
            anchor = reference[1:]
            if anchor and anchor not in parser.ids:
                errors.append(f"{path.name}: missing anchor {reference}")
            continue
        if reference.startswith(("http://", "https://", "mailto:")):
            continue
        if reference == "./":
            continue
        local_reference = reference.split("#", 1)[0].split("?", 1)[0]
        local_path = (path.parent / local_reference).resolve()
        if not local_path.exists():
            errors.append(f"{path.name}: missing local file {reference}")

    return errors


def main() -> int:
    errors = [error for page in PAGES for error in check_page(page)]

    media_config = (ROOT / "media-config.js").read_text(encoding="utf-8")
    if not re.search(r"baseUrl:\s*'https://[^']+'", media_config):
        errors.append("media-config.js: missing HTTPS R2 base URL")

    album_script = (ROOT / "album.js").read_text(encoding="utf-8")
    configured_albums = {
        match.group("slug"): int(match.group("count"))
        for match in re.finditer(r"(?P<slug>\w+):\s*\{[^}]*count:\s*(?P<count>\d+)", album_script)
    }
    for album, expected_count in ALBUMS.items():
        if configured_albums.get(album) != expected_count:
            errors.append(f"album.js: {album} should contain {expected_count} photos")

    if (ROOT / "assets" / "gallery").exists():
        errors.append("assets/gallery: local gallery copies should not be committed")

    for pattern in ("*.html", "*.css", "*.js"):
        for source_path in ROOT.glob(pattern):
            if "assets/gallery" in source_path.read_text(encoding="utf-8"):
                errors.append(f"{source_path.name}: contains a removed local gallery reference")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Validated {len(PAGES)} pages, local references, and R2 gallery configuration.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
