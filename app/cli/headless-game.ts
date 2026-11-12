import { createPlayStorage } from "../../engine/platform/node/storage.ts";
import { createGame } from "../../engine/shell/session.ts";
import { type Driver, createDriver } from "../../engine/tools/headless.ts";
import { dndUi } from "../../plugins/systems/dnd5.5e/ui/index.ts";
import { systems } from "../systems.ts";
import { PLUGIN_ROOTS } from "./load-adventure.ts";

// The game the desktop app plays, on Node: content from the repo, saves under savesRoot/saves.
export async function openHeadless(
  savesRoot: string = process.cwd(),
): Promise<Driver> {
  return createDriver(
    createGame({
      storage: await createPlayStorage(process.cwd(), savesRoot),
      roots: PLUGIN_ROOTS,
      systems,
      uis: [dndUi],
    }),
  );
}
