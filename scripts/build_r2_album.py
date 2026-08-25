#!/usr/bin/env python3
"""Build thumbnail and full-resolution JPEGs for one R2 gallery album."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener


SUPPORTED_EXTENSIONS = {".heic", ".heif", ".jpg", ".jpeg", ".png"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", required=True, help="Album slug, such as tiger or btg")
    parser.add_argument("--source", required=True, type=Path, help="Folder containing original images")
    parser.add_argument("--output", type=Path, default=Path(".media-build"), help="Generated media root")
    parser.add_argument("--expected", type=int, help="Fail unless this many images are found")
    parser.add_argument("--limit", type=int, help="Build only the first N images after filename sorting")
    parser.add_argument("--thumbnail-max", type=int, default=1200)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    register_heif_opener()

    source_files = sorted(
        path
        for path in args.source.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if args.limit is not None:
        if args.limit < 1:
            raise SystemExit("--limit must be at least 1")
        if len(source_files) < args.limit:
            raise SystemExit(f"Requested {args.limit} images, found only {len(source_files)} in {args.source}")
        source_files = source_files[: args.limit]

    if args.expected is not None and len(source_files) != args.expected:
        raise SystemExit(f"Expected {args.expected} selected images, found {len(source_files)} in {args.source}")

    thumbnail_dir = args.output / "gallery" / args.slug / "thumb"
    full_dir = args.output / "gallery" / args.slug / "full"
    thumbnail_dir.mkdir(parents=True, exist_ok=True)
    full_dir.mkdir(parents=True, exist_ok=True)

    for index, source_path in enumerate(source_files, 1):
        number = f"{index:03d}"
        with Image.open(source_path) as source_image:
            full_image = ImageOps.exif_transpose(source_image).convert("RGB")
            full_image.save(
                full_dir / f"{number}.jpg",
                "JPEG",
                quality=94,
                optimize=True,
                subsampling=0,
            )

            thumbnail = full_image.copy()
            thumbnail.thumbnail((args.thumbnail_max, args.thumbnail_max), Image.Resampling.LANCZOS)
            thumbnail.save(
                thumbnail_dir / f"{number}.jpg",
                "JPEG",
                quality=86,
                optimize=True,
                subsampling=1,
            )

        print(f"{args.slug}: {number}/{len(source_files)} {source_path.name}")

    print(f"Built {len(source_files)} images for {args.slug} in {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
