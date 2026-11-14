import type { StoreIndex, StorePackage } from "./store-index.ts";
import { StoreIndexSchema, STORE_INDEX } from "./store-index.ts";
import {
  type PackageStatus,
  type StoreState,
  installOrder,
  packageStatus,
  parseRepo,
  readStoreState,
  verifyDownload,
} from "./store.ts";
import type { ShellContext } from "./context.ts";
import { button, el } from "./dom.ts";

// The Store: books and adventures from GitHub repos the player adds, public or private.
// Only the desktop app can download and install, so it hands its host in and the browser shows no Store.

export interface StoreHost {
  readonly fetch: (repo: string, file: string) => Promise<Uint8Array>;
  // Says whether the OS keychain kept the token, rather than only until the app closes.
  readonly setToken: (repo: string, token: string) => Promise<boolean>;
  readonly forgetToken: (repo: string) => Promise<void>;
  readonly hasToken: (repo: string) => Promise<boolean>;
  readonly readState: () => Promise<string | null>;
  readonly writeState: (text: string) => Promise<void>;
  // The id of every plugin the game has.
  readonly plugins: () => Promise<ReadonlySet<string>>;
  readonly install: (zip: Uint8Array) => Promise<void>;
  // The game keeps what it read, such as art and book text, so new content needs a fresh page.
  readonly reload: () => void;
}

let host: StoreHost | null = null;

export function offerStore(storeHost: StoreHost): void {
  host = storeHost;
}

export function storeOption(ctx: ShellContext): HTMLElement[] {
  const store = host;
  if (!store) return [];
  return [
    el(
      "div",
      { class: "options" },
      button("Store", () => {
        ctx.act(() => showStore(ctx, store));
      }),
    ),
  ];
}

const LABEL: Readonly<Record<PackageStatus, string>> = {
  install: "Install",
  update: "Update",
  installed: "Installed",
  present: "Reinstall",
};

const megabytes = (size: number): string =>
  `${(size / 1024 ** 2).toFixed(size < 1024 ** 2 ? 1 : 0)} MB`;

type Loaded =
  | { readonly repo: string; readonly index: StoreIndex }
  | { readonly repo: string; readonly error: string };

async function loadIndex(store: StoreHost, repo: string): Promise<Loaded> {
  try {
    const text = new TextDecoder().decode(await store.fetch(repo, STORE_INDEX));
    const index = StoreIndexSchema.safeParse(JSON.parse(text));
    return index.success
      ? { repo, index: index.data }
      : {
          repo,
          error: `${repo}'s ${STORE_INDEX} isn't one this game can read.`,
        };
  } catch (error) {
    return {
      repo,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function showStore(
  ctx: ShellContext,
  store: StoreHost,
): Promise<void> {
  ctx.actions.replaceChildren(
    button("Menu", () => {
      ctx.act(ctx.showMenu);
    }),
  );
  const state = readStoreState(await store.readState());
  const [loaded, present, tokens] = await Promise.all([
    Promise.all(state.repos.map((repo) => loadIndex(store, repo))),
    store.plugins(),
    Promise.all(state.repos.map((repo) => store.hasToken(repo))),
  ]);
  const stores = new Map(
    loaded.flatMap((entry) =>
      "index" in entry ? [[entry.repo, entry.index]] : [],
    ),
  );
  const save = (next: StoreState) => store.writeState(JSON.stringify(next));
  const redraw = () => showStore(ctx, store);

  const install = (repo: string, pkg: StorePackage) => {
    ctx.act(
      async () => {
        const steps = installOrder({ repo, pkg }, stores, present);
        let next = state;
        const done: string[] = [];
        for (const [at, step] of steps.entries()) {
          try {
            ctx.busyText.textContent = `Downloading ${step.pkg.title} (${String(at + 1)} of ${String(steps.length)})…`;
            const zip = await store.fetch(step.repo, step.pkg.file);
            await verifyDownload(zip, step.pkg);
            ctx.busyText.textContent = `Installing ${step.pkg.title}…`;
            await store.install(zip);
          } catch (error) {
            // What was installed stays, but the game only reads it afresh after a restart.
            if (done.length === 0) throw error;
            const reason =
              error instanceof Error ? error.message : String(error);
            throw new Error(
              `Installed ${done.join(", ")}, but not ${step.pkg.title}: ${reason} Restart the game to use what was installed.`,
            );
          }
          done.push(step.pkg.title);
          next = {
            ...next,
            installed: {
              ...next.installed,
              [step.pkg.id]: { repo: step.repo, sha256: step.pkg.sha256 },
            },
          };
          await save(next);
        }
        store.reload();
      },
      { busy: "Downloading…" },
    );
  };

  const sections = loaded.map((entry, at) => {
    const { repo } = entry;
    const controls = el(
      "div",
      { class: "options" },
      ...(tokens[at]
        ? [
            button("Forget its token", () => {
              ctx.act(async () => {
                await store.forgetToken(repo);
                await redraw();
              });
            }),
          ]
        : []),
      button("Remove this store", () => {
        ctx.act(async () => {
          await store.forgetToken(repo);
          await save({
            ...state,
            repos: state.repos.filter((other) => other !== repo),
          });
          await redraw();
        });
      }),
    );
    const packages =
      "index" in entry
        ? entry.index.packages.map((pkg) => {
            const status = packageStatus(repo, pkg, state, present);
            const choice = button(
              `${pkg.title} · ${megabytes(pkg.size)} · ${LABEL[status]}`,
              () => {
                install(repo, pkg);
              },
            );
            choice.disabled = status === "installed";
            return choice;
          })
        : [el("p", { class: "error", text: entry.error })];
    return el(
      "section",
      {},
      el("h3", { text: `${repo}${tokens[at] ? " (with a token)" : ""}` }),
      el("div", { class: "options" }, ...packages),
      controls,
    );
  });

  // Adding a repo that's already there only sets its token.
  const repoField = el("input", { class: "search" });
  repoField.placeholder = "owner/repo, or a link to it on GitHub";
  repoField.setAttribute("aria-label", "Store repo");
  const tokenField = el("input", { class: "search" });
  tokenField.type = "password";
  tokenField.autocomplete = "off";
  tokenField.placeholder = "Token, for a private repo (optional)";
  tokenField.setAttribute("aria-label", "GitHub token");
  const add = el(
    "form",
    {},
    el("h3", { text: "Add a store" }),
    repoField,
    tokenField,
    el("div", { class: "options" }, el("button", { text: "Add" })),
  );
  add.addEventListener("submit", (event) => {
    event.preventDefault();
    const repo = parseRepo(repoField.value);
    const token = tokenField.value.trim();
    tokenField.value = "";
    if (!repo) {
      ctx.say("That isn't a GitHub repo. Write it as owner/repo.", true);
      return;
    }
    ctx.act(async () => {
      const kept = token ? await store.setToken(repo, token) : true;
      if (!state.repos.includes(repo))
        await save({ ...state, repos: [...state.repos, repo] });
      await redraw();
      if (!kept)
        ctx.say(
          "This computer has no keychain the game can use, so the token lasts until the game closes.",
        );
    });
  });

  const heading = el("h2", { text: "Store" });
  heading.tabIndex = -1;
  ctx.screen.replaceChildren(
    el(
      "section",
      { class: "menu" },
      heading,
      ...(state.repos.length === 0
        ? [
            el("p", {
              text: "Add a GitHub repo that publishes a store, such as one made with npm run store:pack, to install its books and adventures.",
            }),
          ]
        : sections),
      add,
    ),
  );
  ctx.focusNext = heading;
}
