"""Offline app module-graph checks. No browser/SDK/database execution."""

from pathlib import Path
import tempfile
import unittest

from scripts.check_app_shell import check_app_shell, local_module, ModuleScripts


ROOT = Path(__file__).resolve().parents[1]


class AppGraphTests(unittest.TestCase):
    def test_real_app_references_are_valid(self):
        self.assertEqual(check_app_shell(ROOT), [])

    def test_module_scripts_include_dynamic_inline_and_external_roots(self):
        parser = ModuleScripts()
        parser.feed('<script type="module" src="./main.js"></script>'
                    '<script>const ignore = 1;</script>'
                    '<script type="module">await import("./tests.js");</script>')
        self.assertEqual(parser.sources, ["./main.js"])
        self.assertEqual(parser.inline, ['await import("./tests.js");'])

    def test_local_imports_check_files_and_support_queries_and_fragments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            importer = root / "app" / "main.js"
            importer.parent.mkdir()
            target = importer.parent / "helper.js"
            target.write_text("export const value = 1;", encoding="utf-8")
            errors = []
            self.assertEqual(local_module(root, importer, "./helper.js?v=1#part", errors), target)
            self.assertEqual(local_module(root, importer, "/app/helper.js", errors), target)
            self.assertEqual(errors, [])
            for invalid in ("./missing.js", "../", "../../outside.js", "bare-package"):
                self.assertIsNone(local_module(root, importer, invalid, errors))
            self.assertEqual(len(errors), 4)

    def test_external_module_urls_are_not_fetched(self):
        errors = []
        self.assertIsNone(local_module(ROOT, ROOT / "app/index.html", "https://example.test/module.js", errors))
        self.assertEqual(errors, [])

    def test_missing_app_reports_errors_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as directory:
            errors = check_app_shell(directory)
            self.assertIn("app/index.html: missing app-shell file", errors)
            self.assertIn("app/js/app.js: missing app-shell file", errors)

    def test_pickup_service_and_view_must_exist_and_be_reachable(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            modules = ("js/pickup.js", "views/pickup.js")
            errors = check_app_shell(directory)
            for name in modules:
                self.assertIn(f"app/{name}: missing app-shell file", errors)
                module = app / name
                module.parent.mkdir(parents=True, exist_ok=True)
                module.write_text("export const fixture = true;", encoding="utf-8")

            errors = check_app_shell(directory)
            for name in modules:
                self.assertNotIn(f"app/{name}: missing app-shell file", errors)
                self.assertIn(f"app/{name}: unreachable from app/index.html", errors)

    def test_html_assets_and_skip_anchor_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            app.mkdir()
            (app / "index.html").write_text(
                '<title>Fixture</title><link rel="stylesheet" href="missing.css">'
                '<a href="#missing-main">Skip</a>', encoding="utf-8")
            errors = check_app_shell(directory)
            self.assertIn("app/index.html: missing local asset missing.css", errors)
            self.assertIn("app/index.html: missing anchor #missing-main", errors)


if __name__ == "__main__":
    unittest.main()
