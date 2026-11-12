// Shortcuts show ⌘ on a Mac and Ctrl elsewhere; the key handler takes either, and says so.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = MAC ? "⌘" : "Ctrl+";
export const keyshortcuts = (key: string): string =>
  `Control+${key} Meta+${key}`;
