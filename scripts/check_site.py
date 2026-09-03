#!/usr/bin/env python3
"""Small dependency-free validation for the CalBlue static site."""

from __future__ import annotations

from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
PAGES = tuple(ROOT.glob("*.html"))
ALBUMS = {
    "tiger": 135,
    "nbh": 58,
    "sfu": 24,
    "hehe": 66,
    "btg": 28,
    "upsl-athletico": 34,
    "upsl-bay-area": 32,
    "upsl-san-ramon": 51,
}
DESIGN_PAGES = tuple(page for page in PAGES if page.name != "design-preview.html")
THEME_ASSETS = {
    "classic": "styles.css",
    "codex-pro": "designs/codex-pro.css",
    "musecode-pro": "designs/musecode-pro/theme.css",
    "floodlight": "designs/floodlight/theme.css",
}


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

    try:
        swpl = json.loads((ROOT / "data" / "swpl.json").read_text(encoding="utf-8"))
        if swpl.get("schemaVersion") != 1:
            errors.append("data/swpl.json: unsupported schemaVersion")
        if swpl.get("team", {}).get("name") != "CalBlue FC":
            errors.append("data/swpl.json: expected the CalBlue FC team")
        if not isinstance(swpl.get("fixtures"), list):
            errors.append("data/swpl.json: fixtures must be a list")
    except (OSError, json.JSONDecodeError) as error:
        errors.append(f"data/swpl.json: {error}")

    homepage = (ROOT / "index.html").read_text(encoding="utf-8")
    if "data-swpl-schedule" not in homepage or "swpl-schedule.js" not in homepage:
        errors.append("index.html: missing SWPL schedule integration")
    if "data-matchday-poster" not in homepage:
        errors.append("index.html: missing match-day poster section")
    if not (ROOT / "assets" / "matchday" / "calblue-vs-sf-glens-2026-09-13.webp").exists():
        errors.append("assets/matchday: missing the CalBlue vs SF Glens poster")

    for page in DESIGN_PAGES:
        source = page.read_text(encoding="utf-8")
        if "data-site-stylesheet" not in source:
            errors.append(f"{page.name}: missing fallback site stylesheet")
        for asset in ("designs/registry.js", "designs/switcher.js", "designs/switcher.css"):
            if asset not in source:
                errors.append(f"{page.name}: missing {asset}")

    registry = (ROOT / "designs" / "registry.js").read_text(encoding="utf-8")
    for design_id, asset in THEME_ASSETS.items():
        if f"id: '{design_id}'" not in registry:
            errors.append(f"designs/registry.js: missing {design_id} design")
        if not (ROOT / asset).exists():
            errors.append(f"designs/registry.js: missing theme asset {asset}")

    preview = (ROOT / "design-preview.html").read_text(encoding="utf-8")
    if "designs/registry.js" not in preview or "switcher=off" not in preview:
        errors.append("design-preview.html: missing registry-driven embedded previews")

    media_config = (ROOT / "media-config.js").read_text(encoding="utf-8")
    if not re.search(r"baseUrl:\s*'https://[^']+'", media_config):
        errors.append("media-config.js: missing HTTPS R2 base URL")

    album_script = (ROOT / "album.js").read_text(encoding="utf-8")
    configured_albums = {
        (match.group("quoted_slug") or match.group("slug")): int(match.group("count"))
        for match in re.finditer(
            r"(?:'(?P<quoted_slug>[\w-]+)'|(?P<slug>\w+)):\s*\{[^}]*count:\s*(?P<count>\d+)",
            album_script,
        )
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
