#!/usr/bin/env python3
"""Small dependency-free validation for the CalBlue static site."""

from html.parser import HTMLParser
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent
PAGES = (ROOT / "index.html", ROOT / "roster.html", ROOT / "gallery.html", ROOT / "404.html")


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
        local_reference = reference.split("#", 1)[0]
        local_path = (path.parent / local_reference).resolve()
        if not local_path.exists():
            errors.append(f"{path.name}: missing local file {reference}")

    return errors


def main() -> int:
    errors = [error for page in PAGES for error in check_page(page)]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Validated {len(PAGES)} pages and all local references.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
