# Security

## Reporting a vulnerability

Please report it privately through **Report a vulnerability** on this repository's [Security tab](https://github.com/yonatankarp/re-roll/security), not in a public issue. Say what is affected, how to reproduce it, and what an attacker gains. You'll get an answer when the report has been read, and a fix lands on `main`, since there are no released versions to backport to yet.

## What counts

The game loads content other people write, so these are the boundaries that matter:

- **Data plugins can't run code.** The loader accepts only YAML, text, image and audio files, rejects symlinks and SVG, and keeps asset paths inside the plugin folder. Text renders as text, never as HTML.
- **The desktop app's page writes only through its own commands**, which reach nothing but the app-data `saves` folder and, for **Install from a zip**, the content folder, with every path checked again in Rust.
- **Store tokens** stay in the system keychain and are sent only to `github.com` and `api.github.com` for the repo they belong to.
- **The Tauri CSP** lets the page connect only to itself, the app's IPC and the narration model's Hugging Face hosts.

A way past any of these is a vulnerability. So is a save or a plugin that crashes or hangs the app on load. A cheat that only changes your own single-player game is not.
