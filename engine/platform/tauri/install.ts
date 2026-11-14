import { invoke } from "@tauri-apps/api/core";
import { unzipSync } from "fflate";
import { parse } from "yaml";
import {
  PLUGIN_ID_PATTERN,
  PluginManifestSchema,
} from "../../kernel/manifest.ts";
import { ALLOWED_EXTENSIONS, extensionOf } from "../../run/loader.ts";

// Installs content from a zip into the player's content folder, through main.rs's content_install_* commands.
// The zip is checked here; main.rs checks each path again before it writes.
//
// A zip is either one plugin (its files at the top, or in one folder, as zipping a plugin's folder makes)
// or a book laid out like the content folder: adventures/<id>, rules/<id>, assets/<book>, library/<book>.

const MANIFEST = "plugin.yaml";
// shortcut: each file is unpacked into memory on its own, but the zip itself is held whole; stream it if zips grow past this.
export const MAX_UNPACKED_BYTES = 4 * 1024 ** 3;

export const PART_FOLDERS = [
  "adventures",
  "rules",
  "assets",
  "library",
] as const;
export type PartFolder = (typeof PART_FOLDERS)[number];
const KIND_FOLDERS = { adventure: "adventures", rules: "rules" } as const;

// Data only, so nothing installed can run. Keep in step with PART_FILE_TYPES in src-tauri/src/main.rs.
// Assets are pictures and their index, as the session reads them; the library is a book's text and its index.
const FILE_TYPES: Readonly<Record<PartFolder, ReadonlySet<string>>> = {
  adventures: ALLOWED_EXTENSIONS,
  rules: ALLOWED_EXTENSIONS,
  assets: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".json"]),
  library: new Set([".md", ".json"]),
};

// The one file outside a part's folder: the glossary that every book's rules terms are explained from.
export const SHARED_FILES: ReadonlySet<string> = new Set([
  "library/glossary.json",
]);

// One folder of the content folder, or one shared file, put in place as a whole.
export interface InstallPart {
  readonly folder: PartFolder;
  readonly name: string;
  // Each file's path inside the part, by its name in the zip. A shared file has one, with the path "".
  readonly files: ReadonlyMap<string, string>;
}

export interface InstallPlan {
  readonly parts: readonly InstallPart[];
}

// Finder adds __MACOSX/ and .DS_Store to a zip it makes, and a hidden name is never content.
const isJunk = (name: string): boolean =>
  name
    .split("/")
    .some(
      (part) =>
        part === "__MACOSX" ||
        (part.startsWith(".") && part !== "." && part !== ".."),
    );

// The zip's file names and their unpacked sizes, without unpacking any.
function entriesOf(zip: Uint8Array): Map<string, number> {
  const entries = new Map<string, number>();
  try {
    unzipSync(zip, {
      filter: ({ name, originalSize }) => {
        entries.set(name, originalSize);
        return false;
      },
    });
  } catch {
    throw new Error("That file isn't a zip the game can read.");
  }
  return entries;
}

// Unpacks one file. fflate sizes the buffer by the size the zip claims, so a file can't unpack to more.
export function readEntry(zip: Uint8Array, name: string): Uint8Array {
  const file = unzipSync(zip, { filter: (entry) => entry.name === name })[name];
  if (!file) throw new Error(`${name} is missing from the zip`);
  return file;
}

const isPartFolder = (name: string | undefined): name is PartFolder =>
  (PART_FOLDERS as readonly (string | undefined)[]).includes(name);

function readManifest(zip: Uint8Array, zipName: string, label: string) {
  let raw: unknown;
  try {
    raw = parse(new TextDecoder().decode(readEntry(zip, zipName)));
  } catch {
    throw new Error(`${label} isn't valid YAML.`);
  }
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `${label} isn't a valid plugin manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"} ${issue.message}`).join("; ")}`,
    );
  return parsed.data;
}

// The parts of a book zip, by "<folder>/<name>". `names` are without the zip's own top folder, if any.
function bookParts(
  names: readonly string[],
): Map<
  string,
  { folder: PartFolder; name: string; files: Map<string, string> }
> {
  const parts = new Map<
    string,
    { folder: PartFolder; name: string; files: Map<string, string> }
  >();
  for (const path of names) {
    const [folder, name = "", ...rest] = path.split("/");
    if (!isPartFolder(folder))
      throw new Error(`${path} isn't in a content folder.`);
    if (rest.length === 0 && !SHARED_FILES.has(path))
      throw new Error(`${path} is a stray file, outside any book's folder.`);
    const key = `${folder}/${name}`;
    const part = parts.get(key) ?? { folder, name, files: new Map() };
    part.files.set(path, rest.join("/"));
    parts.set(key, part);
  }
  return parts;
}

// The manifest's kind and id say where a plugin goes, never the zip's own folder names.
// `known` is the folder of each plugin the game has, by id, so a zip can't take one from another folder.
export function planInstall(
  zip: Uint8Array,
  known: ReadonlyMap<string, string>,
): InstallPlan {
  const entries = entriesOf(zip);
  // Windows PowerShell 5.1's Compress-Archive writes "\" between folders. Its name stays, to read the file by.
  const zipNames = new Map(
    [...entries.keys()].map((name) => [name.replaceAll("\\", "/"), name]),
  );
  const names = [...zipNames.keys()].filter(
    (name) => !name.endsWith("/") && !isJunk(name),
  );
  if (names.length === 0) throw new Error("The zip is empty.");
  const zipName = (name: string): string => zipNames.get(name) ?? name;

  // A book's folders at the top, or in one folder, as zipping a content folder makes.
  const first = (name: string) => name.split("/")[0];
  const second = (name: string) => name.split("/")[1];
  const top = first(names[0] ?? "");
  const wrapped =
    !isPartFolder(top) &&
    names.every((name) => first(name) === top && isPartFolder(second(name)));
  const book = wrapped || names.every((name) => isPartFolder(first(name)));

  let parts: { folder: PartFolder; name: string; files: Map<string, string> }[];
  if (book) {
    const prefix = wrapped ? `${top ?? ""}/` : "";
    const found = bookParts(names.map((name) => name.slice(prefix.length)));
    parts = [...found.values()].map((part) => ({
      ...part,
      files: new Map(
        [...part.files].map(([path, inside]) => [
          zipName(prefix + path),
          inside,
        ]),
      ),
    }));
  } else {
    const manifests = names.filter(
      (name) => name === MANIFEST || name.endsWith(`/${MANIFEST}`),
    );
    const [manifest, ...more] = manifests;
    if (manifest === undefined)
      throw new Error(`The zip has no ${MANIFEST}, so it isn't a plugin.`);
    if (more.length > 0)
      throw new Error(
        `The zip holds ${String(manifests.length)} plugins outside the content folders. Zip one plugin, or lay a book out as adventures/, rules/, assets/ and library/.`,
      );
    const prefix = manifest.slice(0, -MANIFEST.length);
    if (prefix.split("/").length > 2)
      throw new Error(
        `${manifest} is too deep in the zip. Zip the plugin's own folder.`,
      );
    const { id, kind } = readManifest(zip, zipName(manifest), manifest);
    const files = new Map<string, string>();
    for (const name of names) {
      if (!name.startsWith(prefix))
        throw new Error(`${name} is outside the plugin's folder in the zip.`);
      files.set(zipName(name), name.slice(prefix.length));
    }
    parts = [{ folder: KIND_FOLDERS[kind], name: id, files }];
  }

  let total = 0;
  for (const { folder, name, files } of parts) {
    const where = `${folder}/${name}`;
    const shared = SHARED_FILES.has(where);
    if (!shared && !PLUGIN_ID_PATTERN.test(name))
      throw new Error(`${where} isn't a folder name the game can install.`);
    for (const [entry, path] of files) {
      if (
        path.includes("\0") ||
        path.includes("\n") ||
        (!shared &&
          path
            .split("/")
            .some((part) => part === "" || part === "." || part === ".."))
      )
        throw new Error(`${entry} isn't a path the game can install.`);
      if (!FILE_TYPES[folder].has(extensionOf(shared ? name : path)))
        throw new Error(`${entry} isn't a file type ${folder}/ may hold.`);
      total += entries.get(entry) ?? 0;
    }
    if (folder !== "adventures" && folder !== "rules") continue;
    const manifest = [...files].find(([, path]) => path === MANIFEST)?.[0];
    if (manifest === undefined)
      throw new Error(`${where} has no ${MANIFEST}, so it isn't a plugin.`);
    const { id, kind } = readManifest(zip, manifest, `${where}/${MANIFEST}`);
    if (id !== name || KIND_FOLDERS[kind] !== folder)
      throw new Error(
        `${where}/${MANIFEST} names ${KIND_FOLDERS[kind]}/${id}.`,
      );
    const there = known.get(id);
    if (there?.startsWith("plugins/"))
      throw new Error(
        `The game already ships a plugin called ${id}, so this one can't replace it.`,
      );
    if (there !== undefined && there !== `books/${where}`)
      throw new Error(`You already have a plugin called ${id}, at ${there}.`);
  }
  if (total > MAX_UNPACKED_BYTES)
    throw new Error("The zip unpacks to more than 4 GB, which is too big.");
  return { parts };
}

// The plugins a plan installs, or else its folders, for the notice.
export function describePlan(plan: InstallPlan): string {
  const plugins = plan.parts.filter(
    ({ folder }) => folder === "adventures" || folder === "rules",
  );
  return (plugins.length > 0 ? plugins : plan.parts)
    .map(({ name }) => name)
    .join(", ");
}

// Each part is written into a hidden name beside it, and the parts are swapped in once all are written,
// so a failed download or write leaves what was there.
// shortcut: a failure while swapping can leave some parts new and some old; reinstalling fixes it.
// Says whether it replaced anything that was there.
export async function installPlan(
  zip: Uint8Array,
  plan: InstallPlan,
  call: typeof invoke = invoke,
): Promise<boolean> {
  const encoder = new TextEncoder();
  for (const { folder, name } of plan.parts)
    await call("content_install_begin", { folder, name });
  for (const { folder, name, files } of plan.parts) {
    for (const [entry, path] of files) {
      // The path heads the body, up to a newline, so the bytes go raw rather than as JSON numbers.
      const head = encoder.encode(
        `${folder}/${name}${path ? `/${path}` : ""}\n`,
      );
      const file = readEntry(zip, entry);
      const body = new Uint8Array(head.length + file.length);
      body.set(head);
      body.set(file, head.length);
      await call("content_install_file", body);
    }
  }
  let replaced = false;
  for (const { folder, name } of plan.parts)
    if (await call<boolean>("content_install_commit", { folder, name }))
      replaced = true;
  return replaced;
}
