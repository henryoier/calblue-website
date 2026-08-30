#!/bin/sh
# Create an isolated worktree for one agent, wired up to the local agent guard.
#
#     scripts/agent_worktree.sh <agent> <slug> [base]
#     scripts/agent_worktree.sh cc migration-core
#     scripts/agent_worktree.sh muse game-list feat/app-shell-codex
#
# Produces  ~/calblue-wt-<slug>-<agent>  on  feat/<slug>-<agent>, then configures and claims it so
# .git/hooks/agent-guard.py will allow commits there.
#
# The guard is the enforcement mechanism; this is just the correct way to satisfy it. Doing these
# steps by hand is easy to get subtly wrong — in particular the branch must track its own remote
# ref, not origin/main, or the guard refuses every commit with a confusing message.

set -e

agent=$1
slug=$2
base=${3:-origin/main}

case "$agent" in
  cc|codex|muse) ;;
  *) echo "usage: $0 <cc|codex|muse> <slug> [base]" >&2; exit 2 ;;
esac
[ -n "$slug" ] || { echo "usage: $0 <cc|codex|muse> <slug> [base]" >&2; exit 2; }

dir="$HOME/calblue-wt-$slug-$agent"
branch="feat/$slug-$agent"
guard="$(git rev-parse --path-format=absolute --git-common-dir)/hooks/agent-guard.py"

[ -e "$dir" ] && { echo "$dir already exists — pick another slug, or reuse it." >&2; exit 1; }

git fetch --quiet origin
git worktree add -b "$branch" "$dir" "$base"

git -C "$dir" config calblue.agent "$agent"
git -C "$dir" config calblue.sessionId "$agent-$(date +%Y%m%d-%H%M%S)"
git -C "$dir" config calblue.allowedBranchRegex "^(chore|feat|fix)/.*-$agent\$"

# --no-verify only to bootstrap: the guard cannot pass until the upstream exists, and the upstream
# cannot exist until the first push. Nothing is committed at this point, so nothing is bypassed.
git -C "$dir" push --no-verify --quiet -u origin "$branch"

if [ -f "$guard" ]; then
  ( cd "$dir" && python3 "$guard" claim )
fi

echo
echo "  worktree : $dir"
echo "  branch   : $branch  (tracking origin/$branch)"
echo "  based on : $base"
echo "  agent    : $agent — claimed, commits allowed"
echo
echo "  cd $dir"
