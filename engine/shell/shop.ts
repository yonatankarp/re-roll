import type { ShopCard, ShopView } from "./system-ui.ts";
import { el } from "./dom.ts";

// A merchant's screen in place of the choices: the merchant, the purse, and Buy and Sell tabs of item cards.
// Knows no rules: every card's button answers the pending decision with the option the system gave it.

type Tab = "buy" | "sell";
const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
];

export function shopPanel(
  answer: (optionId: string) => void,
  coin: () => void, // played on a trade, when sound is on
): {
  readonly element: HTMLElement;
  readonly update: (view: ShopView | null) => void;
  readonly focusTarget: () => HTMLElement | null; // where focus goes after a redraw, while open
} {
  const element = el("section", { class: "shop" });
  element.hidden = true;
  let tab: Tab = "buy";
  let shown: ShopView | null = null;
  let refocus: string | null = null; // the card traded, so focus stays there after the redraw

  const head = el("header", { class: "shop-head" });
  const title = el("h3");
  const purse = el("p", { class: "shop-purse" });
  head.append(title, purse);
  const tabList = el("div", { class: "shop-tabs" });
  tabList.setAttribute("role", "tablist");
  const panel = el("div", { class: "shop-wares" });
  panel.setAttribute("role", "tabpanel");
  panel.id = "shop-wares";
  const leave = el("button", { class: "shop-leave", text: "Leave" });
  leave.type = "button";
  leave.addEventListener("click", () => {
    if (shown) answer(shown.leave);
  });

  const tabButtons = TABS.map(({ id, label }) => {
    const item = el("button", { class: "shop-tab", text: label });
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
    const item = el("article", { class: "ware" });
    item.dataset.item = ware.item;
    item.style.setProperty("--i", String(index));
    const verb = tab === "buy" ? "Buy" : "Sell";
    const trade = el("button", { class: "ware-trade" });
    trade.type = "button";
    trade.append(
      el("span", { text: verb }),
      el("span", { class: "ware-price", text: ware.price }),
    );
    trade.setAttribute("aria-label", `${verb} ${ware.name} for ${ware.price}`);
    trade.disabled = ware.option === null;
    const { option } = ware;
    if (option !== null) {
      trade.dataset.choice = option;
      trade.addEventListener("click", () => {
        refocus = ware.item;
        coin();
        answer(option);
      });
    }
    item.append(
      el("h4", { text: ware.name }),
      ...(ware.summary
        ? [el("p", { class: "ware-summary", text: ware.summary })]
        : []),
      ...(ware.note ? [el("p", { class: "ware-note", text: ware.note })] : []),
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
            el("p", {
              class: "ware-none",
              text:
                tab === "buy" ? "Nothing left to buy." : "Nothing they'll buy.",
            }),
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
      leave.dataset.choice = view.leave;
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
