#!/bin/bash
# PreToolUse: book content in private/ stays out of git, and Claude writes only data files there
# (ids, names and numbers in YAML or JSON, plus images), never prose.
input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
block() { echo "Blocked by .claude/hooks/guard-private.sh: $1" >&2; exit 2; }

if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
  if grep -qE 'git[^|;&]*\badd\b[^|;&]*(-f\b|--force)' <<<"$cmd" && grep -q 'private' <<<"$cmd"; then
    block "private/ holds book content and must never be added to git."
  fi
  exit 0
fi

file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
[ -n "$file" ] || exit 0
# private/ at this checkout's root, or at a worktree's root under .claude/worktrees (not /private/tmp and the like).
rel="${file#"$root"/}"
[ "$rel" != "$file" ] || exit 0
rel=$(sed -E 's#^\.claude/worktrees/[^/]+/##' <<<"$rel")
case "$rel" in
  private/*.yaml | private/*.yml | private/*.json | private/*.png | private/*.jpg | private/*.jpeg | private/*.webp) exit 0 ;;
  private/*) block "only data files (YAML, JSON, images) may be written under private/, never book prose." ;;
esac
exit 0
