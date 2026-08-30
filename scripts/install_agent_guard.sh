#!/bin/sh
# Install the versioned CalBlue guard into this clone's shared hooks directory.
#
# This deliberately refuses to overwrite unrelated hooks. All worktrees for a clone share the
# same hooks directory, while their ownership settings and lease files remain worktree-local.

set -eu

repo_root=$(git rev-parse --show-toplevel)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
hooks_dir="$common_dir/hooks"
guard_source="$repo_root/scripts/agent_guard.py"

custom_hooks=$(git config --get core.hooksPath || true)
if [ -n "$custom_hooks" ]; then
  case "$custom_hooks" in
    "$hooks_dir"|.git/hooks) ;;
    *)
      echo "agent guard: core.hooksPath is set to '$custom_hooks'; unset it before installing" >&2
      exit 1
      ;;
  esac
fi

mkdir -p "$hooks_dir"
install -m 0755 "$guard_source" "$hooks_dir/agent-guard.py"

install_hook() {
  hook_name=$1
  command=$2
  target="$hooks_dir/$hook_name"
  if [ -e "$target" ] && ! grep -q "agent-guard.py" "$target"; then
    echo "agent guard: refusing to overwrite existing $target" >&2
    exit 1
  fi
  temp_file=$(mktemp "$hooks_dir/$hook_name.XXXXXX")
  {
    echo '#!/bin/sh'
    echo '# CalBlue managed agent guard'
    printf '%s\n' "$command"
  } > "$temp_file"
  chmod 0755 "$temp_file"
  mv "$temp_file" "$target"
}

install_hook pre-commit 'exec python3 "$(git rev-parse --path-format=absolute --git-common-dir)/hooks/agent-guard.py" check'
install_hook pre-push 'exec python3 "$(git rev-parse --path-format=absolute --git-common-dir)/hooks/agent-guard.py" check-push'

echo "Installed CalBlue agent guard in $hooks_dir"
