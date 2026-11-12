import type { GameView, RollLine } from "./session.ts";

// The Journal's tabs: the story so far, the rolls made, and the leads found. Also the small
// "why?" pop-over under the ticker, with the rolls of the latest choice. Knows no rule system:
// it shows the lines the system's roll seam wrote.

const SHOWN_ROLLS = 100; // the Rolls tab is a recent history, not the whole run

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
  ...children: readonly Node[]
): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  item.append(...children);
  return item;
}

// "Sera · Longsword → Goblin · 14 + 5 = 19 vs AC 15 ✓", with the mark spoken as a word.
function rollItem(roll: RollLine): HTMLLIElement {
  const mark =
    roll.success === null
      ? []
      : [
          node(
            "span",
            roll.success ? "roll-mark hit" : "roll-mark miss",
            roll.success ? " ✓" : " ✗",
          ),
        ];
  for (const item of mark) {
    item.setAttribute("aria-label", roll.success ? "success" : "failure");
  }
  return node(
    "li",
    "roll",
    undefined,
    node("span", "roll-who", roll.actor),
    document.createTextNode(` · ${roll.label} · `),
    node("span", "roll-math", roll.math),
    ...mark,
  );
}

export function journalTabs(story: HTMLElement): {
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  readonly update: (view: GameView) => void;
} {
  const rolls = node("ol", "rolls");
  rolls.setAttribute("aria-label", "Recent rolls, newest first");
  const leads = node("div", "leads");
  const panels = { Story: story, Rolls: rolls, Leads: leads } as const;
  type Tab = keyof typeof panels;
  let open: Tab = "Story";
  let last: GameView | null = null;
  let seen: number | null = null; // the step the leads were last looked at, so later ones are new

  const tabs = node("div", "tabs");
  const buttons = (Object.keys(panels) as Tab[]).map((name) => {
    const tab = node("button", "tab", name);
    tab.type = "button";
    tab.addEventListener("click", () => {
      open = name;
      if (last) update(last);
    });
    return [name, tab] as const;
  });
  tabs.append(...buttons.map(([, tab]) => tab));
  const head = node(
    "div",
    "journal-head",
    undefined,
    node("h2", "", "Journal"),
    tabs,
  );

  const update = (view: GameView): void => {
    last = view;
    seen ??= view.steps; // a loaded game's leads aren't news
    const unseen = view.leads.some((group) =>
      group.clues.some((clue) => clue.step >= (seen ?? 0)),
    );
    for (const [name, tab] of buttons) {
      tab.classList.toggle("open", name === open);
      tab.setAttribute("aria-pressed", String(name === open));
      tab.classList.toggle(
        "has-new",
        name === "Leads" && unseen && open !== "Leads",
      );
      panels[name].hidden = name !== open;
    }
    rolls.replaceChildren(
      ...(view.rolls.length === 0
        ? [node("li", "empty", "No rolls yet.")]
        : view.rolls
            .slice(-SHOWN_ROLLS)
            // The latest choice first, but its rolls in the order they happened, so damage follows its hit.
            .sort((a, b) => b.step - a.step)
            .map((roll, index, list) => {
              const item = rollItem(roll);
              item.classList.toggle(
                "new-step",
                list[index - 1]?.step !== roll.step && index > 0,
              );
              return item;
            })),
    );
    leads.replaceChildren(
      ...(view.leads.length === 0
        ? [
            node(
              "p",
              "empty",
              "No leads yet. The clues you find are kept here.",
            ),
          ]
        : view.leads.map((group) =>
            node(
              "ul",
              "lead",
              undefined,
              ...group.clues.map((clue) => {
                const fresh = clue.step >= (seen ?? 0);
                return node(
                  "li",
                  fresh ? "new" : "",
                  undefined,
                  ...(fresh ? [node("span", "new-mark", "New")] : []),
                  document.createTextNode(clue.text),
                );
              }),
            ),
          )),
    );
    // Marked new until the tab has been seen once, so the marks are there while the player reads.
    if (open === "Leads" && !leads.closest("dialog:not([open])"))
      seen = view.steps;
  };
  return {
    head,
    body: node("div", "journal-panels", undefined, story, rolls, leads),
    update,
  };
}

// "Why?" beside the ticker: the latest choice's rolls, opened on demand.
export function rollsWhy(): {
  readonly node: HTMLDetailsElement;
  readonly update: (view: GameView | null) => void;
} {
  const list = node("ol", "rolls");
  const why = node(
    "details",
    "rolls-why",
    undefined,
    node("summary", "", "Why?"),
    list,
  );
  why.hidden = true;
  why
    .querySelector("summary")
    ?.setAttribute("aria-label", "The rolls behind the latest result");
  return {
    node: why,
    update: (view) => {
      const latest =
        view?.rolls.filter((roll) => roll.step === view.steps - 1) ?? [];
      why.hidden = latest.length === 0;
      why.open = false;
      list.replaceChildren(...latest.map(rollItem));
    },
  };
}
