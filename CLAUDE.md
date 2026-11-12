# Re-roll

A single-player D&D 5.5e game: an event-sourced TypeScript engine (`engine/`), a D&D system plugin (`plugins/systems/dnd5.5e/`), adventure and rules plugins (`plugins/`), and a Vite UI that also ships as a cross-platform Tauri app (`app/desktop`). The design is in `docs/technical-design.md`.

## Running things

- Node 26 comes from nvm and isn't on the default PATH. Prefix commands with `PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$PATH"`.
- Before you call work done, run `npm test`, `npm run lint` and `npm run typecheck` (four tsc projects), and make sure all three pass.
- `npm run ui` serves the game at http://127.0.0.1:5199/ with `strictPort`. A second checkout or worktree needs `npm run ui -- --port <other>`.
- `npm run test:ui` is a Playwright smoke test in Chromium against its own `npm run ui` on a free port. CI runs it as the `ui` job. Run `npx playwright install chromium` first if Playwright's browser isn't cached yet.
- `npm run bot -- [runs] [adventure] [--smart] [--rests] [--avoid-endings] [--difficulty=story|normal|hard]` plays adventures to measure balance. `--smart` fights and builds characters with the system's tactics, `--rests` rests whenever a scene allows, and `--avoid-endings` skips story choices that end the adventure while others remain. The targets are Story at or under about 25% defeats and Normal at 15–45%.
- `npm run play` plays in text without the UI.
- `npm run narrate -- <adventure> [--voice=…]` reads a book adventure's scenes aloud once with Kokoro-82M (needs `ffmpeg`), into its `narration/` folder. Run it from the main checkout, since a worktree's `books/` is only a copy. Clips missing there are read in the app.
- Saves replay logged inputs (`engine/run/save.ts`). Every player action must go through decisions and events, never through hidden UI state.
- Events and frames are append-only, since saves store them and load by folding them:
  - New payload fields are optional or have a default, so older saves still parse.
  - Never rename or remove an event kind or a frame kind, or reshape its payload. Add a new kind instead and keep the old handler.
  - Payloads carry outcomes (the rolled damage, the item found), never inputs that a reducer re-derives from the rules, so a rules change can't rewrite history.
  - A change that can't follow these rules raises `SAVE_FORMAT_VERSION` and adds an entry to `migrations` in `engine/run/save.ts`.
  - The golden saves in `tests/fixtures/saves/` (`*.json`) are frozen and must keep loading. Never regenerate one to make its test pass. A snapshot (`*.state.json`) may be rewritten with `node tests/golden-saves.ts --snapshots` after you review its diff, when the state changed on purpose.

## Book content: `books/`

- `books/` holds content imported from the owner's own books. It is its own **private** git repository, ignored by this one. Commit book content only there, never to this public repository.
- Only write ids, names and numbers there: coordinates, counts, monster ids, `onFlee` targets. Never write book prose of your own, and never copy book text into this repository, its issues or its docs.
- Never log in to or download from D&D Beyond.
- A git worktree has no `books/`. To play-test, symlink `~/Projects/re-roll/books` into it, and only one session at a time may write to the same files there.
- `private` is a temporary link to `books/` for older worktrees; new code uses `books/` only. The manifest field `distribution: private` keeps its name (it means not redistributable).

## Git

- Commit or push only when asked. Never add Co-Authored-By or other attribution lines to commits or PRs.
- Merge session branches with `--no-ff`, naming them `refs/heads/claude/...`.
- Run `git config core.hooksPath .githooks` once per clone. The pre-commit hook runs typecheck and lint and rejects staged `books/` or `private/` paths. It needs Node on PATH, so commit with the same `PATH=…` prefix.

## Sessions

Every side session is archived when its work is done, and leaves no worktree or branch behind, locally or on the remote.

- **A session that leaves nothing to merge** (a check, a review, a no-change result) archives itself as its last step.
- **A session that leaves a branch** commits there and reports. Once the branch is merged, the session that merged it deletes the worktree (`git worktree remove`) and the branch (`git branch -d`, plus `git push origin --delete` if it was pushed), and archives the finished session.

## Platforms

The game must not depend on any one OS. Don't use macOS-only (or Windows-only) features such as system voices or native-only APIs unless there is an equivalent everywhere. Prefer web platform features and bundled, cross-platform libraries. Tauri itself targets macOS, Windows and Linux.

## UI direction

- The game should feel like playing D&D, not a rules tool. Show only what the moment needs, put the rest in drawers or tabs, use transitions, and let the player act on the map by click or drag. The option list stays for keyboard players.
- The look is a Player's Handbook page: parchment, Solbera CC BY-SA fonts in `app/desktop/fonts/`, and a leather top bar. Keep it.
- Tauri's CSP blocks `<style>` elements, so the D&D board uses a constructed stylesheet (`adoptedStyleSheets`).
