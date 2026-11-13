import type { ShellContext } from "./context.ts";
import type { TermEntry } from "./session.ts";
import { excerpt, termFinder } from "./term-text.ts";
import { button, el } from "./dom.ts";

// Rules terms in the game's own text, such as a condition in the turn order, explained from the owner's
// books on hover, tap or "?", as a player would ask the DM. Only the page changes: the game never hears of it.

// Where the shell's own text may name a term. A system's own DOM, such as a board's tip, opts in with
// data-terms, and a click on a term there is the term's alone.
const PLACES = [
  ".log li.event",
  ".ticker li",
  ".option > button:first-child",
  ".option-detail",
  ".tags li",
  ".initiative .details",
  ".sheet-detail",
  ".sheet-sections h3",
  ".box-label",
  ".sheet-sections dt",
  ".sheet-sections dd",
  "[data-terms]",
].join(", ");
// A term inside one of these is hovered only, since a click there belongs to it; "?" reaches it by keyboard.
const INTERACTIVE = "button, summary, a, [data-terms]";
const OWN = "[data-terms] .term";

// Wraps each term's first mention in a place, leaving mentions already wrapped alone.
export function linkTerms(
  place: Element,
  find: ReturnType<typeof termFinder>,
): void {
  const linked = new Set(
    [...place.querySelectorAll<HTMLElement>(".term")].map(
      (node) => node.dataset.term,
    ),
  );
  const inLog = Boolean(place.closest(".log"));
  const walker = document.createTreeWalker(place, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(".term")) texts.push(node as Text);
  }
  for (const text of texts) {
    const found = find(text.data).filter(({ term }) => {
      if (linked.has(term.id)) return false;
      linked.add(term.id);
      return true;
    });
    if (found.length === 0) continue;
    const focusable = !inLog && !text.parentElement?.closest(INTERACTIVE);
    const parts: Node[] = [];
    let at = 0;
    for (const { index, word, term } of found) {
      parts.push(document.createTextNode(text.data.slice(at, index)));
      const span = el("span", { class: "term", text: word });
      span.dataset.term = term.id;
      if (focusable) {
        span.tabIndex = 0;
        span.setAttribute("role", "button");
        span.setAttribute("aria-haspopup", "dialog");
      }
      parts.push(span);
      at = index + word.length;
    }
    parts.push(document.createTextNode(text.data.slice(at)));
    text.replaceWith(...parts);
  }
}

export function wireTerms(ctx: ShellContext): void {
  let entries = new Map<string, TermEntry>();
  let find: ReturnType<typeof termFinder> = () => [];
  let loadedFor: Element | null = null; // the game screen the terms were read for
  const sections = new Map<string, Promise<string>>();

  const title = el("h4");
  const body = el("div");
  const others = el("p", { class: "term-others" });
  const more = button("More", () => undefined);
  const pop = el(
    "div",
    { class: "term-pop" },
    title,
    body,
    others,
    el("p", { class: "term-actions" }, more),
  );
  pop.setAttribute("role", "dialog");
  pop.hidden = true;
  document.body.append(pop);
  let anchor: HTMLElement | null = null;
  let opener: HTMLElement | null = null; // where focus goes back to
  let pinned = false;
  let returning = false;
  let shown = 0; // the latest show, so a slow read never lands on a newer one
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = (): void => {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    shown++;
    if (pop.hidden) return;
    const focusBack = pop.contains(document.activeElement);
    pop.hidden = true;
    pinned = false;
    anchor = null;
    const back = opener;
    opener = null;
    if (focusBack && back?.isConnected) {
      returning = true; // so the term it goes back to doesn't open again
      back.focus();
      returning = false;
    }
  };

  const place = (): void => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = Math.min(pop.offsetWidth, innerWidth - 16);
    const left = Math.max(8, Math.min(box.left, innerWidth - width - 8));
    const below = box.bottom + 6 + pop.offsetHeight <= innerHeight;
    pop.style.left = `${String(left)}px`;
    pop.style.top = `${String(below ? box.bottom + 6 : Math.max(8, box.top - 6 - pop.offsetHeight))}px`;
  };

  const show = async (
    target: HTMLElement,
    options: { pin: boolean; focus: boolean; also?: readonly HTMLElement[] },
  ): Promise<void> => {
    const entry = entries.get(target.dataset.term ?? "");
    if (!entry) return;
    clearTimeout(hideTimer);
    const mine = ++shown;
    const key = `${entry.book}/${entry.file}`;
    const read =
      sections.get(key) ?? ctx.game.readSection(entry.book, entry.file);
    sections.set(key, read);
    const text = await read.catch(() => "");
    if (mine !== shown || !target.isConnected || !text) return;
    const { title: heading, paragraphs } = excerpt(text, target.textContent);
    title.textContent = heading;
    pop.setAttribute("aria-label", heading);
    body.replaceChildren(...paragraphs.map((line) => el("p", { text: line })));
    const rest = (options.also ?? []).filter(
      (node) => node.dataset.term !== target.dataset.term,
    );
    others.replaceChildren(
      ...rest.map((node) =>
        button(node.textContent, () => {
          void show(node, { ...options, focus: true });
        }),
      ),
    );
    others.hidden = rest.length === 0;
    more.onclick = () => {
      hide();
      ctx.act(async () => {
        const books = await ctx.game.listBooks();
        await ctx.showBook(books, entry.book, {
          file: entry.file,
          back: () => {
            ctx.act(() => {
              ctx.showGame();
              return Promise.resolve();
            });
          },
        });
      });
    };
    anchor = target;
    pinned ||= options.pin;
    if (options.focus) opener ??= document.activeElement as HTMLElement;
    pop.hidden = false;
    place();
    if (options.focus) more.focus();
  };

  // Each game screen reads the terms afresh, as another adventure may use another system.
  const refresh = async (): Promise<void> => {
    const log = ctx.screen.querySelector(".log");
    if (log === loadedFor) return;
    loadedFor = log;
    const terms = log ? await ctx.game.terms().catch(() => []) : [];
    entries = new Map(terms.map((term) => [term.id, term]));
    find = termFinder(terms);
    document.documentElement.toggleAttribute(
      "data-rules-terms",
      terms.length > 0,
    );
    linkAll([ctx.screen]);
  };
  const linkAll = (roots: readonly Element[]): void => {
    if (entries.size === 0) return;
    const places = new Set<Element>();
    for (const root of roots) {
      const inside = root.closest(PLACES);
      if (inside) places.add(inside);
      for (const node of root.querySelectorAll(PLACES)) places.add(node);
    }
    for (const node of places) linkTerms(node, find);
    observer.takeRecords(); // its own changes
  };
  const observer = new MutationObserver((records) => {
    if (anchor && !anchor.isConnected) hide();
    void refresh();
    linkAll(
      records.flatMap((record) =>
        record.target instanceof Element ? [record.target] : [],
      ),
    );
  });
  observer.observe(ctx.screen, { childList: true, subtree: true });

  const termOf = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(".term") : null;

  document.addEventListener("pointerover", (event) => {
    if (pop.contains(event.target as Node)) {
      clearTimeout(hideTimer);
      return;
    }
    const term = termOf(event.target);
    if (!term || event.pointerType !== "mouse" || term === anchor) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (!pinned) void show(term, { pin: false, focus: false });
    }, 350);
  });
  document.addEventListener("pointerout", (event) => {
    clearTimeout(hoverTimer);
    const to = event.relatedTarget as Node | null;
    if (
      pinned ||
      pop.hidden ||
      (to && (pop.contains(to) || termOf(to) === anchor))
    )
      return;
    hideTimer = setTimeout(hide, 250);
  });
  // A tap or click opens a term where that's its own; elsewhere it closes an open one.
  const own = (event: Event): HTMLElement | null => {
    const term = termOf(event.target);
    return term &&
      (term.tabIndex === 0 || (term.matches(OWN) && !term.closest("button")))
      ? term
      : null;
  };
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (own(event)?.matches(OWN)) event.stopPropagation();
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      const term = own(event);
      if (term) {
        event.stopPropagation();
        void show(term, { pin: true, focus: false });
      } else if (!pop.contains(event.target as Node) && pinned) hide();
    },
    true,
  );
  document.addEventListener("focusin", (event) => {
    const term = termOf(event.target);
    if (returning) return;
    if (term?.tabIndex === 0) void show(term, { pin: false, focus: false });
    else if (!pop.contains(event.target as Node)) hide();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !pop.hidden) {
        event.preventDefault();
        event.stopPropagation();
        hide();
        return;
      }
      const focused = document.activeElement;
      if (
        !(focused instanceof HTMLElement) ||
        focused.matches("input, textarea, select")
      )
        return;
      const term = termOf(focused);
      if (term && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        void show(term, { pin: true, focus: true });
      } else if (event.key === "?" && !pop.contains(focused)) {
        // Every term the focused thing shows, such as a choice's label or a token's tip.
        const terms = [
          ...(term ? [term] : focused.querySelectorAll<HTMLElement>(".term")),
        ].filter(
          // Older WebKit has no checkVisibility, and then every term counts.
          (node) =>
            !("checkVisibility" in node) ||
            node.checkVisibility({ opacityProperty: true }),
        );
        const first = focused.matches(".log") ? terms.at(-1) : terms[0];
        if (!first) return;
        event.preventDefault();
        event.stopPropagation();
        const seen = new Set<string>();
        const also = terms.filter((node) => {
          const id = node.dataset.term ?? "";
          return !seen.has(id) && Boolean(seen.add(id));
        });
        void show(first, { pin: true, focus: true, also: also.slice(0, 6) });
      }
    },
    true,
  );
  addEventListener("resize", hide);
  document.addEventListener(
    "scroll",
    () => {
      if (!pinned) hide();
      else place();
    },
    true,
  );
}
