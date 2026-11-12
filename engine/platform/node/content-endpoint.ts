import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { parseContentPath } from "../browser/content-path.ts";
import { createNodeStorage } from "./storage.ts";

export { type ContentPath, parseContentPath } from "../browser/content-path.ts";

// The dev server's read-only window onto plugins/ and books/, for a browser that can't read files.

export const CONTENT_ROUTE = "/__content";

// No SVG: opened directly it could run scripts on this origin.
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg", // narration clips, read through the same route as pictures
};

function isHidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  cache = "no-store",
): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

// A name that resolves to 127.0.0.1 could otherwise read books/ from another site (DNS rebinding).
function isLocalHost(host: string | undefined): boolean {
  const name = host?.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost";
}

export function contentEndpoint(repoRoot: string) {
  // One storage per folder, so its real-path check also catches a symlink to elsewhere in the repo.
  const open = async (folder: string) => {
    try {
      return await createNodeStorage(join(repoRoot, folder));
    } catch (error) {
      if (isMissing(error)) return null; // books/ is optional
      throw error;
    }
  };

  // The url is relative to CONTENT_ROUTE: /read?path=..., /list?path=... or /image?path=...
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const text = "text/plain; charset=utf-8";
    if (request.method !== "GET") {
      send(response, 405, text, "Read-only");
      return;
    }
    if (!isLocalHost(request.headers.host)) {
      send(response, 403, text, "Forbidden host");
      return;
    }
    const url = new URL(request.url ?? "", "http://127.0.0.1");
    const parsed = parseContentPath(url.searchParams.get("path") ?? "");
    if (!parsed) {
      send(response, 403, text, "Path is outside the content folders");
      return;
    }
    const { folder, rest } = parsed;
    try {
      const storage = await open(folder);
      if (url.pathname === "/read") {
        const contents = (await storage?.read(rest)) ?? null;
        if (contents === null) send(response, 404, text, "Not found");
        else send(response, 200, text, contents);
      } else if (url.pathname === "/image") {
        const type = IMAGE_TYPES[rest.split(".").pop()?.toLowerCase() ?? ""];
        const contents = type ? await storage?.readBytes(rest) : null;
        if (!type || !contents) send(response, 404, text, "Not found");
        // Redraws rebuild the page, and a picture shouldn't flicker each time.
        else send(response, 200, type, contents, "private, max-age=3600");
      } else if (url.pathname === "/list") {
        const entries = (await storage?.list(rest)) ?? [];
        send(
          response,
          200,
          "application/json",
          JSON.stringify(
            entries
              .filter((entry) => !isHidden(entry.path))
              .map((entry) => ({
                ...entry,
                path: `${folder}/${entry.path}`,
              })),
          ),
        );
      } else {
        send(response, 404, text, "Not found");
      }
    } catch {
      // Covers symlinks that leave the folder. The reason stays out of the response.
      send(response, 403, text, "Refused");
    }
  };
}
