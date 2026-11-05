import { resolve } from "node:path";
import { defineConfig } from "vite";
import {
  CONTENT_ROUTE,
  contentEndpoint,
} from "../../engine/platform/node/content-endpoint.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  root: import.meta.dirname,
  // Nothing is copied into the build, so private/ can only ever reach the page through the endpoint.
  publicDir: false,
  clearScreen: false,
  build: {
    outDir: resolve(repoRoot, "out/desktop"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
    cors: false,
    fs: {
      // The default allows the whole repo, which would serve private/ around the endpoint's checks.
      allow: ["app/desktop", "engine", "plugins/systems", "node_modules"].map(
        (folder) => resolve(repoRoot, folder),
      ),
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/private/**"],
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
