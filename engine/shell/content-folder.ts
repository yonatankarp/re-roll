// The main menu's "Open content folder", where a player drops their own book plugins.
// Only the desktop app can open a folder, so it hands its opener in and the browser shows no button.

let opener: (() => Promise<void>) | null = null;

export function offerContentFolder(open: () => Promise<void>): void {
  opener = open;
}

// `act` is the shell's, so a folder that won't open shows in its notice.
export function contentFolderOption(
  act: (work: () => Promise<void>) => void,
): HTMLElement[] {
  const open = opener;
  if (!open) return [];
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Open content folder";
  button.title = "Add your own adventures and rules here, then reopen the menu";
  button.addEventListener("click", () => {
    act(open);
  });
  const options = document.createElement("div");
  options.className = "options";
  options.append(button);
  return [options];
}
