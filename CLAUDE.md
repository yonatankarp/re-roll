# Re-roll

A single-player D&D 5.5e game: an event-sourced TypeScript engine (`engine/`), a D&D system plugin (`plugins/systems/dnd5.5e/`), adventure and rules plugins (`plugins/`), and a Vite UI that also ships as a cross-platform Tauri app (`app/desktop`). The design is in `docs/technical-design.md`.

## Running things

- Node 26 comes from nvm and isn't on the default PATH. Prefix commands with `PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$PATH"`.
- Don't run the test suites (`npm test`, `npm run test:ui`) locally. CI on GitHub runs them on Linux, Windows and macOS. Running the one test file you're changing is fine.
  - Before you call work done, merge `origin/main` into your branch and push it.
  - Then run CI on the branch with `gh workflow run ci.yml --ref <branch>`. A branch push alone doesn't start CI.
  - Merge into `main` only when that run passes. Watch it with `gh run list --branch <branch>`.
- The pre-commit hook runs `npm run typecheck` (four tsc projects) and `npm run lint`.
- Book-gated tests (every `*-books.test.ts`, the phb half of `tests/class-features.test.ts`, and the book parts of others) skip without `books/`, so public CI never runs them. `npm run test:books` runs the unit suite with `books/` loaded and fails if it's missing. It runs locally only, never in GitHub Actions: the private books repo's Actions minutes are too few, and a self-hosted runner is not allowed. A session that changes engine, plugin or test code runs it before merging and records the counts in its merge commit, for example `test:books: 176 passed, 0 failed`. That line is the last visible result.
- `npm run check-pack` and the balance sims need `books/`, which CI can't see, so run them locally. Before starting a sim, check that total CPU is under 700% (`ps -A -o %cpu | awk '{s+=$1} END {print s}'`).
- `npm run ui` serves the game at http://127.0.0.1:5199/ with `strictPort`. A second checkout or worktree needs `npm run ui -- --port <other>`.
- `npm run test:ui` runs the Playwright tests in Chromium and WebKit against the built game, served by `vite preview` on a free port with the CSP and headers from `tauri.conf.json`. CI runs each browser as a `ui` job. Tests import `test` from `tests/ui/fixtures.ts`, which fails a test on a CSP violation, a console error or an uncaught error. `--project=chromium` runs one browser. `tests/ui/visual.e2e.ts` compares screenshots with Linux baselines that only CI makes: when a screen changes on purpose, take the new ones from the failed `ui` job's `playwright-traces-<browser>` artifact, look at each, and commit them.
- `npm run bot -- [runs] [adventure] [--smart] [--rests] [--avoid-endings] [--difficulty=story|normal|hard]` plays adventures to measure balance. `--smart` fights and builds characters with the system's tactics, `--rests` rests whenever a scene allows, and `--avoid-endings` skips story choices that end the adventure while others remain. The targets are Story at or under about 25% defeats and Normal at 15–45%, reached through the engine, tactics and difficulty settings, never by editing book content.
- `npm run play` plays in text without the UI.
- `npm run narrate -- <adventure> [--voice=…]` reads a book adventure's scenes aloud once with Kokoro-82M (needs `ffmpeg`), into its `narration/` folder. Run it from the main checkout, since a worktree's `books/` is only a copy. Clips missing there are read in the app.
- Saves replay logged inputs (`engine/run/save.ts`). Every player action must go through decisions and events, never through hidden UI state.
- Events and frames are append-only, since saves store them and load by folding them:
  - New payload fields are optional or have a default, so older saves still parse.
  - Never rename or remove an event kind or a frame kind, or reshape its payload. Add a new kind instead and keep the old handler.
  - `tests/fixtures/kinds.json` locks every kind and each event's payload fields (`tests/save-kinds.test.ts`). Add a new kind to its `kinds`, to `notInGoldens` until a golden save holds it, and an event's fields to `fields`, with `?` on optional ones.
  - Payloads carry outcomes (the rolled damage, the item found), never inputs that a reducer re-derives from the rules, so a rules change can't rewrite history.
  - A change that can't follow these rules raises `SAVE_FORMAT_VERSION` and adds an entry to `migrations` in `engine/run/save.ts`.
  - The golden saves in `tests/fixtures/saves/` (`*.json`) are frozen and must keep loading. Never regenerate one to make its test pass. A snapshot (`*.state.json`) may be rewritten with `node tests/golden-saves.ts --snapshots` after you review its diff, when the state changed on purpose.

## Book content: `books/`

- `books/` holds content imported from the owner's own books. It is its own **private** git repository, ignored by this one. Commit book content only there, never to this public repository.
- Never change what the book says. Encounters keep the book's printed monsters and counts, and levels and level-ups stay where the book puts them. Never trim or retune book content for balance; balance belongs to the engine and the difficulty settings.
- Only write ids, names and numbers there: coordinates, counts, monster ids, `onFlee` targets. Never write book prose of your own, and never copy book text into this repository, its issues or its docs.
- Never log in to or download from D&D Beyond.
- A git worktree has no `books/`. To play-test, symlink `~/Projects/re-roll/books` into it, and only one session at a time may write to the same files there.
- The manifest field `distribution: private` means not redistributable; it has nothing to do with a folder.
- The game plays 2024 (5.5e) rules. A 2014 entry that has a 2024 version is reference text linked to that version, so don't encode it again or bend a 2024 schema to fit it. 2014 books include Basic Rules 2014, Xanathar's and Sword Coast Guide. Only 2014 entries with no 2024 version play.

## Git

- Commit or push only when asked. Never add Co-Authored-By or other attribution lines to commits or PRs.
- Merge session branches straight into `main` with `--no-ff`, naming them `refs/heads/claude/...`. There is no integration branch; never recreate `feat/foundations`.
- Run `git config core.hooksPath .githooks` once per clone. The pre-commit hook runs typecheck and lint and rejects staged `books/` paths. It needs Node on PATH, so commit with the same `PATH=…` prefix.

## Sessions

Every side session is archived when its work is done, and leaves no worktree or branch behind, locally or on the remote.

- **A session that leaves nothing to merge** (a check, a review, a no-change result) archives itself as its last step.
- **A session that leaves a branch merges it into `main` itself**, then cleans up and archives itself:
  1. Merge `origin/main` into the branch, push it, and run CI on it (`gh workflow run ci.yml --ref <branch>`) until it passes. Run `npm run check-pack` locally, and `npm run test:books` when the change touches engine, plugin or test code. Put its counts in the merge commit.
  2. In its worktree: `git fetch origin && git checkout --detach origin/main && git merge --no-ff refs/heads/claude/<branch>`, then `git push origin HEAD:main`. If the push is rejected, another session got there first: fetch, redo the merge, and push again. CI on `main` checks the result.
  3. Fast-forward the main checkout (`git -C ~/Projects/re-roll pull --ff-only`), and watch the CI run on `main` until it passes. Fix anything it breaks.
  4. Delete the branch (`git branch -D`, plus `git push origin --delete` if it was pushed), and archive itself, which also removes its worktree.

## Platforms

The game must not depend on any one OS. Don't use macOS-only (or Windows-only) features such as system voices or native-only APIs unless there is an equivalent everywhere. Prefer web platform features and bundled, cross-platform libraries. Tauri itself targets macOS, Windows and Linux.

## UI direction

- The game should feel like playing D&D, not a rules tool. Show only what the moment needs, put the rest in drawers or tabs, use transitions, and let the player act on the map by click or drag. The option list stays for keyboard players.
- The look is a Player's Handbook page: parchment, Solbera CC BY-SA fonts in `app/desktop/fonts/`, and a leather top bar. Keep it.
- Tauri's CSP blocks `<style>` elements, so the D&D board uses a constructed stylesheet (`adoptedStyleSheets`).
