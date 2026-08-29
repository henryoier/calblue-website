#!/usr/bin/env python3
"""Small dependency-free validation for the CalBlue static site."""

from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import re
import sys

from check_secrets import check_repository


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

    for path, finding in check_repository(ROOT):
        errors.append(f"{path.relative_to(ROOT)}: {finding}")

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

    # --- app shell (#29) ---
    app_index = ROOT / "app" / "index.html"
    if not app_index.exists():
        errors.append("app/index.html: missing app entry point")
    else:
        app_source = app_index.read_text(encoding="utf-8")
        for required in (
            "js/router.js", "js/supabase.js", "js/session.js", "js/layout.js",
            "views/home.js", "views/sign-in.js", "views/not-found.js",
            "views/placeholder.js", "css/app.css",
        ):
            if not (ROOT / "app" / required).exists():
                errors.append(f"app/{required}: missing (app shell #29)")
            if required not in app_source:
                errors.append(f"app/index.html: does not load {required}")
        if 'name="viewport"' not in app_source:
            errors.append("app/index.html: missing mobile viewport metadata")
        app_errors = check_page(app_index)
        # app pages are noindex and use module scripts; only check local refs
        errors.extend([e for e in app_errors if "missing local file" in e])

    for required_app_file in (
        "app/js/router.js", "app/js/supabase.js", "app/js/session.js",
        "app/js/layout.js", "app/js/dom.js", "app/config.js", "app/css/app.css",
        "app/views/home.js", "app/views/sign-in.js", "app/views/not-found.js",
        "app/views/placeholder.js", "app/tests/index.html",
        "app/tests/router.logic.js", "app/tests/session.logic.js",
        "app/tests/layout.logic.js", "app/tests/supabase.logic.js",
    ):
        if not (ROOT / required_app_file).exists():
            errors.append(f"{required_app_file}: missing (app shell #29)")

    app_tests = ROOT / "app" / "tests" / "index.html"
    if app_tests.exists():
        test_source = app_tests.read_text(encoding="utf-8")
        for module in (
            "dom.test.js", "router.test.js", "session.test.js",
            "session.live.test.js", "layout.test.js", "supabase.test.js",
        ):
            if module not in test_source:
                errors.append(f"app/tests/index.html: does not load {module}")
            if not (app_tests.parent / module).exists():
                errors.append(f"app/tests/{module}: missing")
        errors.extend(check_page(app_tests))

    app_css = ROOT / "app" / "css" / "app.css"
    if app_css.exists():
        css_source = app_css.read_text(encoding="utf-8")
        for marker in ("@media (max-width: 400px)", "min-height: 44px", "text-overflow: ellipsis"):
            if marker not in css_source:
                errors.append(f"app/css/app.css: missing mobile safeguard {marker!r}")

    # Every visible hash link must resolve to a registered route. This keeps a
    # new role-gated navigation item from quietly becoming a 404.
    if app_index.exists():
        route_patterns = set(re.findall(r'pattern:\s*"([^"]+)"', app_source))
        linked_routes: set[str] = set()
        for source_path in (
            app_index,
            *(ROOT / "app" / "js").glob("*.js"),
            *(ROOT / "app" / "views").glob("*.js"),
        ):
            source = source_path.read_text(encoding="utf-8")
            linked_routes.update(
                link.split("?", 1)[0]
                for link in re.findall(r'href\s*(?:=|:)\s*["\']#(/[^"\']*)', source)
            )
            if source_path.name != "dom.js" and re.search(r"\.innerHTML\s*=", source):
                errors.append(f"{source_path.relative_to(ROOT)}: assign DOM through app/js/dom.js")
        for route in sorted(linked_routes - route_patterns):
            errors.append(f"app navigation links to unregistered route {route}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Validated {len(PAGES)} pages, local references, and R2 gallery configuration.")
    print("Validated app shell: router, session, supabase client, layout, and views.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
