# Releasing the desktop app

How a build of the Tauri app is put together, how a release is made, and how it is signed.

## What a build contains

`npm run desktop:build` runs `tauri build`, which bundles for the OS it runs on:

| OS | Bundles |
|---|---|
| macOS | `Re-roll.app` and a `.dmg` |
| Windows | an NSIS `-setup.exe` and an `.msi` |
| Linux | `.deb`, `.rpm` and an AppImage |

Tauri can't cross-compile these, so each OS builds its own. Windows and Linux fetch their packaging tools (WiX, NSIS, linuxdeploy) on the first build.

Each bundle holds the compiled UI from `out/desktop`, the shipped plugins in `plugins/adventures` and `plugins/rules`, `LICENSE` and `THIRD_PARTY_NOTICES.md`, as `bundle.resources`. `plugins/systems` is code, already compiled into the UI. Nothing from `books/` is ever bundled. The player adds their own plugins to the app's content folder (see the README).

## The private-content check

`beforeBuildCommand` runs `npm run check-bundle` after building the UI. It walks every `bundle.resources` source and fails the build if it finds:

- a path through a `books` folder,
- a `plugin.yaml` that isn't `distribution: shipped`,
- a symlink, since the bundler would follow it, or
- a glob, which the check can't expand.

Its test is `tests/check-bundle.test.ts`.

## Third-party notices

`npm run notices` writes `THIRD_PARTY_NOTICES.md` from the lockfiles: every npm package in the production tree plus the Tauri packages the UI bundles, every crate in `Cargo.lock` for all three OSes, and Solbera's fonts, with each licence text found in the package (identical texts printed once). A package that names no licence fails it. `beforeBuildCommand` runs it, so a bundle always carries current notices, and CI's `tauri` job runs `npm run notices -- --check`, which fails while the checked-in file is stale. After a dependency bump, run `npm run notices` and commit the file.

## Version

`package.json` holds the one version. `tauri.conf.json` reads it (`"version": "../../../package.json"`), so the bundles and the app's About data use it, and `Cargo.toml` has no version of its own. WiX's MSI takes only `major.minor.patch`, so the version in `package.json` carries no pre-release suffix.

## Making a release

1. Bump `package.json` (and `npm install` to update the lockfile), add the version's section to `CHANGELOG.md`, and merge to `main`.
2. Tag the commit `v<version>` and push the tag. `.github/workflows/release.yml` fails unless the tag is `v<version>`, or `v<version>-<suffix>`, which makes a pre-release.
3. The workflow makes one draft release, then builds on `macos-latest` (a universal app for Apple silicon and Intel), `windows-latest` and `ubuntu-22.04` (the oldest glibc the AppImage and `.deb` support), and uploads each OS's bundles to the draft and as workflow artifacts.
4. Check the draft, then publish it.

Running the workflow by hand (Actions, Release, Run workflow) with a tag name makes the same draft without pushing a tag first; GitHub creates the tag when the draft is published. Delete a test draft with `gh release delete <tag> --yes --cleanup-tag`.

Releases are only built by this workflow, never on a developer's machine. `[profile.release] strip = true` drops symbols and debug paths from the binary anyway.

The macOS app needs macOS 12.3 or later (`bundle.macOS.minimumSystemVersion`), the first with WebKit from Safari 15.4, which `<dialog>`, `:has()` and `dvh` need.

## Signing

Each step runs only when its secrets are set in the repository (Settings, Secrets and variables, Actions). Without them the build still succeeds, unsigned, with a warning in the run.

| Secret | What it holds |
|---|---|
| `APPLE_CERTIFICATE` | The Developer ID Application certificate and key, exported as `.p12` and base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, such as `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` | Notarization with an App Store Connect API key: the issuer id, the key id and the `.p8` file's contents |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Or notarization with an Apple ID, an app-specific password and the team id |
| `WINDOWS_CERTIFICATE` | An OV or EV code-signing certificate as a base64-encoded `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` password |

- **macOS:** with `APPLE_CERTIFICATE` set, Tauri signs with the certificate, and notarizes when either notarization set is complete. It needs an Apple Developer Program membership. Without it the app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), so Gatekeeper blocks the first launch: the player opens it from System Settings, Privacy & Security, Open Anyway.
- **Windows:** with `WINDOWS_CERTIFICATE` set, the workflow imports it and writes its thumbprint to `tauri.windows.conf.json`, so Tauri signs the app and both installers with signtool and a DigiCert timestamp. Certificates issued since June 2023 live on a hardware token or a cloud HSM and can't be exported as a `.pfx`; for those (or Azure Trusted Signing), replace that step with a `bundle.windows.signCommand`. Unsigned installers get a SmartScreen warning: More info, Run anyway.
- **Linux:** no OS signing. GitHub shows each release file's SHA-256 beside it.

The secrets live only in the CI's encrypted secrets, never in the repository.

## Updates (planned)

Use `tauri-plugin-updater`:

1. Generate an updater key pair with `tauri signer generate`. The public key goes in `plugins.updater.pubkey` in `tauri.conf.json`. The private key and its password go in CI secrets as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. This key is separate from OS signing, and losing it means existing installs can't update.
2. Set `bundle.createUpdaterArtifacts: true`, so each build also writes signed update archives.
3. Point `plugins.updater.endpoints` at a `latest.json` attached to the newest GitHub release.
4. Set `uploadUpdaterJson: true` on the release workflow's `tauri-action` step, with the two secrets in its `env`, so it uploads `latest.json` beside the bundles.
5. The app checks for an update from the main menu and asks before installing. It never updates during a game.

The updater only replaces the app. The content folder and saves are outside the bundle, so they survive an update.
