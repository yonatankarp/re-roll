// The desktop app's side of invoke(), faked in the page, so a test plays the Tauri build's own paths
// (main.ts under isTauri(): its reader, saves and Store) in a browser. Content reads go to the preview
// server's /__content route, saves stay in memory, and `store` answers the Store's downloads.
// Sent to the page as text, since the test project has no DOM types. Any other command fails the test.
export function tauriIpc(store: Readonly<Record<string, string>>): string {
  return `(() => {
  const store = ${JSON.stringify(store)};
  const saves = new Map();
  const tokens = new Set();
  const bytes = (text) => new TextEncoder().encode(text).buffer;
  const content = (path) => path.replace(/^\\/+/, "");
  const get = async (action, path) => {
    const response = await fetch("/__content/" + action + "?path=" + encodeURIComponent(content(path)));
    if (response.status === 404) throw new Error("No such file or directory (os error 2)");
    if (!response.ok) throw new Error(action + " " + path + ": " + response.status);
    return response;
  };
  const list = async (path) => (await (await get("list", path)).json()).map((entry) => entry.path);
  const commands = {
    content_roots: () => ({ plugins: "/plugins", books: "/books" }),
    "plugin:path|join": ({ paths }) => paths.join("/"),
    "plugin:fs|exists": async ({ path }) => (await list(path).catch(() => [])).length > 0,
    "plugin:fs|read_dir": async ({ path }) => {
      const folder = content(path) + "/";
      const children = new Map();
      for (const entry of await list(path)) {
        if (!entry.startsWith(folder)) continue;
        const [name, ...deeper] = entry.slice(folder.length).split("/");
        children.set(name, children.get(name) || deeper.length > 0);
      }
      return [...children].map(([name, isDirectory]) => ({ name, isDirectory, isFile: !isDirectory, isSymlink: false }));
    },
    "plugin:fs|read_text_file": async ({ path }) => (await get("read", path)).arrayBuffer(),
    "plugin:fs|read_file": async ({ path }) => (await get("image", path)).arrayBuffer(),
    "plugin:window|set_title": () => null,
    save_list: () => [...saves.keys()],
    save_read: ({ name }) => saves.get(name) ?? new ArrayBuffer(0),
    save_write: (body, options) => { saves.set(options.headers.name, new Uint8Array(body).slice().buffer); return null; },
    save_remove: ({ name }) => { saves.delete(name); return null; },
    store_fetch: ({ repo, file }) => {
      const text = store[repo + "/" + file];
      if (text === undefined) throw new Error("Not found: " + repo + "/" + file);
      return bytes(text);
    },
    store_token_has: ({ repo }) => tokens.has(repo),
    store_token_set: ({ repo }) => { tokens.add(repo); return true; },
    store_token_forget: ({ repo }) => { tokens.delete(repo); return null; },
    open_content_folder: () => null,
  };
  let callbacks = 0;
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (callback) => { const id = ++callbacks; window["_" + id] = callback; return id; },
    invoke: async (command, args, options) => {
      const run = commands[command];
      if (!run) throw new Error("The test's Tauri has no command " + command);
      return run(args, options);
    },
  };
})();`;
}
