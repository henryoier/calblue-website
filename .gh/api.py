"""Minimal GitHub REST helper. Uses curl because this machine's Python has no CA bundle."""
import json, subprocess, os

REPO = "henryoier/calblue-website"

def _token():
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line[9:]
    raise SystemExit("no github credential in keychain")

TOK = None

def api(method, path, body=None, full=False):
    global TOK
    if TOK is None:
        TOK = _token()
    url = path if full else f"https://api.github.com/repos/{REPO}{path}"
    cmd = ["curl", "-sS", "-X", method, url,
           "-H", f"Authorization: Bearer {TOK}",
           "-H", "Accept: application/vnd.github+json"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        return {"_raw": out[:300]}
