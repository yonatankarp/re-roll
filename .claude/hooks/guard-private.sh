#!/bin/bash
# PreToolUse: book content in books/ stays out of git, and Claude writes only data files there
# (ids, names and numbers in YAML or JSON, plus images), never prose.
input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
block() { echo "Blocked by .claude/hooks/guard-private.sh: $1" >&2; exit 2; }

if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
  if grep -qE 'git[^|;&]*\badd\b[^|;&]*(-f\b|--force)' <<<"$cmd" && grep -qE 'books|private' <<<"$cmd"; then
    block "books/ holds book content and must never be added to git."
  fi
  exit 0
fi

file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
[ -n "$file" ] || exit 0
# books/ at this checkout's root, or at a worktree's root under .claude/worktrees (not /private/tmp and the like).
rel="${file#"$root"/}"
[ "$rel" != "$file" ] || exit 0
rel=$(sed -E 's#^\.claude/worktrees/[^/]+/##' <<<"$rel")
case "$rel" in
  books/*.yaml | books/*.yml | books/*.json | books/*.png | books/*.jpg | books/*.jpeg | books/*.webp) exit 0 ;;
  private/*) block "private/ is now books/; write to books/ instead." ;;
  books/*) block "only data files (YAML, JSON, images) may be written under books/, never book prose." ;;
esac
exit 0
