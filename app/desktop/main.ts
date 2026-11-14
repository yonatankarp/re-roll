import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type SaveFiles,
  type SaveStore,
  contentImageUrl,
  createContentReader,
  moveSavesToFiles,
  storeFiles,
  withSaveFiles,
} from "../../engine/platform/browser/storage.ts";
import { openIndexedDbFiles } from "../../engine/platform/browser/indexeddb.ts";
import { createTauriSaves } from "../../engine/platform/tauri/saves.ts";
import {
  describePlan,
  installPlan,
  planInstall,
} from "../../engine/platform/tauri/install.ts";
import {
  createTauriReader,
  openContentFolder,
  tauriImageUrl,
} from "../../engine/platform/tauri/storage.ts";
import { offerContentFolder } from "../../engine/shell/content-folder.ts";
import { offerStore } from "../../engine/shell/store-screen.ts";
import type { Storage } from "../../engine/kernel/storage.ts";
import { scanPlugins } from "../../engine/run/loader.ts";
import { createGame } from "../../engine/shell/session.ts";
import { mountShell } from "../../engine/shell/shell.ts";
import { mountDndBoard } from "../../plugins/systems/dnd5.5e/ui/board.ts";
import { dndUi } from "../../plugins/systems/dnd5.5e/ui/index.ts";
import { coinSound } from "../../plugins/systems/dnd5.5e/ui/sound.ts";
import { systems } from "../systems.ts";

// CC BY-SA 4.0 asks for the title, the authors, the source and the licence.
const FONT_CREDIT =
  "Fonts: Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed, Scaly Sans and Scaly Sans Caps, " +
  "Solbera's recreations of the fifth edition fonts, with fixes by Ryrok, Ners and LUCASTUCIOUS, " +
  "from github.com/jonathonf/solbera-dnd-fonts, under the Creative Commons Attribution-ShareAlike 4.0 licence.";

// Reading localStorage throws where site storage is blocked, and then saves last only while the page is open.
function browserSaves(): SaveStore {
  try {
    // Firefox with storage turned off gives null instead of throwing.
    const store = window.localStorage as SaveStore | null;
    if (store) return store;
    throw new Error("localStorage is null");
  } catch (error) {
    console.warn("Site storage is blocked, so saves won't be kept", error);
    const items = new Map<string, string>();
    return {
      get length() {
        return items.size;
      },
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value);
      },
      removeItem: (key) => {
        items.delete(key);
      },
    };
  }
}

// A zip is installed into the content folder. The page reloads after a new copy of a plugin, or new
// art or book text, since the game keeps what it read, such as the last adventure and its pictures.
async function installZip(zip: Uint8Array): Promise<string> {
  const catalog = await scanPlugins(createTauriReader(), ["plugins", "books"]);
  const known = new Map(
    [...catalog.plugins].map(([id, plugin]) => [id, plugin.root]),
  );
  const plan = planInstall(zip, known);
  const replaced = await installPlan(zip, plan);
  const installed = describePlan(plan);
  if (
    replaced ||
    plan.parts.some(({ folder }) => folder === "assets" || folder === "library")
  ) {
    window.location.reload();
    return `Installed ${installed}. Reloading…`;
  }
  return `Installed ${installed}.`;
}

if (isTauri()) offerContentFolder(openContentFolder, installZip);

// A promise nobody awaits, such as a board cue, says what broke rather than failing silently.
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled rejection", event.reason);
});

// Narration reads faster with WASM threads, which need cross-origin isolation, and keeps its model in the Cache API.
console.info(
  `Secure context: ${String(isSecureContext)}, cross-origin isolated: ${String(crossOriginIsolated)}, Cache API: ${String(typeof caches !== "undefined")}`,
);

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("The page has no #app element");

// The desktop app keeps saves as files, and moves any it kept in localStorage there first.
async function desktopSaves(): Promise<SaveFiles> {
  const files = createTauriSaves();
  try {
    await moveSavesToFiles(browserSaves(), files);
  } catch (error) {
    console.warn("Couldn't move the old saves to the saves folder", error);
  }
  return files;
}

// The browser build keeps saves in IndexedDB and moves any it kept in localStorage there first.
// Without IndexedDB (site storage blocked) they stay in localStorage.
async function webSaves(): Promise<SaveFiles> {
  let files: SaveFiles;
  try {
    files = await openIndexedDbFiles();
  } catch (error) {
    console.warn(
      "IndexedDB is unavailable, so saves stay in localStorage",
      error,
    );
    return storeFiles(browserSaves());
  }
  try {
    await moveSavesToFiles(browserSaves(), files);
  } catch (error) {
    console.warn("Couldn't move the old saves to IndexedDB", error);
  }
  return files;
}

// Kept with the saves, but not a .json file, so the save list passes it by.
const STORE_STATE = "saves/store";

// The Store's downloads and tokens go through the app's own commands (src-tauri/src/main.rs).
function offerDesktopStore(storage: Storage): void {
  offerStore({
    fetch: async (repo, file) =>
      new Uint8Array(await invoke<ArrayBuffer>("store_fetch", { repo, file })),
    setToken: (repo, token) => invoke("store_token_set", { repo, token }),
    forgetToken: (repo) => invoke("store_token_forget", { repo }),
    hasToken: (repo) => invoke("store_token_has", { repo }),
    readState: () => storage.read(STORE_STATE),
    writeState: (text) => storage.replaceAtomically(STORE_STATE, text),
    plugins: async () =>
      new Set(
        (
          await scanPlugins(createTauriReader(), ["plugins", "books"])
        ).plugins.keys(),
      ),
    install: async (zip) => {
      const catalog = await scanPlugins(createTauriReader(), [
        "plugins",
        "books",
      ]);
      const known = new Map(
        [...catalog.plugins].map(([id, plugin]) => [id, plugin.root]),
      );
      await installPlan(zip, planInstall(zip, known));
    },
    reload: () => {
      window.location.reload();
    },
  });
}

async function start(page: HTMLElement): Promise<void> {
  const storage = withSaveFiles(
    isTauri() ? createTauriReader() : createContentReader(),
    isTauri() ? await desktopSaves() : await webSaves(),
  );
  if (isTauri()) offerDesktopStore(storage);
  mountShell(
    page,
    createGame({
      storage,
      roots: ["plugins", "books"],
      systems,
      uis: [dndUi],
      imageUrl: isTauri() ? tauriImageUrl : contentImageUrl,
    }),
    { [dndUi.systemId]: mountDndBoard },
    [FONT_CREDIT],
    coinSound,
  );
}
void start(root);

// The macOS window keeps the title it opened with, so it follows the page's, such as "Adventure — Scene".
if (isTauri()) {
  const appWindow = getCurrentWindow();
  new MutationObserver(() => {
    appWindow.setTitle(document.title).catch(() => undefined);
  }).observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
