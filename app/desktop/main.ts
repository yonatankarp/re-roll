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
);
