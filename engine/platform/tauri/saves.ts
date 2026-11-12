import { invoke } from "@tauri-apps/api/core";
import type { SaveFiles } from "../browser/storage.ts";

const SAVES = "saves/";
const GZIP = [0x1f, 0x8b];

// A save path as one bare file name, percent-encoded down to letters, digits, "-", "_", "." and "%",
// which main.rs's save_path checks again. ".gz" marks the file as gzipped.
function fileName(path: string): string {
  // A leading "." too, since main.rs keeps dot files for its temporary files.
  const name = encodeURIComponent(path.slice(SAVES.length)).replace(
    /[!'()*~]|^\./g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${name}.gz`;
}

function pathOf(name: string): string | null {
  if (!name.endsWith(".gz")) return null;
  try {
    return `${SAVES}${decodeURIComponent(name.slice(0, -".gz".length))}`;
  } catch {
    return null;
  }
}

// Saves are mostly repeated event names, so gzip makes them about 13 times smaller.
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reads plain text too, so a file someone unzipped or wrote by hand still loads.
export async function gunzip(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== GZIP[0] || bytes[1] !== GZIP[1]) {
    return new TextDecoder().decode(bytes);
  }
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

type Invoke = typeof invoke;

// Saves as files in app_data_dir()/saves, through the app's own commands (src-tauri/src/main.rs).
// invoke is passed in by tests.
export function createTauriSaves(call: Invoke = invoke): SaveFiles {
  return {
    async read(path) {
      const bytes = new Uint8Array(
        await call<ArrayBuffer>("save_read", { name: fileName(path) }),
      );
      return bytes.length === 0 ? null : gunzip(bytes);
    },
    async write(path, contents) {
      await call("save_write", await gzip(contents), {
        headers: { name: fileName(path) },
      });
    },
    async list() {
      const names = await call<string[]>("save_list");
      return names.flatMap((name) => pathOf(name) ?? []);
    },
    async remove(path) {
      await call("save_remove", { name: fileName(path) });
    },
  };
}
