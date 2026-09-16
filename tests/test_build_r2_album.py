from __future__ import annotations

import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, patch


class BuildR2AlbumTest(unittest.TestCase):
    def setUp(self) -> None:
        # Exercise selection and numbering without requiring media codecs in CI.
        pil = types.ModuleType("PIL")
        pil.Image = MagicMock()
        pil.ImageOps = MagicMock()
        heif = types.ModuleType("pillow_heif")
        heif.register_heif_opener = MagicMock()
        script = Path(__file__).resolve().parents[1] / "scripts" / "build_r2_album.py"
        spec = importlib.util.spec_from_file_location("build_r2_album_test_subject", script)
        self.builder = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"PIL": pil, "pillow_heif": heif}):
            spec.loader.exec_module(self.builder)
        self.image = pil.Image
        self.full_image = pil.ImageOps.exif_transpose.return_value.convert.return_value
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.output = self.root / "output"
        for name in ("z.jpg", "a.HEIC", "b.MOV", "c.mp4"):
            (self.source / name).touch()
        (self.source / "nested.jpg").mkdir()

    def run_builder(self, *extra: str) -> int:
        argv = [
            "build_r2_album.py", "--slug", "test-album",
            "--source", str(self.source), "--output", str(self.output), *extra,
        ]
        with patch.object(sys, "argv", argv), patch("sys.stdout", new=io.StringIO()):
            return self.builder.main()

    def test_append_numbers_only_sorted_images_and_preserves_old_files(self) -> None:
        for variant in ("full", "thumb"):
            old_file = self.output / "gallery" / "test-album" / variant / "001.jpg"
            old_file.parent.mkdir(parents=True)
            old_file.write_bytes(b"existing image")

        self.assertEqual(self.run_builder("--start-index", "62", "--expected", "2"), 0)
        self.assertEqual(
            [call.args[0].name for call in self.image.open.call_args_list],
            ["a.HEIC", "z.jpg"],
        )
        for variant, image in (("full", self.full_image), ("thumb", self.full_image.copy.return_value)):
            self.assertEqual(
                [call.args[0] for call in image.save.call_args_list],
                [self.output / "gallery" / "test-album" / variant / name for name in ("062.jpg", "063.jpg")],
            )
            self.assertEqual(
                (self.output / "gallery" / "test-album" / variant / "001.jpg").read_bytes(),
                b"existing image",
            )

    def test_default_numbering_starts_at_one(self) -> None:
        self.run_builder()
        self.assertEqual(
            [call.args[0].name for call in self.full_image.save.call_args_list],
            ["001.jpg", "002.jpg"],
        )

    def test_start_index_must_be_positive(self) -> None:
        for value in ("0", "-1"):
            with self.subTest(value=value), self.assertRaisesRegex(SystemExit, "--start-index must be at least 1"):
                self.run_builder("--start-index", value)
        self.image.open.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_expected_count_excludes_videos(self) -> None:
        with self.assertRaisesRegex(SystemExit, "Expected 3 selected images, found 2"):
            self.run_builder("--expected", "3")
        self.image.open.assert_not_called()

    def test_limit_still_applies_after_sorting(self) -> None:
        self.run_builder("--start-index", "99", "--limit", "1", "--expected", "1")
        self.assertEqual(self.image.open.call_args.args[0].name, "a.HEIC")
        self.assertEqual(self.full_image.save.call_args.args[0].name, "099.jpg")


if __name__ == "__main__":
    unittest.main()
