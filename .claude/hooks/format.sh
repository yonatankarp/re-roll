#!/bin/bash
# PostToolUse on Edit/Write: format the edited file with the project's Prettier, as `npm run format` would.
file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] && [ -f "$file" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$file" in "$root"/*) ;; *) exit 0 ;; esac # only files in this checkout
cd "$root" || exit 0
PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$PATH" \
  npx --no-install prettier --write --ignore-unknown --log-level warn "$file" >&2 || true
exit 0
