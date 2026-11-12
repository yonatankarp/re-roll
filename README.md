# Re-roll

A single-player fantasy role-playing game compatible with fifth edition (SRD 5.2). You play one character with a party of companions through an adventure: scenes, choices, checks and turn-based fights on a battle map.

Under it is an event-sourced TypeScript engine that knows no game rules. The rules come from a system plugin, and the content from data plugins. Every action is a logged input, so a save replays exactly. The UI runs in a browser or as a [Tauri](https://tauri.app) desktop app on macOS, Windows and Linux.

The design is in [docs/technical-design.md](docs/technical-design.md).

## Prerequisites

- **Node** at the version in [`.nvmrc`](.nvmrc), such as through `nvm install`.
- **For the desktop app only:** Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.
  - **macOS:** the Xcode Command Line Tools (`xcode-select --install`).
  - **Linux** (Debian or Ubuntu): `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev patchelf build-essential`.
  - **Windows:** the Microsoft C++ Build Tools (MSVC) and WebView2, which Windows 10 and 11 usually already have.
- **For narration only:** `ffmpeg` on your `PATH`.

## Running it

```sh
npm ci
npm run ui        # play in the browser at http://127.0.0.1:5199/
npm run desktop   # the same game in the Tauri window
npm run play      # play in the terminal, without the UI
```

`npm run ui` uses a fixed port. To run a second copy, pass another one: `npm run ui -- --port 5200`.

`npm run play -- <adventure>` starts an adventure, and with no arguments it lists them. Section 12 of the design doc has its options and the scripted JSON mode.

### Checks

```sh
npm test
npm run lint
npm run typecheck   # four tsc projects, one per layer
npm run format:check
```

`npm run bot -- [runs] [adventure] [--smart] [--difficulty=story|normal|hard]` plays an adventure many times to find dead ends and measure balance. `npm run check-pack` checks every plugin's content.

## Content

Two adventures ship with the game, both original and built on the SRD 5.2 rules in `plugins/rules/srd52`:

- `goblin-ambush`: Ambush on the Old Road
- `haunted-house`: The House on Mere Lane

### Your own books

Content from books you own goes in a `books/` folder at the root of your checkout. It is git-ignored here, and the game reads it beside `plugins/`. Keep it as its own private git repository if you want history, and never commit it to this one. Plugins there carry `distribution: private`, which means they aren't redistributable.

`npm run import` turns your saved book pages into plugins under `books/`. Its subcommands are `parse`, `library`, `extract`, `split`, `draft` and `approve`, and section 11 of the design doc explains them. `npm run narrate -- <adventure>` reads a `books/` adventure's scenes aloud once and keeps the clips beside it. Scenes without a clip are read in the app as they play.

## Saves

- **Browser and desktop:** in the page's `localStorage`, under `saves/`. Each origin has its own, so the game on another `--port` has a separate save list, and so does the desktop app's webview. Clearing site data deletes them.
- **Terminal:** `npm run play` writes to `saves/` in the current folder, or under `--saves=<dir>`.

Each run has one autosave, written after every choice. Saves from the menu get files of their own. There is no save migration yet, so a save from an older format won't load ([#35](https://github.com/yonatankarp/re-roll/issues/35)).

## Credits

- **Fonts:** Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed, Scaly Sans and Scaly Sans Caps are Solbera's recreations of the fifth edition book fonts, with fixes by Ryrok, Ners and LUCASTUCIOUS, from [jonathonf/solbera-dnd-fonts](https://github.com/jonathonf/solbera-dnd-fonts). They are licensed under [CC BY-SA 4.0](app/desktop/fonts/LICENSE) and bundled unchanged in `app/desktop/fonts`.
- **SRD 5.2:** This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
- **Narration:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), as the ONNX build [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX), through [kokoro-js](https://github.com/hexgrad/kokoro), all under the Apache 2.0 licence. The app downloads the model from Hugging Face the first time it reads aloud.

The game shows every loaded plugin's attribution in About, in the Journal drawer.

## Licence

Re-roll is licensed under the GNU General Public License, version 3 or later (`GPL-3.0-or-later`); see [`LICENSE`](LICENSE). The narrator uses eSpeak NG, which is GPL-3.0-or-later too. Third-party work and its licences are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The fonts and the SRD content keep their own licences, listed above. Your own book content is data you load locally, not part of this program, and stays yours.
