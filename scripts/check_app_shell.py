"""Validate local app module references/conventions, not JS syntax or browser behavior."""

from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import urlsplit, unquote

if __package__:
    from .check_no_build import module_specifiers
else:
    from check_no_build import module_specifiers


class ModuleScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []
        self.inline = []
        self.in_module = False
        self.references = []
        self.ids = set()
        self.has_title = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        self.has_title = self.has_title or tag == "title"
        if values.get("id"):
            self.ids.add(values["id"])
        self.references.extend(values[key] for key in ("src", "href") if values.get(key))
        if tag == "script":
            self.in_module = values.get("type") == "module" and not values.get("src")
            if values.get("type") == "module" and values.get("src"):
                self.sources.append(values["src"])

    def handle_data(self, data):
        if self.in_module:
            self.inline.append(data)

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_module = False


def local_module(root, importer, specifier, errors):
    url = urlsplit(specifier)
    if url.scheme or url.netloc:
        return None  # CDN loading needs a real browser; computed imports need review.
    if not specifier.startswith(("./", "../", "/")):
        errors.append(f"{importer.relative_to(root)}: bare module specifier {specifier}")
        return None
    pathname = unquote(url.path)
    target = (root / pathname.lstrip("/") if pathname.startswith("/") else importer.parent / pathname).resolve()
    if root not in target.parents or not target.is_file() or target.suffix != ".js":
        errors.append(f"{importer.relative_to(root)}: missing/invalid local module {specifier}")
        return None
    return target


def check_app_shell(root):
    root = Path(root).resolve()
    app = root / "app"
    errors = []
    required = (
        "index.html", "config.js", "css/app.css", "js/app.js", "js/router.js",
        "js/session.js", "js/supabase.js", "js/layout.js", "js/dom.js", "js/identity.js", "js/verification.js",
        "views/home.js", "views/sign-in.js", "views/identity.js", "views/verification.js", "views/not-found.js", "views/placeholder.js",
        "tests/index.html", "tests/runner.js", "tests/app.test.js",
    )
    for name in required:
        if not (app / name).is_file():
            errors.append(f"app/{name}: missing app-shell file")

    roots = {}
    for entry in (app / "index.html", app / "tests/index.html"):
        if not entry.is_file():
            continue
        source = entry.read_text(encoding="utf-8")
        if not re.search(r'<meta\s+[^>]*name=["\']viewport["\']', source):
            errors.append(f"{entry.relative_to(root)}: missing viewport metadata")
        parser = ModuleScripts()
        parser.feed(source)
        if not parser.has_title:
            errors.append(f"{entry.relative_to(root)}: missing title")
        for reference in parser.references:
            if reference.startswith("#"):
                if reference[1:] and not reference.startswith("#/") and reference[1:] not in parser.ids:
                    errors.append(f"{entry.relative_to(root)}: missing anchor {reference}")
                continue
            url = urlsplit(reference)
            if url.scheme or url.netloc:
                continue
            pathname = unquote(url.path)
            target = (root / pathname.lstrip("/") if pathname.startswith("/") else entry.parent / pathname).resolve()
            if (target != root and root not in target.parents) or not (
                target.is_file() or (target / "index.html").is_file()
            ):
                errors.append(f"{entry.relative_to(root)}: missing local asset {reference}")
        imports = parser.sources + [specifier for _, specifier in module_specifiers("\n".join(parser.inline))]
        roots[entry] = [target for specifier in imports
                        if (target := local_module(root, entry, specifier, errors))]
        if not roots[entry]:
            errors.append(f"{entry.relative_to(root)}: no local module entry point")

    modules = [app / "config.js"]
    for directory in ("js", "views", "tests"):
        modules.extend((app / directory).glob("*.js"))
    graph = {}
    for module in modules:
        if not module.is_file():
            continue
        source = module.read_text(encoding="utf-8")
        graph[module] = [target for _, specifier in module_specifiers(source)
                         if (target := local_module(root, module, specifier, errors))]
        if module.parent.name in {"js", "views"} and module.name != "dom.js" and re.search(r"\.innerHTML\s*=", source):
            errors.append(f"{module.relative_to(root)}: assign DOM through app/js/dom.js")

    def reachable(entry):
        pending, visited = list(roots.get(entry, [])), set()
        while pending:
            module = pending.pop()
            if module not in visited:
                visited.add(module)
                pending.extend(graph.get(module, []))
        return visited

    reached = reachable(app / "index.html")
    for name in required:
        if name.endswith(".js") and not name.startswith("tests/") and app / name not in reached:
            errors.append(f"app/{name}: unreachable from app/index.html")
    test_reached = reachable(app / "tests/index.html")
    for module in (app / "tests").glob("*.test.js"):
        if module not in test_reached:
            errors.append(f"{module.relative_to(root)}: browser test not loaded")

    controller = app / "js/app.js"
    if controller.is_file():
        patterns = set(re.findall(r'pattern:\s*"([^"]+)"', controller.read_text(encoding="utf-8")))
        if "*" not in patterns:
            errors.append("app/js/app.js: missing 404 route")
        for module in (controller, app / "js/layout.js", *(app / "views").glob("*.js")):
            if not module.is_file():
                continue
            for route in re.findall(r'href\s*(?:=|:)\s*["\']#(/[^"\']*)', module.read_text(encoding="utf-8")):
                if route.split("?", 1)[0] not in patterns:
                    errors.append(f"{module.relative_to(root)}: unregistered route {route}")
    return errors
