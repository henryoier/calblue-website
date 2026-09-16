from contextlib import redirect_stderr, redirect_stdout
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import build_migrations as migrations


RULER = "-- " + "=" * 69


def fixture(section_numbers=range(11), preamble="create extension if not exists pgcrypto;"):
    sections = [f"{RULER}\n-- {number}. Section {number}\n{RULER}\nSELECT {number};"
                for number in section_numbers]
    return "-- Fixture source\n" + preamble + "\n\n" + "\n\n".join(sections) + "\n"


class SectionParserTest(unittest.TestCase):
    def test_default_build_emits_only_core_and_excludes_future_sections(self):
        generated = migrations.build(source_text=fixture())
        self.assertEqual(list(generated), ["0001_core.sql"])
        self.assertIn("SELECT 3;", generated["0001_core.sql"])
        self.assertNotIn("SELECT 4;", generated["0001_core.sql"])
        self.assertNotIn("SELECT 9;", generated["0001_core.sql"])

    def test_explicit_targets_are_deduplicated_in_plan_order(self):
        targets = ["0003_rls.sql", "0001_core.sql", "0003_rls.sql"]
        generated = migrations.build(targets, fixture())
        self.assertEqual(list(generated), ["0001_core.sql", "0003_rls.sql"])
        self.assertIn("SELECT 7;", generated["0003_rls.sql"])
        self.assertNotIn("SELECT 8;", generated["0003_rls.sql"])
        self.assertNotIn("create extension", generated["0003_rls.sql"])

    def test_core_only_source_does_not_require_unselected_future_sections(self):
        self.assertEqual(list(migrations.build(source_text=fixture(range(4)))), ["0001_core.sql"])

    def test_missing_required_terminal_section_fails(self):
        with self.assertRaisesRegex(migrations.SchemaError, "missing required sections.*3"):
            migrations.build(source_text=fixture(range(3)))

    def test_missing_middle_banner_is_not_silently_merged(self):
        with self.assertRaisesRegex(migrations.SchemaError, "missing section banners.*2"):
            migrations.parse_sections(fixture([0, 1, 3, 4]))

    def test_duplicate_banner_fails(self):
        with self.assertRaisesRegex(migrations.SchemaError, "duplicate section 1"):
            migrations.parse_sections(fixture([0, 1, 1, 2, 3]))

    def test_out_of_order_banners_fail(self):
        with self.assertRaisesRegex(migrations.SchemaError, "out of order"):
            migrations.parse_sections(fixture([0, 2, 1, 3]))

    def test_absent_banners_fail_cleanly(self):
        with self.assertRaisesRegex(migrations.SchemaError, "no numbered section banners"):
            migrations.parse_sections("-- no sections\n")

    def test_section_zero_must_come_first(self):
        with self.assertRaisesRegex(migrations.SchemaError, "section 0 must be the first"):
            migrations.parse_sections(fixture([1, 2, 3]))

    def test_malformed_banner_and_missing_ruler_fail(self):
        malformed = fixture().replace("-- 2. Section 2", "-- 2 Section 2")
        with self.assertRaisesRegex(migrations.SchemaError, "malformed numbered"):
            migrations.parse_sections(malformed)
        missing_ruler = fixture().replace(RULER + "\n-- 2.", "-- 2.")
        with self.assertRaisesRegex(migrations.SchemaError, "preceding ruler"):
            migrations.parse_sections(missing_ruler)

    def test_decimal_subsections_are_not_top_level_banners(self):
        text = fixture().replace("SELECT 5;", "-- 5.1 A subsection\nSELECT 5;")
        self.assertEqual(set(migrations.parse_sections(text)), set(range(11)) | {"_preamble"})

    def test_multiline_uppercase_extension_and_header_are_preserved(self):
        preamble = "-- extension note\nCREATE EXTENSION\n  IF NOT EXISTS citext;"
        output = migrations.build(source_text=fixture(preamble=preamble))["0001_core.sql"]
        self.assertIn(preamble, output)
        self.assertLess(output.index("BEGIN;"), output.index("CREATE EXTENSION"))

    def test_missing_or_unterminated_extension_fails(self):
        for preamble in ("-- no extension", "create extension citext"):
            with self.subTest(preamble=preamble):
                with self.assertRaisesRegex(migrations.SchemaError, "no complete CREATE EXTENSION"):
                    migrations.parse_sections(fixture(preamble=preamble))

    def test_transaction_wrapper_drift_command_and_deterministic_output(self):
        first = migrations.build(source_text=fixture())["0001_core.sql"]
        self.assertEqual(first, migrations.build(source_text=fixture())["0001_core.sql"])
        self.assertEqual(first.count("BEGIN;"), 1)
        self.assertTrue(first.endswith("COMMIT;\n"))
        self.assertIn("not replay-idempotent", first)
        self.assertIn("scripts/build_migrations.py --check --target 0001_core.sql", first)
        self.assertNotIn("scripts/check_sql.py --check", first)

    def test_unknown_and_empty_target_lists_fail(self):
        for targets in ([], ["not-a-migration.sql"]):
            with self.assertRaises(migrations.SchemaError):
                migrations.build(targets, fixture())


class GenerationCommandTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.source = root / "schema.sql"
        self.source.write_text(fixture(), encoding="utf-8")
        self.output = root / "not-created" / "migrations"
        patcher = mock.patch.multiple(migrations, SOURCE=self.source, OUT_DIR=self.output)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_command(self, arguments):
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            result = migrations.main(arguments)
        return result, output.getvalue()

    def test_missing_required_file_fails_check_without_creating_directories(self):
        code, output = self.run_command(["--check"])
        self.assertEqual(code, 1)
        self.assertIn("required migration is missing", output)
        self.assertFalse(self.output.parent.exists())

    def test_default_generation_writes_only_core_and_is_reproducible(self):
        self.assertEqual(self.run_command([])[0], 0)
        self.assertEqual([path.name for path in self.output.iterdir()], ["0001_core.sql"])
        path = self.output / "0001_core.sql"
        previous = (path.read_bytes(), path.stat().st_mtime_ns)
        self.assertEqual(self.run_command([])[0], 0)
        self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), previous)
        self.assertEqual(self.run_command(["--check"])[0], 0)

    def test_explicit_repeatable_selection_does_not_write_other_targets(self):
        arguments = ["--target", "0003_rls.sql", "--target", "0002_money.sql"]
        self.assertEqual(self.run_command(arguments)[0], 0)
        self.assertEqual({path.name for path in self.output.iterdir()}, {"0002_money.sql", "0003_rls.sql"})
        self.assertEqual(self.run_command(["--check", *arguments])[0], 0)
        self.assertEqual(self.run_command(["--check"])[0], 1)  # Landed core is still required by default.

    def test_check_does_not_repair_a_drifted_file(self):
        self.run_command([])
        path = self.output / "0001_core.sql"
        path.write_text("drifted\n", encoding="utf-8")
        before = path.stat().st_mtime_ns
        code, output = self.run_command(["--check"])
        self.assertEqual(code, 1)
        self.assertIn("has drifted", output)
        self.assertEqual(path.read_text(), "drifted\n")
        self.assertEqual(path.stat().st_mtime_ns, before)

    def test_existing_future_file_is_not_selected_or_rewritten_by_default(self):
        self.output.mkdir(parents=True)
        future = self.output / "0002_money.sql"
        future.write_text("unrelated future content\n", encoding="utf-8")
        self.assertEqual(self.run_command([])[0], 0)
        self.assertEqual(self.run_command(["--check"])[0], 0)
        self.assertEqual(future.read_text(), "unrelated future content\n")

    def test_invalid_source_fails_before_any_write(self):
        self.source.write_text("-- missing sections\n", encoding="utf-8")
        code, output = self.run_command([])
        self.assertEqual(code, 1)
        self.assertIn("no numbered section banners", output)
        self.assertFalse(self.output.parent.exists())


if __name__ == "__main__":
    unittest.main()
