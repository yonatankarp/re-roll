import { resolve } from "node:path";
import { defineConfig } from "vite";
import {
  CONTENT_ROUTE,
  contentEndpoint,
} from "../../engine/platform/node/content-endpoint.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

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
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    cors: false,
    // The same cross-origin isolation as tauri.conf.json, so the narrator's WASM can use threads in dev too.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // The default allows the whole repo, which would serve books/ around the endpoint's checks.
      allow: ["app/desktop", "engine", "plugins/systems", "node_modules"].map(
        (folder) => resolve(repoRoot, folder),
      ),
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/books/**",
        "**/books/**",
      ],
    },
  },
  plugins: [
    {
      name: "re-roll-content",
      // Only exists on the dev server, so it can't end up in a build.
      configureServer(server) {
        const handle = contentEndpoint(repoRoot);
        server.middlewares.use(CONTENT_ROUTE, (request, response) => {
          void handle(request, response);
        });
      },
    },
  ],
});
