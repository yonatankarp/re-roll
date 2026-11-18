# Contributing

Thanks for helping. The design is in [docs/technical-design.md](docs/technical-design.md), and the README says how to build and run the game.

## Setting up

1. Install Node at the version in [`.nvmrc`](.nvmrc), then `npm ci`.
2. Run `git config core.hooksPath .githooks` once. The pre-commit hook runs `npm run typecheck` and `npm run lint`, and rejects staged `books/` paths.

## Before you open a pull request

- `npm run typecheck`, `npm run lint` and `npm run format:check` pass. Run the test file you changed with `npx vitest run <file>`. CI runs the whole suite and the UI smoke test on Linux, Windows and macOS.
- New behavior has a test. A bug fix has a test that failed before it.

## Rules the code keeps

- **Saves replay logged inputs.** Every player action goes through decisions and events, never hidden UI state.
- **Events and frames are append-only**, because saves store them. Never rename, remove or reshape an event or frame kind; add a new kind and keep the old handler. New payload fields are optional. Payloads carry outcomes, such as the rolled damage, never inputs a reducer re-derives. The golden saves in `tests/fixtures/saves/` must keep loading.
- **Rules live in the system plugin**, content in data plugins, and only `engine/platform` touches files or the network. Lint and the tsconfigs enforce the boundaries.
- **No OS-only features.** The game runs on macOS, Windows and Linux, in a webview.
- **The game plays the 2024 rules** (SRD 5.2).

## Book content

Content from books you own goes in `books/`, which this repository ignores. Never commit book text, art or data here, in issues or in pull requests. The shipped adventures use only the SRD 5.2 and original writing. Balance comes from the engine and the difficulty settings, never from editing what a book prints.

## Writing an adventure

See [docs/writing-an-adventure.md](docs/writing-an-adventure.md).
