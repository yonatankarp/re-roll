// The main menu's "Open content folder", where a player drops their own book plugins, and
// "Install from a zip", which unzips a plugin or a whole book there. Only the desktop app can write
// a folder, so it hands both in and the browser shows neither button.

let opener: (() => Promise<void>) | null = null;
// Installs a zip and says what was installed.
let installer: ((zip: Uint8Array) => Promise<string>) | null = null;

export function offerContentFolder(
  open: () => Promise<void>,
  install?: (zip: Uint8Array) => Promise<string>,
): void {
  opener = open;
  installer = install ?? null;
}

// `act` is the shell's, so a folder that won't open or a zip that won't install shows in its notice.
// `redraw` shows the menu again, with what was installed, and `say` tells the player it's done.
export function contentFolderOption(
  act: (work: () => Promise<void>) => void,
  redraw: () => Promise<void>,
  say: (text: string) => void,
): HTMLElement[] {
  const open = opener;
  if (!open) return [];
  const options = document.createElement("div");
  options.className = "options";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Open content folder";
  button.title = "Add your own adventures and rules here, then reopen the menu";
  button.addEventListener("click", () => {
    act(open);
  });
  options.append(button);

  const install = installer;
  if (install) {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = ".zip,application/zip";
    picker.hidden = true;
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      picker.value = ""; // so the same zip can be picked again
      if (!file) return;
      act(async () => {
        const installed = await install(
          new Uint8Array(await file.arrayBuffer()),
        );
        await redraw();
        say(installed);
      });
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Install from a zip";
    add.title =
      "Pick a zip of one plugin, or of a book laid out like the content folder";
    add.addEventListener("click", () => {
      picker.click();
    });
    options.append(add, picker);
  }
  return [options];
}
