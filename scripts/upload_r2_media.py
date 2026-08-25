#!/usr/bin/env python3
"""Upload generated gallery media to Cloudflare R2 using its S3 API."""

from __future__ import annotations

import argparse
import mimetypes
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(".media-build"))
    parser.add_argument("--env-file", type=Path, default=Path(".env.r2"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--workers", type=int, default=6)
    return parser.parse_args()


def load_environment(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def main() -> int:
    args = parse_args()
    load_environment(args.env_file)
    account_id = required_environment("R2_ACCOUNT_ID")
    bucket = required_environment("R2_BUCKET")
    access_key = required_environment("AWS_ACCESS_KEY_ID")
    secret_key = required_environment("AWS_SECRET_ACCESS_KEY")
    endpoint = os.environ.get("R2_ENDPOINT", f"https://{account_id}.r2.cloudflarestorage.com")

    files = sorted(path for path in args.source.rglob("*") if path.is_file())
    if not files:
        raise SystemExit(f"No generated media found under {args.source}")

    if args.dry_run:
        for path in files:
            print(path.relative_to(args.source).as_posix())
        print(f"Would upload {len(files)} files to {bucket}")
        return 0

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )

    def upload(path: Path) -> None:
        key = path.relative_to(args.source).as_posix()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        client.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        print(key)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        list(executor.map(upload, files))

    print(f"Uploaded {len(files)} files to {bucket}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
