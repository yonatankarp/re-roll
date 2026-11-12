import type { ShopCard, ShopView } from "./system-ui.ts";

// A merchant's screen in place of the choices: the merchant, the purse, and Buy and Sell tabs of item cards.
// Knows no rules: every card's button answers the pending decision with the option the system gave it.

type Tab = "buy" | "sell";
const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
];

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  item.textContent = text;
  return item;
}

export function shopPanel(
  answer: (optionId: string) => void,
  coin: () => void, // played on a trade, when sound is on
): {
  readonly element: HTMLElement;
  readonly update: (view: ShopView | null) => void;
  readonly focusTarget: () => HTMLElement | null; // where focus goes after a redraw, while open
} {
  const element = node("section", "shop");
  element.hidden = true;
  let tab: Tab = "buy";
  let shown: ShopView | null = null;
  let refocus: string | null = null; // the card traded, so focus stays there after the redraw

  const head = node("header", "shop-head");
  const title = node("h3", "");
  const purse = node("p", "shop-purse");
  head.append(title, purse);
  const tabList = node("div", "shop-tabs");
  tabList.setAttribute("role", "tablist");
  const panel = node("div", "shop-wares");
  panel.setAttribute("role", "tabpanel");
  panel.id = "shop-wares";
  const leave = node("button", "shop-leave", "Leave");
  leave.type = "button";
  leave.addEventListener("click", () => {
    if (shown) answer(shown.leave);
  });

  const tabButtons = TABS.map(({ id, label }) => {
    const item = node("button", "shop-tab", label);
    item.type = "button";
    item.id = `shop-tab-${id}`;
    item.setAttribute("role", "tab");
    item.setAttribute("aria-controls", panel.id);
    item.addEventListener("click", () => {
      tab = id;
      draw();
    });
    // Arrow keys move between tabs, as a tab list does.
    item.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      tab = tab === "buy" ? "sell" : "buy";
      draw();
      tabButtons.find((other) => other.id === `shop-tab-${tab}`)?.focus();
    });
    return item;
  });
  tabList.append(...tabButtons);
  element.append(head, tabList, panel, leave);

  const card = (ware: ShopCard, index: number): HTMLElement => {
    const item = node("article", "ware");
    item.dataset.item = ware.item;
    item.style.setProperty("--i", String(index));
    const verb = tab === "buy" ? "Buy" : "Sell";
    const trade = node("button", "ware-trade");
    trade.type = "button";
    trade.append(
      node("span", "", verb),
      node("span", "ware-price", ware.price),
    );
    trade.setAttribute("aria-label", `${verb} ${ware.name} for ${ware.price}`);
    trade.disabled = ware.option === null;
    const { option } = ware;
    if (option !== null) {
      trade.addEventListener("click", () => {
        refocus = ware.item;
        coin();
        answer(option);
      });
    }
    item.append(
      node("h4", "", ware.name),
      ...(ware.summary ? [node("p", "ware-summary", ware.summary)] : []),
      ...(ware.note ? [node("p", "ware-note", ware.note)] : []),
      trade,
    );
    return item;
  };

  const draw = (): void => {
    if (!shown) return;
    title.textContent = shown.merchant;
    purse.textContent = `Your purse: ${shown.purse}`;
    for (const item of tabButtons) {
      const on = item.id === `shop-tab-${tab}`;
      item.setAttribute("aria-selected", String(on));
      item.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", `shop-tab-${tab}`);
    const wares = shown[tab];
    panel.replaceChildren(
      ...(wares.length > 0
        ? wares.map(card)
        : [
            node(
              "p",
              "ware-none",
              tab === "buy" ? "Nothing left to buy." : "Nothing they'll buy.",
            ),
          ]),
    );
  };

  return {
    element,
    update: (view) => {
      const opening = view !== null && shown === null;
      shown = view;
      element.hidden = view === null;
      if (!view) return;
      if (opening) tab = "buy";
      draw();
    },
    // After a trade, focus stays on that card, or goes to the first still on offer once it's gone.
    focusTarget: () => {
      if (!shown) return null;
      const again =
        refocus === null
          ? null
          : panel.querySelector<HTMLButtonElement>(
              `[data-item="${CSS.escape(refocus)}"] button:not(:disabled)`,
            );
      refocus = null;
      return (
        again ??
        panel.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
        leave
      );
    },
  };
}
