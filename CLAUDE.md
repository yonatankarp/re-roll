# Re-roll

A single-player D&D 5.5e game: an event-sourced TypeScript engine (`engine/`), a D&D system plugin (`plugins/systems/dnd5.5e/`), adventure and rules plugins (`plugins/`), and a Vite UI that also ships as a Tauri macOS app (`app/desktop`). The design is in `docs/technical-design.md`.

## Running things

- Node 26 comes from nvm and isn't on the default PATH. Prefix commands with `PATH="$HOME/.nvm/versions/node/v26.13.0/bin:$PATH"`.
- Before you call work done, run `npm test`, `npm run lint` and `npm run typecheck` (four tsc projects), and make sure all three pass.
- `npm run ui` serves the game at http://127.0.0.1:5199/ with `strictPort`. A second checkout or worktree needs `npm run ui -- --port <other>`.
- `npm run bot -- [runs] [adventure] [--smart] [--difficulty=story|normal|hard]` plays adventures to measure balance. The targets are Story at or under about 25% defeats and Normal at 15–45%.
- `npm run play` plays in text without the UI.
- Saves replay logged inputs (`engine/kernel/save.ts`). Every player action must go through decisions and events, never through hidden UI state.

## Book content: `private/`

- `private/` holds content imported from the owner's own books. Git ignores it, it's never committed, and no backup covers it.
- Only write ids, names and numbers there: coordinates, counts, monster ids, `onFlee` targets. Never write book prose, whether yours or copied, and never add it to git.
- Never log in to or download from D&D Beyond.
- A git worktree has no `private/`. To play-test, symlink `~/Projects/re-roll/private` into it, and only one session at a time may write to it.

## Git

- Commit or push only when asked. Never add Co-Authored-By or other attribution lines to commits or PRs.
- Merge session branches with `--no-ff`, naming them `refs/heads/claude/...`.

## Platforms

The game must not depend on any one OS. Don't use macOS-only (or Windows-only) features such as system voices or native-only APIs unless there is an equivalent everywhere. Prefer web platform features and bundled, cross-platform libraries. Tauri itself targets macOS, Windows and Linux.

## UI direction

- The game should feel like playing D&D, not a rules tool. Show only what the moment needs, put the rest in drawers or tabs, use transitions, and let the player act on the map by click or drag. The option list stays for keyboard players.
- The look is a Player's Handbook page: parchment, Solbera CC BY-SA fonts in `app/desktop/fonts/`, and a leather top bar. Keep it.
- Tauri's CSP blocks `<style>` elements, so the D&D board uses a constructed stylesheet (`adoptedStyleSheets`).
