# Third-party notices

Re-roll is licensed under the GNU General Public License, version 3 or later (see `LICENSE`). It includes or depends on the following third-party work.

## Bundled or required at runtime

- **eSpeak NG** (GPL-3.0-or-later), compiled into the narration worker through the `phonemizer` package, to turn text into phonemes for the narrator. Source: https://github.com/espeak-ng/espeak-ng
- **Kokoro-82M** voice model and voices (Apache-2.0), downloaded on first use and verified by hash. Source: https://huggingface.co/hexgrad/Kokoro-82M
- **Solbera's D&D 5e fonts** (CC BY-SA 4.0): Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed, Scaly Sans and Scaly Sans Caps, in `app/desktop/fonts/` with their licence.
- **System Reference Document 5.2** (CC BY 4.0) by Wizards of the Coast, the basis of `plugins/rules/srd52` and the shipped adventures' rules. See the attribution in that plugin.

## npm packages (production dependencies)

Generated from `npm ls --omit=dev`. Each package's licence text ships in its own folder under `node_modules`.

| Package                         | Version                        | Licence           | Source                                                 |
| ------------------------------- | ------------------------------ | ----------------- | ------------------------------------------------------ |
| @huggingface/jinja              | 0.5.12                         | MIT               | https://github.com/huggingface/huggingface.js          |
| @huggingface/transformers       | 3.8.1                          | Apache-2.0        | https://github.com/huggingface/transformers.js         |
| @img/colour                     | 1.1.0                          | MIT               | https://github.com/lovell/colour                       |
| @img/sharp-darwin-arm64         | 0.34.5                         | Apache-2.0        | https://github.com/lovell/sharp                        |
| @img/sharp-libvips-darwin-arm64 | 1.2.4                          | LGPL-3.0-or-later | https://github.com/lovell/sharp-libvips                |
| @isaacs/fs-minipass             | 4.0.1                          | ISC               | https://github.com/npm/fs-minipass                     |
| @protobufjs/aspromise           | 1.1.2                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/base64              | 1.1.2                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/codegen             | 2.0.5                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/eventemitter        | 1.1.1                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/fetch               | 1.1.1                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/float               | 1.0.2                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/path                | 1.1.2                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/pool                | 1.1.0                          | BSD-3-Clause      | https://github.com/dcodeIO/protobuf.js                 |
| @protobufjs/utf8                | 1.1.2                          | BSD-3-Clause      | https://github.com/protobufjs/protobuf.js              |
| @types/node                     | 26.6.6                         | MIT               | https://github.com/DefinitelyTyped/DefinitelyTyped     |
| boolean                         | 3.2.0                          | MIT               | git://github.com/thenativeweb/boolean                  |
| chownr                          | 3.0.0                          | BlueOak-1.0.0     | git://github.com/isaacs/chownr                         |
| define-data-property            | 1.1.4                          | MIT               | https://github.com/ljharb/define-data-property         |
| define-properties               | 1.2.1                          | MIT               | git://github.com/ljharb/define-properties              |
| detect-libc                     | 2.1.2                          | Apache-2.0        | git://github.com/lovell/detect-libc                    |
| detect-node                     | 2.1.0                          | MIT               | https://github.com/iliakan/detect-node                 |
| es-define-property              | 1.0.1                          | MIT               | https://github.com/ljharb/es-define-property           |
| es-errors                       | 1.3.0                          | MIT               | https://github.com/ljharb/es-errors                    |
| es6-error                       | 4.1.1                          | MIT               | https://github.com/bjyoungblood/es6-error              |
| escape-string-regexp            | 4.0.0                          | MIT               | sindresorhus/escape-string-regexp                      |
| flatbuffers                     | 25.9.23                        | Apache-2.0        | https://github.com/google/flatbuffers                  |
| global-agent                    | 3.0.0                          | BSD-3-Clause      | https://github.com/gajus/global-agent                  |
| globalthis                      | 1.0.4                          | MIT               | git://github.com/ljharb/System.global                  |
| gopd                            | 1.2.0                          | MIT               | https://github.com/ljharb/gopd                         |
| guid-typescript                 | 1.0.9                          | ISC               | https://github.com/NicolasDeveloper/guid-typescript    |
| has-property-descriptors        | 1.0.2                          | MIT               | https://github.com/inspect-js/has-property-descriptors |
| json-stringify-safe             | 5.0.1                          | ISC               | git://github.com/isaacs/json-stringify-safe            |
| kokoro-js                       | 1.2.1                          | Apache-2.0        | https://github.com/hexgrad/kokoro                      |
| long                            | 5.3.2                          | Apache-2.0        | https://github.com/dcodeIO/long.js                     |
| matcher                         | 3.0.0                          | MIT               | sindresorhus/matcher                                   |
| minipass                        | 7.1.3                          | BlueOak-1.0.0     | https://github.com/isaacs/minipass                     |
| minizlib                        | 3.1.0                          | MIT               | https://github.com/isaacs/minizlib                     |
| object-keys                     | 1.1.1                          | MIT               | git://github.com/ljharb/object-keys                    |
| onnxruntime-common              | 1.21.0                         | MIT               | https://github.com/Microsoft/onnxruntime               |
| onnxruntime-common              | 1.22.0-dev.20250409-89f8206ba4 | MIT               | https://github.com/Microsoft/onnxruntime               |
| onnxruntime-node                | 1.21.0                         | MIT               | https://github.com/Microsoft/onnxruntime               |
| onnxruntime-web                 | 1.22.0-dev.20250409-89f8206ba4 | MIT               | https://github.com/Microsoft/onnxruntime               |
| phonemizer                      | 1.2.1                          | Apache-2.0        | https://github.com/xenova/phonemizer.js                |
| platform                        | 1.3.6                          | MIT               | bestiejs/platform.js                                   |
| protobufjs                      | 7.6.6                          | BSD-3-Clause      | protobufjs/protobuf.js                                 |
| roarr                           | 2.15.4                         | BSD-3-Clause      | git@github.com:gajus/roarr                             |
| semver                          | 7.8.6                          | ISC               | https://github.com/npm/node-semver                     |
| semver-compare                  | 1.0.0                          | MIT               | git://github.com/substack/semver-compare               |
| serialize-error                 | 7.0.1                          | MIT               | sindresorhus/serialize-error                           |
| sharp                           | 0.34.5                         | Apache-2.0        | git://github.com/lovell/sharp                          |
| sprintf-js                      | 1.1.3                          | BSD-3-Clause      | https://github.com/alexei/sprintf.js                   |
| tar                             | 7.5.23                         | BlueOak-1.0.0     | https://github.com/isaacs/node-tar                     |
| type-fest                       | 0.13.1                         | (MIT OR CC0-1.0)  | sindresorhus/type-fest                                 |
| undici-types                    | 8.9.0                          | MIT               | https://github.com/nodejs/undici                       |
| yallist                         | 5.0.0                          | BlueOak-1.0.0     | https://github.com/isaacs/yallist                      |
| yaml                            | 2.9.1                          | ISC               | github:eemeli/yaml                                     |
| zod                             | 4.6.7                          | MIT               | https://github.com/colinhacks/zod                      |

The desktop shell vendors **glib 0.18.5** (MIT) in `app/desktop/src-tauri/vendor/glib-0.18.5`, with the GHSA-wrw7-89jp-8q8g fix from glib 0.20 backported, because Tauri's Linux GTK stack still pins glib 0.18.

The Rust crates used by the desktop shell are listed in `app/desktop/src-tauri/Cargo.lock`; most are MIT or Apache-2.0.
