import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Connect, defineConfig } from "vite";
import {
  CONTENT_ROUTE,
  contentEndpoint,
} from "../../engine/platform/node/content-endpoint.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

// The desktop app's own headers and CSP, so vite preview serves the build as the app's webview does.
const tauri = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "src-tauri/tauri.conf.json"),
    "utf8",
  ),
) as {
  app: { security: { csp: string; headers: Record<string, string> } };
};
const { csp, headers } = tauri.app.security;

function serveContent(middlewares: Connect.Server): void {
  const handle = contentEndpoint(repoRoot);
  middlewares.use(CONTENT_ROUTE, (request, response) => {
    void handle(request, response);
  });
}

export default defineConfig({
  root: import.meta.dirname,
  // Nothing is copied into the build, so books/ can only ever reach the page through the endpoint.
  publicDir: false,
  clearScreen: false,
  // Found only when the narrator's worker first starts, which would reload the page mid-game.
  optimizeDeps: { include: ["kokoro-js", "@huggingface/transformers"] },
  worker: { format: "es" }, // the narrator's worker is a module, and its libraries use import.meta
  build: {
    outDir: resolve(repoRoot, "out/desktop"),
    emptyOutDir: true,
    // The CSP allows no data: URLs, so a small sound, font or picture is a file like any other.
    assetsInlineLimit: 0,
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    cors: false,
    // The same cross-origin isolation as tauri.conf.json, so the narrator's WASM can use threads in dev too.
    headers,
    fs: {
      // The default allows the whole repo, which would serve books/ around the endpoint's checks.
      allow: ["app/desktop", "engine", "plugins/systems", "node_modules"].map(
        (folder) => resolve(repoRoot, folder),
      ),
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/books/**"],
    },
  },
  // What npm run test:ui plays: the build, under the app's CSP, so a blocked style or host fails a test.
  preview: {
    host: "127.0.0.1",
    strictPort: true,
    cors: false,
    headers: { ...headers, "Content-Security-Policy": csp },
  },
  plugins: [
    {
      name: "re-roll-content",
      // Only exists on the dev and preview servers, so it can't end up in a build.
      configureServer: (server) => {
        serveContent(server.middlewares);
      },
      configurePreviewServer: (server) => {
        serveContent(server.middlewares);
      },
    },
  ],
});
