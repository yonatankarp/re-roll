#!/bin/bash
# PreToolUse: book content in books/ stays out of git, and Claude writes only data files there
# (ids, names and numbers in YAML or JSON, plus images), never prose.
# shortcut: a Bash redirect or script can still write to books/; the commit-time check is the backstop.
input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
block() { echo "Blocked by .claude/hooks/guard-private.sh: $1" >&2; exit 2; }

if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
  # Any forced add, since the path it forces in can be spelled many ways (., an absolute path, a glob).
  if grep -qE 'git[^|;&]*[[:space:]]add[[:space:]]([^|;&]*[[:space:]])?(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)' <<<"$cmd"; then
    block "git add -f can add the ignored books/ folder; add files by name without -f."
  fi
  # stash --all stashes ignored files too, books/ included, into the stash every checkout shares.
  if grep -qE 'git[^|;&]*[[:space:]]stash([[:space:]][^|;&]*)?[[:space:]](-[a-zA-Z]*a[a-zA-Z]*|--all)([[:space:]]|$)' <<<"$cmd"; then
    block "git stash --all would stash the ignored books/ folder; use -u instead."
  fi
  exit 0
fi

file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
[ -n "$file" ] || exit 0

# An absolute path with . and .. collapsed, through the real path of its deepest existing folder
# (unless asked for the lexical path only), and lowercased for case-insensitive disks.
resolve() {
  local path=$1 part out="" dir parts
  [[ $path = /* ]] || path="$root/$path"
  IFS=/ read -ra parts <<<"$path"
  for part in "${parts[@]}"; do
    case "$part" in
      "" | .) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$part" ;;
    esac
  done
  if [ "$2" != lexical ]; then
    dir="${out:-/}"
    while [ ! -d "$dir" ]; do dir="${dir%/*}"; dir="${dir:-/}"; done
    out="$(cd "$dir" && pwd -P)${out#"$dir"}"
  fi
  tr '[:upper:]' '[:lower:]' <<<"${out%/}"
}

# This checkout's books/ and the main checkout's, which a worktree can reach by absolute path.
main=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
main="${main%/.git}"
target=$(resolve "$file")
named=$(resolve "$file" lexical)
for checkout in "$root" ${main:+"$main"}; do
  # private/ is a link to books/ in older checkouts, so it's caught by name, not by where it leads.
  case "$named/" in
    "$(resolve "$checkout/private" lexical)"/*) block "private/ is now books/; write to books/ instead." ;;
  esac
  books=$(resolve "$checkout/books")
  case "$target" in
    "$books"/*.yaml | "$books"/*.yml | "$books"/*.json | "$books"/*.png | "$books"/*.jpg | "$books"/*.jpeg | "$books"/*.webp) ;;
    "$books" | "$books"/*) block "only data files (YAML, JSON, images) may be written under books/, never book prose." ;;
  esac
done
exit 0
