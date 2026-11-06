import { isTauri } from "@tauri-apps/api/core";
import {
  contentImageUrl,
  createContentReader,
  withSaves,
} from "../../engine/platform/browser/storage.ts";
import {
  createTauriReader,
  tauriImageUrl,
} from "../../engine/platform/tauri/storage.ts";
import { createGame } from "../../engine/shell/session.ts";
import { mountShell } from "../../engine/shell/shell.ts";
import { mountDndBoard } from "../../plugins/systems/dnd5.5e/ui/board.ts";
import { dndUi } from "../../plugins/systems/dnd5.5e/ui/index.ts";
import { systems } from "../systems.ts";

// CC BY-SA 4.0 asks for the title, the authors, the source and the licence.
const FONT_CREDIT =
  "Fonts: Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed, Scaly Sans and Scaly Sans Caps, " +
  "Solbera's recreations of the fifth edition fonts, with fixes by Ryrok, Ners and LUCASTUCIOUS, " +
  "from github.com/jonathonf/solbera-dnd-fonts, under the Creative Commons Attribution-ShareAlike 4.0 licence.";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The page has no #app element");

mountShell(
  root,
  createGame({
    storage: withSaves(
      isTauri() ? createTauriReader() : createContentReader(),
      localStorage,
    ),
    roots: ["plugins", "private"],
    systems,
    uis: [dndUi],
    imageUrl: isTauri() ? tauriImageUrl : contentImageUrl,
  }),
  { [dndUi.systemId]: mountDndBoard },
  [FONT_CREDIT],
);
