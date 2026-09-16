from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from scripts.check_no_build import check_repository, import_problems, module_specifiers, repository_files


class ImportChecksTest(unittest.TestCase):
    def problems(self, source):
        return list(import_problems(Path("app/js/example.js"), source))

    def test_multiline_import_and_reexport(self):
        source = '''import {
  thing,
} from "react";
export {
  thing,
} from "./missing-extension";
export * as alias from "../also-missing";
'''
        self.assertEqual(list(module_specifiers(source)), [
            (1, "react"), (4, "./missing-extension"), (7, "../also-missing"),
        ])
        self.assertEqual(len(self.problems(source)), 3)

    def test_side_effect_and_literal_dynamic_imports(self):
        source = '''import "react";
const one = import("./missing");
const two = import(`another-package`);
const three = import("./missing-too", { with: { type: "json" } });'''
        self.assertEqual(len(self.problems(source)), 4)

    def test_browser_paths_queries_and_external_urls(self):
        source = '''import thing from "./dom.js"; // an explanatory comment
import "../side-effect.js?v=2#part";
export * from "/app/shared.js";
import("https://cdn.example.test/library/+esm");
import("//cdn.example.test/module.js");'''
        self.assertEqual(self.problems(source), [])

    def test_comments_and_quoted_examples_are_not_imports(self):
        source = '''// import "react";
/* export * from "package"; */
const example = 'import "pretend";';
const another = `import "also-pretend";`;
thing.import("not-a-module");
const metadata = import.meta.url;'''
        self.assertEqual(list(module_specifiers(source)), [])

    def test_comments_between_module_tokens(self):
        source = '''import /* context */ {
  something,
} /* context */ from /* context */ "package";
import /* context */ ( /* context */ "./no-extension" );'''
        self.assertEqual(len(self.problems(source)), 2)

    def test_computed_imports_are_left_for_review(self):
        source = '''import(url);
import("./" + moduleName);
import(`https://cdn.example.test/${version}/+esm`);'''
        self.assertEqual(list(module_specifiers(source)), [])

    def test_missing_extensions_and_misleading_dot_prefix(self):
        self.assertEqual(len(self.problems('''import "./module";
import "../module.json";
import ".package";
import "/app/module";''')), 4)

    def test_escaped_quote_does_not_expose_a_fake_import(self):
        source = r'''const example = 'it\'s not an import("react")';
import "./real.js";'''
        self.assertEqual(list(module_specifiers(source)), [(2, "./real.js")])


class RepositoryChecksTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True)

    def write(self, relative, content=""):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_staged_and_visible_untracked_files_are_checked(self):
        self.write("app/js/tracked.js", 'import "staged-package";')
        subprocess.run(["git", "add", "app/js/tracked.js"], cwd=self.root, check=True)
        self.write("new folder/package.json", "{}")
        self.write("app/js/untracked.js", 'import "new-package";')
        problems, count = check_repository(self.root)
        self.assertEqual(count, 3)
        self.assertEqual(len(problems), 3)
        self.assertTrue(any("staged-package" in problem for problem in problems))
        self.assertTrue(any("new folder/package.json" in problem for problem in problems))

    def test_ignored_untracked_files_are_excluded(self):
        self.write(".gitignore", "ignored/\n")
        self.write("ignored/package.json", "{}")
        self.assertEqual(repository_files(self.root), [Path(".gitignore")])

    def test_git_paths_are_not_quoted_or_split_on_whitespace(self):
        self.write("app/js/snow 雪\nexample.js", 'import "react";')
        problems, count = check_repository(self.root)
        self.assertEqual(count, 1)
        self.assertEqual(len(problems), 1)

    def test_modern_manifests_config_variants_and_output_directories(self):
        paths = ["bun.lock", "deno.jsonc", "npm-shrinkwrap.json", "pnpm-workspace.yaml",
                 "vite.config.mjs", "webpack.config.cjs", "next.config.ts", "astro.config.mts",
                 "tsconfig.app.json", "dist/output.js", "app/node_modules/pkg/module.js"]
        for path in paths:
            self.write(path)
        problems, count = check_repository(self.root)
        self.assertEqual(count, len(paths))
        self.assertEqual(len(problems), len(paths))

    def test_removed_tracked_javascript_does_not_crash(self):
        path = self.write("app/js/removed.js", 'import "react";')
        subprocess.run(["git", "add", "app/js/removed.js"], cwd=self.root, check=True)
        path.unlink()
        self.assertEqual(check_repository(self.root), ([], 1))

    def test_command_anchors_to_its_repository_not_working_directory(self):
        script = self.root / "scripts" / "check_no_build.py"
        script.parent.mkdir()
        shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts/check_no_build.py", script)
        self.write("package.json", "{}")
        nested = self.root / "unrelated" / "nested"
        nested.mkdir(parents=True)
        result = subprocess.run([sys.executable, str(script)], cwd=nested,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("package.json: build-tooling file", result.stdout)


if __name__ == "__main__":
    unittest.main()
