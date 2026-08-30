#!/usr/bin/env python3
"""Regenerate the status table in tracking issue #58 from live GitHub state.

    python3 .gh/status.py            # print the report
    python3 .gh/status.py --push     # print it and update issue #58

Status is derived, never hand-maintained: it reads the issues and pull requests and works out where
each item stands. Run it after opening or merging anything and the tracking issue stays honest.

An issue is linked to a PR by the PR body saying `Resolves #N` (the PR completes it) or `Part of #N`
(one of several PRs for that issue). Comma- or "and"-separated issue lists are accepted because
some existing stacked PRs cover several closely related issues.
"""

import re
import sys

sys.path.insert(0, ".gh")
from api import api  # noqa: E402
import plan  # noqa: E402

# GitHub's closing keywords, plus the conventions used across the agents working this repo.
# Several people/agents open PRs here and they do not all phrase it the same way, so match broadly.
RESOLVES = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+",
    re.I,
)
PARTOF = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*)?(?:part of|addresses|towards?|contributes to)\s+",
    re.I,
)
ISSUE_REF = re.compile(r"#(\d+)")
ISSUE_LIST = re.compile(
    r"#\d+(?:\s*(?:(?:,|&)\s*|and\s+)#\d+)*",
    re.I,
)


def linked_numbers(body, prefix):
    """Yield every issue in a keyword clause such as `Resolves #31, #32`."""
    for line in body.splitlines():
        match = prefix.match(line)
        if match:
            clause = ISSUE_LIST.match(line[match.end():])
            if clause:
                yield from ISSUE_REF.findall(clause.group(0))


def fetch_all(path):
    out, page = [], 1
    while True:
        batch = api("GET", f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")
        if not isinstance(batch, list) or not batch:
            return out
        out += batch
        page += 1


def collect():
    issues = {i["number"]: i for i in fetch_all("/issues?state=all") if "pull_request" not in i}
    prs = fetch_all("/pulls?state=all")
    # issue -> {pr_number: (pr, kind)}; a PR matching both patterns counts once, as "resolves"
    seen = {}
    for pr in prs:
        body = pr.get("body") or ""
        for pat, kind in ((PARTOF, "part"), (RESOLVES, "resolves")):
            for num in linked_numbers(body, pat):
                seen.setdefault(int(num), {})[pr["number"]] = (pr, kind)
    links = {issue: list(by_pr.values()) for issue, by_pr in seen.items()}
    return issues, prs, links


def pr_state(pr):
    if pr.get("merged_at"):
        return "merged"
    return "open" if pr["state"] == "open" else "closed"


def active_links(num, links):
    """Return reviewable or merged work, excluding abandoned pull requests.

    A closed, unmerged PR is historical context, not a satisfied dependency. This matters when a
    superseded implementation is abandoned during stack consolidation.
    """
    return [(pr, kind) for pr, kind in links.get(num, []) if pr_state(pr) != "closed"]


def has_active_pr(num, links):
    return bool(active_links(num, links))


def status_of(num, issues, links):
    issue = issues.get(num)
    if issue and issue["state"] == "closed":
        return "done"
    linked = links.get(num, [])
    if any(pr_state(pr) == "merged" for pr, k in linked if k == "resolves"):
        return "done"
    if any(pr_state(pr) == "open" for pr, _ in linked):
        return "in review"
    deps = plan.HARD[num]
    unmet = [d for d in deps if not has_active_pr(d, links)]
    if unmet:
        return "blocked"
    return "ready"


ICON = {"done": "✅", "in review": "🔵", "ready": "⚪", "blocked": "⏳"}


def build_report(issues, prs, links):
    wave = plan.wave_of()
    rows, counts = [], {"done": 0, "in review": 0, "ready": 0, "blocked": 0}
    for num in sorted(plan.SEQUENCE, key=lambda n: plan.SEQUENCE[n]):
        st = status_of(num, issues, links)
        counts[st] += 1
        title = issues.get(num, {}).get("title", f"#{num}")
        title = title.split("] ", 1)[1] if "] " in title[:6] else title
        prs_for = active_links(num, links)
        pr_txt = ", ".join(
            f"#{pr['number']}{'' if k == 'resolves' else ' (part)'}"
            f"{' ✔' if pr_state(pr) == 'merged' else ''}"
            for pr, k in sorted(prs_for, key=lambda x: x[0]["number"])
        ) or "—"
        deps = ", ".join(f"#{d}" for d in plan.HARD[num]) or "—"
        note = " ⚠️ needs a human" if num in plan.NEEDS_HUMAN and st != "done" else ""
        rows.append(f"| `{plan.SEQUENCE[num]:02d}` | {wave[num]} | {ICON[st]} {st} | #{num} | "
                    f"{title}{note} | {deps} | {pr_txt} |")

    next_up = [n for n in sorted(plan.SEQUENCE, key=lambda x: plan.SEQUENCE[x])
               if status_of(n, issues, links) == "ready"][:8]
    in_flight = [n for n in sorted(plan.SEQUENCE, key=lambda x: plan.SEQUENCE[x])
                 if status_of(n, issues, links) == "in review"]

    total = len(plan.SEQUENCE)
    lines = [
        "## Status",
        "",
        f"**{counts['done']} done · {counts['in review']} in review · "
        f"{counts['ready']} ready to start · {counts['blocked']} blocked** "
        f"— {counts['done']}/{total} complete.",
        "",
        "Generated by `.gh/status.py` from live issue and PR state — do not edit this section by "
        "hand. Re-run it after opening or merging anything.",
        "",
        "| Seq | Wave | Status | Issue | Title | Hard deps | PR |",
        "|---|---|---|---|---|---|---|",
        *rows,
        "",
        "✅ done · 🔵 in review · ⚪ ready (all hard deps have a PR) · ⏳ blocked",
        "",
        "### In review now",
        "",
    ]
    lines += [f"- #{n} — {issues.get(n, {}).get('title', '')}" for n in in_flight] or ["- nothing"]
    lines += ["", "### Next up (unblocked, in sequence order)", ""]
    lines += [f"- #{n} — {issues.get(n, {}).get('title', '')}" for n in next_up] or ["- nothing"]

    if plan.NEEDS_HUMAN:
        lines += ["", "### Needs a human", ""]
        for num, why in plan.NEEDS_HUMAN.items():
            if status_of(num, issues, links) != "done":
                lines.append(f"- #{num} — {why}")

    lines += ["", "### PR stack", "",
              "Each PR is based on the one above it, so they review top to bottom.", ""]
    by_num = {p["number"]: p for p in prs}
    for p in sorted(prs, key=lambda x: x["number"]):
        if p["state"] != "open":
            continue
        base = p["base"]["ref"]
        base_pr = next((q["number"] for q in prs if q["head"]["ref"] == base), None)
        lines.append(f"- #{p['number']} — {p['title']}  \n"
                     f"  base: {'#' + str(base_pr) if base_pr else '`' + base + '`'}")
    return "\n".join(lines)


def main():
    issues, prs, links = collect()
    report = build_report(issues, prs, links)
    print(report)
    if "--push" in sys.argv:
        issue = api("GET", f"/issues/{plan.TRACKING_ISSUE}")
        body = issue["body"]
        body = body.split("## Status")[0].rstrip() if "## Status" in body else body.rstrip()
        marker = "\n\n---\n\n"
        head, _, tail = body.partition("## Waves")
        new = report + "\n\n---\n\n" + ("## Waves" + tail if tail else body)
        api("PATCH", f"/issues/{plan.TRACKING_ISSUE}", {"body": new})
        print(f"\n-> pushed to issue #{plan.TRACKING_ISSUE}")


if __name__ == "__main__":
    main()
