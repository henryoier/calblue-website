#!/usr/bin/env bash
set -euo pipefail

site_dir="$(cd "$(dirname "$0")" && pwd)"
port="${1:-8080}"

cd "$site_dir"
echo "CalBlue preview: http://localhost:${port}"
python3 -m http.server "$port"
