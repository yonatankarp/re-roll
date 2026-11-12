import { type Game, type GameView } from "./session.ts";
import {
  type CombatView,
  type SheetRow,
  type SheetSection,
  type SheetView,
} from "./system-ui.ts";
import { el, picture } from "./dom.ts";

// A system's sheets and turn order, drawn from the plain data in SheetView and CombatView.

export function renderCombat(
  game: Game,
  combat: CombatView,
  art: GameView["monsterArt"],
): HTMLElement {
  return el(
    "section",
    { class: "combat" },
    el("h3", { text: combat.title }),
    el(
      "ol",
      { class: "initiative" },
      ...combat.combatants.map((actor) => {
        const portrait = art[actor.id];
        const item = el(
          "li",
          {
            class: `${actor.active ? "active" : ""} ${portrait ? "has-art" : ""}`,
          },
          ...(portrait
            ? [picture(game, portrait, actor.name, "portrait")]
            : []),
          el("span", {
            class: "who",
            text: `${actor.active ? "▶\uFE0E " : ""}${actor.name}`, // drawn as text, never as an emoji
          }),
          el("span", { class: "side", text: actor.side }),
          el("span", { class: "details", text: actor.details.join(" · ") }),
        );
        if (actor.active) item.setAttribute("aria-current", "true");
        return item;
      }),
    ),
  );
}

// A sheet row's own choice, such as Equip, as a button while the pending decision offers it.
type RowOption = (row: SheetRow) => Node[];

function detailsRow(
  label: string,
  value: string,
  detail: string,
  extra: Node[] = [],
): HTMLElement {
  return el(
    "details",
    { class: "sheet-detail" },
    el(
      "summary",
      {},
      el("span", { text: label }),
      ...(value ? [el("span", { class: "sheet-value", text: value })] : []),
      ...extra,
    ),
    el("p", { text: detail }),
  );
}

function renderSection(
  section: SheetSection,
  rowOption: RowOption,
): HTMLElement {
  const heading = el("h3", { text: section.title });
  switch (section.layout) {
    case "boxes":
      return el(
        "section",
        {},
        heading,
        el(
          "div",
          { class: "boxes" },
          ...section.rows.map((row) =>
            el(
              "div",
              { class: "box" },
              el("span", { class: "box-label", text: row.label }),
              el("span", { class: "box-value", text: row.value }),
              ...(row.note
                ? [el("span", { class: "box-note", text: row.note })]
                : []),
            ),
          ),
        ),
      );
    case "marks":
      return el(
        "section",
        {},
        heading,
        el(
          "ul",
          { class: "marks" },
          ...section.rows.map((row) => {
            const dot = el("span", { class: "mark" });
            dot.setAttribute(
              "aria-label",
              row.marked ? (section.mark ?? "") : "",
            );
            return el(
              "li",
              { class: row.marked ? "marked" : "" },
              dot,
              el("span", { class: "mark-value", text: row.value }),
              el("span", { text: row.label }),
              ...(row.note
                ? [el("span", { class: "mark-note", text: row.note })]
                : []),
            );
          }),
        ),
      );
    default: // a plain list
      return el(
        "section",
        {},
        heading,
        el(
          "dl",
          {},
          ...section.rows.flatMap((row) =>
            row.detail
              ? []
              : [
                  el("dt", { text: row.label }),
                  el("dd", { text: row.value }, ...rowOption(row)),
                ],
          ),
        ),
        ...section.rows.flatMap((row) =>
          row.detail
            ? [detailsRow(row.label, row.value, row.detail, rowOption(row))]
            : [],
        ),
      );
  }
}

// The side panel shows the pinned sections; the full sheet shows them all.
export function renderSheet(
  sheet: SheetView,
  full: boolean,
  rowOption: RowOption = () => [],
): HTMLElement {
  return el(
    "section",
    { class: full ? "sheet-body full" : "sheet-body" },
    el(
      "header",
      { class: "sheet-head" },
      el("h2", { text: sheet.title }),
      ...(sheet.subtitle
        ? [el("p", { class: "sheet-subtitle", text: sheet.subtitle })]
        : []),
      ...(sheet.tags && sheet.tags.length > 0
        ? [
            el(
              "ul",
              { class: "tags" },
              ...sheet.tags.map((tag) => el("li", { text: tag })),
            ),
          ]
        : []),
    ),
    el(
      "div",
      { class: "sheet-sections" },
      ...sheet.sections
        .filter((section) => section.rows.length > 0)
        .filter((section) => full || section.pinned)
        .map((section) => renderSection(section, rowOption)),
    ),
  );
}

// A bar from 0 to 1, such as hit points left.
export function meter(share: number): HTMLElement {
  const fill = el("i");
  fill.style.width = `${String(Math.round(Math.max(0, Math.min(1, share)) * 100))}%`;
  fill.dataset.level = share > 0.5 ? "high" : share > 0.25 ? "mid" : "low";
  return el("span", { class: "meter" }, fill);
}
