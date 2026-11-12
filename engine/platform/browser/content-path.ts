// Which content paths the page may read, shared by the dev server's route and the Tauri reader.
// books/ also holds importer working files (sources, import, audit), which the game never reads.
// Keep BOOK_FOLDERS in step with the fs scope in app/desktop/src-tauri/src/main.rs.

export const BOOK_FOLDERS = ["adventures", "rules", "assets", "library"];

export interface ContentPath {
  readonly folder: string;
  readonly rest: string;
}

// Takes a path that has already been URL-decoded once. Returns null for anything outside the folders.
export function parseContentPath(path: string): ContentPath | null {
  if (path.includes("\\") || path.includes("\0")) return null;
  const [folder = "", ...rest] = path.split("/");
  if (folder !== "plugins" && folder !== "books") return null;
  if (folder === "books" && !BOOK_FOLDERS.includes(rest[0] ?? "")) return null;
  // Hidden names are never content, and books/ is its own git repo, so its .git must stay unreachable.
  if (rest.some((part) => part === "" || part.startsWith("."))) return null;
  return { folder, rest: rest.join("/") };
}
