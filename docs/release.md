# Releasing the desktop app

How a build of the Tauri app is put together, and the plan for signing and updates. Nothing here is signed yet.

## What a build contains

`npm run desktop:build` runs `tauri build`, which bundles for the OS it runs on:

| OS | Bundles |
|---|---|
| macOS | `Re-roll.app` and a `.dmg` |
| Windows | an NSIS `-setup.exe` and an `.msi` |
| Linux | `.deb`, `.rpm` and an AppImage |

Tauri can't cross-compile these, so each OS builds its own. Windows and Linux fetch their packaging tools (WiX, NSIS, linuxdeploy) on the first build.

Each bundle holds the compiled UI from `out/desktop` and the shipped plugins in `plugins/adventures` and `plugins/rules`, as `bundle.resources`. `plugins/systems` is code, already compiled into the UI. Nothing from `books/` is ever bundled. The player adds their own plugins to the app's content folder (see the README).

## The private-content check

`beforeBuildCommand` runs `npm run check-bundle` after building the UI. It walks every `bundle.resources` source and fails the build if it finds:

- a path through a `books` or `private` folder,
- a `plugin.yaml` that isn't `distribution: shipped`,
- a symlink, since the bundler would follow it, or
- a glob, which the check can't expand.

Its test is `tests/check-bundle.test.ts`.

## Version

`package.json` holds the one version. `tauri.conf.json` reads it (`"version": "../../../package.json"`), so the bundles and the app's About data use it, and `Cargo.toml` has no version of its own. To release, bump `package.json`, then tag the commit `v<version>`.

## Signing (planned)

Unsigned builds work but warn the player: macOS Gatekeeper blocks the app until it's allowed in System Settings, and Windows SmartScreen warns on the installer.

- **macOS:** a Developer ID Application certificate, with notarization. Tauri signs and notarizes during `tauri build` when `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` and either `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH` or `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` are set. It needs an Apple Developer Program membership.
- **Windows:** an OV or EV code-signing certificate, or Azure Trusted Signing, through `bundle.windows.certificateThumbprint` or `bundle.windows.signCommand`. An EV certificate or Trusted Signing avoids SmartScreen's reputation warm-up.
- **Linux:** no OS signing. Publish checksums beside the files, and sign the AppImage with GPG if wanted.

The secrets live only in the CI's encrypted secrets, never in the repository.

## Updates (planned)

Use `tauri-plugin-updater`:

1. Generate an updater key pair with `tauri signer generate`. The public key goes in `plugins.updater.pubkey` in `tauri.conf.json`. The private key and its password go in CI secrets as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. This key is separate from OS signing, and losing it means existing installs can't update.
2. Set `bundle.createUpdaterArtifacts: true`, so each build also writes signed update archives.
3. Point `plugins.updater.endpoints` at a `latest.json` attached to the newest GitHub release.
4. A CI job on a `v*` tag builds on macOS, Windows and Linux runners with `tauri-apps/tauri-action`, signs, and uploads the bundles and `latest.json` to a draft release.
5. The app checks for an update from the main menu and asks before installing. It never updates during a game.

The updater only replaces the app. The content folder and saves are outside the bundle, so they survive an update.
