# Re-roll

A single-player fantasy role-playing game on the fifth edition 2024 rules (SRD 5.2). You play one hero with a party of companions through an adventure: read the scene, pick what to do, roll your checks, and fight turn by turn on a battle map. It aims to feel like a night at the table, not a rules tool, and it looks like a page from the Player's Handbook.

It runs as a desktop app on macOS, Windows and Linux. From a checkout of this repository it also runs in your browser.

![A slideshow of five screenshots: a scene with art, the story and numbered choices, some with a skill check; the adventure library with the shipped adventures and adventures from your books; picking a ready hero; a fight on the battle map with your party at the bottom and the foes at the top; and the character sheet in a drawer beside the map](docs/images/tour.webp)

## Play it

There are no ready-made downloads yet, so you build it from this repository.

1. Install **Node** at the version in [`.nvmrc`](.nvmrc), for example with `nvm install`.
2. Get the code and its packages:

   ```sh
   git clone https://github.com/yonatankarp/re-roll.git
   cd re-roll
   npm ci
   ```

3. Start the game:

   ```sh
   npm run ui        # in your browser, at http://127.0.0.1:5199/
   npm run desktop   # in its own window, as the desktop app
   ```

   `npm run ui` uses a fixed port. To run a second copy, pass another one: `npm run ui -- --port 5200`.

The desktop app needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS:

- **macOS:** the Xcode Command Line Tools (`xcode-select --install`).
- **Linux** (Debian or Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, the list CI installs.
- **Windows:** the Microsoft C++ Build Tools (MSVC) and WebView2, which Windows 10 and 11 usually already have.

`npm run desktop:build` makes an installable app for the OS you run it on. Tagged versions are built for macOS, Windows and Linux on GitHub and attached to the repository's releases; [docs/release.md](docs/release.md) says what a build holds and how a release is made.

Two original adventures come with the game, built on the free SRD 5.2 rules:

- **Ambush on the Old Road** (`goblin-ambush`)
- **The House on Mere Lane** (`haunted-house`)

### Saves

The game saves after every choice, and **Save game** in the menu keeps a save of its own.

The desktop app keeps each save as a gzipped file in the `saves` folder inside its app data folder. Copy that folder to back up your saves:

- **macOS:** `~/Library/Application Support/app.re-roll.desktop/saves`
- **Windows:** `%APPDATA%\app.re-roll.desktop\saves`
- **Linux:** `~/.local/share/app.re-roll.desktop/saves`

In the browser (`npm run ui`), saves live in the page's IndexedDB, or in its `localStorage` when the browser blocks IndexedDB. Each address has its own, so the game on another `--port` has a separate save list, and clearing site data deletes them. Saves an older build kept in `localStorage` are copied over once on the next launch.

## Add your own books

Adventures and rules from books you own load beside the shipped ones, and show in the library under **Private, from your books**.

### The Store (desktop app)

**Store** on the desktop app's main menu installs books and adventures from GitHub repos you add, public or private. Type a repo as `owner/repo` or paste its link. A private repo needs a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only access to its **Contents**. The game keeps the token in your system's keychain and uses it only for that repo. Installing a package also installs the packages it needs, and **Update** appears when the store has a newer copy.

### By hand

The desktop app reads your plugins from its content folder. **Open content folder** on the main menu shows it. Copy a plugin into its matching `adventures`, `rules`, `worlds`, `assets` or `library` folder and reopen the menu, or use **Install from a zip**. The zip holds one plugin, or a whole book laid out like the content folder. It replaces older copies of what it installs, and refuses a zip that holds anything but game data. The folder is `plugins` inside the app's data folder:

- **macOS:** `~/Library/Application Support/app.re-roll.desktop/plugins`
- **Windows:** `%APPDATA%\app.re-roll.desktop\plugins`
- **Linux:** `~/.local/share/app.re-roll.desktop/plugins`

With `npm run ui` or `npm run desktop` from a checkout, put your content in a `books/` folder at the root of the checkout instead, laid out the same way. It is git-ignored here. Keep it as its own private git repository if you want history, and never commit it to this one. Plugins there carry `distribution: private`, which means they aren't redistributable.

## For developers

Under the game is an event-sourced TypeScript engine that knows no game rules. The rules come from a system plugin (`plugins/systems/dnd5.5e`), and the content from data plugins (`plugins/adventures`, `plugins/rules`). Every action is a logged input, so a save replays exactly. The UI is a Vite app (`app/desktop`) that also ships as a [Tauri](https://tauri.app) app. The design is in [docs/technical-design.md](docs/technical-design.md). [CONTRIBUTING.md](CONTRIBUTING.md) has the rules for changes, [docs/writing-an-adventure.md](docs/writing-an-adventure.md) a short guide to writing an adventure, and [SECURITY.md](SECURITY.md) how to report a vulnerability.

### Commands

```sh
npm test
npm run lint
npm run typecheck   # four tsc projects, one per layer
npm run format:check
npm run test:ui     # a Playwright smoke test in Chromium
```

- `npm run play -- <adventure>` plays in the terminal, without the UI. With no arguments it lists the adventures. It saves to `saves/` in the current folder, or under `--saves=<dir>`. Section 12 of the design doc has its options and the scripted JSON mode.
- `npm run bot -- [runs] [adventure] [--smart] [--difficulty=story|normal|hard]` plays an adventure many times to find dead ends and measure balance.
- `npm run check-pack` checks every plugin's content.
- `npm run import` turns your saved book pages into plugins under `books/`. Its subcommands are `parse`, `library`, `extract`, `split`, `draft` and `approve`, and section 11 of the design doc explains them.
- `npm run narrate -- <adventure>` reads an adventure's scenes aloud once, with `ffmpeg` on your `PATH`, and keeps the clips beside it. Scenes without a clip are read in the app as they play.

### Making a store

A store is a GitHub repo laid out like `books/`, with a `store.yaml` that names each package and the folders it installs:

```yaml
packages:
  - id: phb
    title: Player's Handbook
    parts: [rules/phb, assets/phb, library/phb, library/glossary.json]
```

`npm run store:pack -- <folder> --out <dir>` checks each package and writes one zip per package and a `store.json` index to `<dir>`. Adding `--publish owner/repo` uploads them to that repo's `store` release with the `gh` CLI. It refuses to publish plugins marked `distribution: private` to a public repo.

### Narration on each OS

Scenes without a made-ahead clip are read in the app by Kokoro-82M: on WebGPU when the webview has it, else in WASM on several threads when the page is cross-origin isolated and has `SharedArrayBuffer`, else in WASM on one thread. The app sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers for the threads. The model comes from Hugging Face on first use and is kept in the Cache API, or in IndexedDB where the Cache API is missing or refused. With neither it is downloaded each launch, and the narrator's status line says so. The console logs the device, thread count and store once the voice is ready. The Sound panel says where the narrator reads and, once it has read a few seconds, how much slower than speech it reads, so a player on a slow CPU can turn narration off; recorded clips still play at once.

|             | Webview             | WASM threads                                                                                                       | Model cache                                                          |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **macOS**   | WKWebView           | No. The page is cross-origin isolated, but WebKit gives the app no `SharedArrayBuffer`, so WASM runs on one thread | Yes, the Cache API works on `tauri://localhost`                      |
| **Windows** | WebView2 (Chromium) | Expected, as Chromium runs 4 threads. Not yet checked in WebView2                                                  | Expected, not yet checked                                            |
| **Linux**   | WebKitGTK           | Not yet checked. It has no WebGPU by default, so narration always runs in WASM                                     | Not yet checked. Falls back to IndexedDB if the Cache API is refused |

The macOS row was checked on a release build on macOS 27 (Apple silicon). There the narrator read on WebGPU, so it took the 330 MB model, and one WASM thread only matters on a Mac without WebGPU. The model was downloaded once and read from the Cache API after a relaunch.

The Windows expectation comes from Chromium on the same Mac. A production browser build started 3 extra WASM threads, 4 in all. A dev build did the same with the app's `script-src` and `worker-src` rules applied. On 4 threads the narrator read about 1.8 to 2.4 times slower than speech, against about 3 times on one thread.

## Credits

- **Fonts:** Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed, Scaly Sans and Scaly Sans Caps are Solbera's recreations of the fifth edition book fonts, with fixes by Ryrok, Ners and LUCASTUCIOUS, from [jonathonf/solbera-dnd-fonts](https://github.com/jonathonf/solbera-dnd-fonts). They are licensed under [CC BY-SA 4.0](app/desktop/fonts/LICENSE) and bundled unchanged in `app/desktop/fonts`.
- **SRD 5.2:** This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
- **Narration:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), as the ONNX build [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), through [kokoro-js](https://github.com/hexgrad/kokoro), all under the Apache 2.0 licence. The app downloads the model from Hugging Face the first time it reads aloud.
- **Screenshots:** they show adventures loaded from the owner's own books. That art and text belong to their publisher, are not part of this program, and are not covered by its licence.

The game shows every loaded plugin's attribution in About, in the Journal drawer.

## Licence

Re-roll is licensed under the GNU General Public License, version 3 or later (`GPL-3.0-or-later`); see [`LICENSE`](LICENSE). The narrator uses eSpeak NG, which is GPL-3.0-or-later too. Third-party work and its licences are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The fonts and the SRD content keep their own licences, listed above. Your own book content is data you load locally, not part of this program, and stays yours.
