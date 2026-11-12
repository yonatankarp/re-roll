import { isTauri } from "@tauri-apps/api/core";
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
import { createTauriSaves } from "../../engine/platform/tauri/saves.ts";
import {
  createTauriReader,
  openContentFolder,
  tauriImageUrl,
} from "../../engine/platform/tauri/storage.ts";
import { offerContentFolder } from "../../engine/shell/content-folder.ts";
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

if (isTauri()) offerContentFolder(openContentFolder);

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

async function start(page: HTMLElement): Promise<void> {
  mountShell(
    page,
    createGame({
      storage: withSaveFiles(
        isTauri() ? createTauriReader() : createContentReader(),
        isTauri() ? await desktopSaves() : storeFiles(browserSaves()),
      ),
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
