#!/usr/bin/env python3
"""Annotate PR titles with stack step, issue, and which agent did the work.

    python3 .gh/label_prs.py           # preview
    python3 .gh/label_prs.py --apply   # rename

Title format:  [cc][03][#25] Original title

Several agents open PRs into the same stack here. The agent tag is taken from the branch-name suffix
the agent itself chose (`-codex`, `-muse`), not guessed from the commit author — every PR is authored
by the same GitHub account, so authorship tells you nothing. Branches with no suffix are Claude Code.

Idempotent: an existing annotation is replaced rather than stacked up.
"""
import re, sys
sys.path.insert(0, ".gh")
from api import api
from status import collect, RESOLVES, PARTOF, linked_numbers

# A keyword only counts as a link when it *begins* a line, after any markdown decoration.
# Mid-sentence mentions are prose: a PR that documents the convention ("PR body says `Closes #N`")
# would otherwise be read as closing whatever issue the example names. That actually happened.
LEAD = re.compile(r"^[\s>*_\-`#]*")


def primary_issues(body, pattern):
    for line in body.splitlines():
        stripped = line[LEAD.match(line).end():]
        m = pattern.match(stripped)          # match, not search: must be at the start
        if m:
            nums = list(linked_numbers(stripped, pattern))
            if nums:
                return nums
    return []

AGENT_BY_SUFFIX = {"codex": "codex", "muse": "muse"}
PREFIX = re.compile(r"^(?:\[[^\]]{1,12}\])+\s*")


def agent_of(branch):
    for suffix, name in AGENT_BY_SUFFIX.items():
        if branch.endswith("-" + suffix):
            return name
    return "cc"


def steps(prs):
    """Depth in the base chain; forks are ordered by PR number."""
    by_head = {p["head"]["ref"]: p for p in prs}
    depth = {}

    def d(pr):
        if pr["number"] in depth:
            return depth[pr["number"]]
        parent = by_head.get(pr["base"]["ref"])
        depth[pr["number"]] = (d(parent) + 1) if parent else 1
        return depth[pr["number"]]

    for p in prs:
        d(p)
    order = sorted(prs, key=lambda p: (depth[p["number"]], p["number"]))
    return {p["number"]: i + 1 for i, p in enumerate(order)}, depth


def main():
    issues, all_prs, links = collect()
    prs = [p for p in all_prs if p["state"] == "open"]
    step, _ = steps(prs)

    # issue number each PR resolves, from its own body
    issue_of = {}
    for p in prs:
        body = p.get("body") or ""
        # use status.py's clause parser rather than a second, divergent implementation
        # use status.py's clause parser rather than a second, divergent implementation
        res = primary_issues(body, RESOLVES) or primary_issues(body, PARTOF)
        issue_of[p["number"]] = [int(x) for x in dict.fromkeys(res)]

    for p in sorted(prs, key=lambda x: step[x["number"]]):
        n = p["number"]
        agent = agent_of(p["head"]["ref"])
        issues_for = issue_of[n]
        if not issues_for:
            ref = "no issue"
        elif len(issues_for) == 1:
            ref = f"#{issues_for[0]}"
        else:
            ref = f"#{issues_for[0]}+{len(issues_for) - 1}"
        bare = PREFIX.sub("", p["title"]).strip()
        new = f"[{agent}][{step[n]:02d}][{ref}] " + bare

        # Only rename our own PRs. The other agents self-label in their titles; overwriting that
        # would be a rename war, and mislabelling somebody else's work is worse than not labelling
        # it. --all overrides if a human decides otherwise.
        mine = agent == "cc"
        skip = "" if (mine or "--all" in sys.argv) else "   [other agent — left alone]"
        multi = f"   ⚠️ spans {len(issues_for)} issues" if len(issues_for) > 1 else ""
        print(f"  #{n:<3} {new if not skip else p['title'][:70]}{skip}{multi}")
        if "--apply" in sys.argv and (mine or "--all" in sys.argv) and new != p["title"]:
            api("PATCH", f"/pulls/{n}", {"title": new})
    if "--apply" not in sys.argv:
        print("\npreview only — pass --apply to rename")


if __name__ == "__main__":
    main()
