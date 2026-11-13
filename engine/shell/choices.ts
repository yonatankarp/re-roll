import type { Decision } from "../kernel/events.ts";
import type {
  CreationChoice,
  CreationView,
  OptionGroup,
  OptionView,
  SheetView,
  ShopView,
} from "./system-ui.ts";

// What the page shows the player to choose from, in one list, so the shell and headless play can't
// differ: the option list, the campfire's rests, a sheet row's own button, a merchant's cards, or a step
// of making a character. A merchant's or a character's step is drawn in place of the option list.

export interface ShownChoice {
  readonly id: string;
  readonly label: string;
  readonly where: "list" | "rest" | "sheet" | "shop" | "creation";
  readonly group: string | null; // the list's tab, such as Attacks, or the shop's Buy or Sell
  readonly detail: string | null;
  readonly sheet: string | null; // for a sheet row's button, whose sheet it's on
  readonly endsEarly: boolean; // ends the adventure while another choice carries on, so it asks first
}

export function shownChoices(parts: {
  readonly decision: Decision | null;
  readonly optionGroups: readonly OptionGroup[]; // empty while a shop or creation step stands in for them
  readonly rests: readonly OptionView[];
  readonly sheets: readonly SheetView[];
  readonly shop: ShopView | null;
  readonly creation: CreationView | null;
  readonly endsEarly: ReadonlySet<string>;
}): ShownChoice[] {
  const { decision, shop, creation } = parts;
  if (!decision) return [];
  const offered = new Set(decision.options.map((option) => option.id));
  // A hidden option still answers an older save, but its sheet row shows disabled, as Drink at full health.
  const shown = new Set(
    decision.options
      .filter((option) => !option.hidden)
      .map((option) => option.id),
  );
  const choice = (
    where: ShownChoice["where"],
    id: string,
    label: string,
    detail: string | null = null,
    group: string | null = null,
    sheet: string | null = null,
  ): ShownChoice => ({
    id,
    label,
    where,
    group,
    detail,
    sheet,
    endsEarly: parts.endsEarly.has(id),
  });
  const wares = shop
    ? [
        ...shop.buy.flatMap((ware) =>
          ware.option === null
            ? []
            : [
                choice(
                  "shop",
                  ware.option,
                  `Buy ${ware.name}`,
                  ware.price,
                  "Buy",
                ),
              ],
        ),
        ...shop.sell.flatMap((ware) =>
          ware.option === null
            ? []
            : [
                choice(
                  "shop",
                  ware.option,
                  `Sell ${ware.name}`,
                  ware.price,
                  "Sell",
                ),
              ],
        ),
        choice("shop", shop.leave, "Leave"),
      ]
    : [];
  // A step that asks for typed text, such as a name, takes the suggested answer too.
  const steps = creation
    ? [
        ...creation.choices.map((item) =>
          choice("creation", item.id, item.label, item.summary ?? null),
        ),
        ...sheetAnswers(creation)
          .filter((answer) => offered.has(answer.id))
          .map((answer) => choice("creation", answer.id, answer.label)),
        ...(decision.text
          ? decision.options
              .slice(0, 1)
              .map((option) => choice("creation", option.id, option.label))
          : []),
      ].filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      )
    : [];
  return [
    ...parts.optionGroups.flatMap((group) =>
      group.options.map((option) =>
        choice("list", option.id, option.label, option.detail, group.title),
      ),
    ),
    ...wares,
    ...steps,
    ...parts.rests.map((option) =>
      choice("rest", option.id, option.label, option.detail),
    ),
    // A row's button only on the sheet of whoever the decision is for, so a companion's row can't
    // answer for the player.
    ...parts.sheets.flatMap((sheet) =>
      sheet.id === decision.actor
        ? sheet.sections.flatMap((section) =>
            section.rows.flatMap(({ option, label, detail }) =>
              option && shown.has(option.id)
                ? [
                    choice(
                      "sheet",
                      option.id,
                      `${option.label} ${label}`,
                      detail ?? null,
                      null,
                      sheet.id,
                    ),
                  ]
                : [],
            ),
          )
        : [],
    ),
  ];
}

// Every answer the easy sheet's controls give: doors and their picks, groups, steppers, review and Next.
// creation-sheet-view.ts marks those that answer a listed option, as the rest of the shell does.
function sheetAnswers(
  creation: CreationView,
): { readonly id: string; readonly label: string }[] {
  const picks = (items: readonly CreationChoice[] = []) =>
    items.map((item) => ({ id: item.answer ?? item.id, label: item.label }));
  return [
    ...(creation.doors ?? []).flatMap((door) => [
      ...(door.answer ? [{ id: door.answer, label: door.label }] : []),
      ...picks(door.choices),
      ...(door.question?.answers ?? []).flatMap((answer) =>
        picks(answer.choices),
      ),
    ]),
    ...(creation.groups ?? []).flatMap((group) => picks(group.choices)),
    ...(creation.steppers?.rows ?? []).flatMap((row) => [
      ...(row.minus ? [{ id: row.minus, label: `Lower ${row.label}` }] : []),
      ...(row.plus ? [{ id: row.plus, label: `Raise ${row.label}` }] : []),
    ]),
    ...(creation.review ?? []).flatMap((row) =>
      row.change ? [{ id: row.change, label: `Change ${row.label}` }] : [],
    ),
    ...creation.steps.flatMap((step) =>
      step.answer ? [{ id: step.answer, label: step.title }] : [],
    ),
    ...(creation.next
      ? [{ id: creation.next.answer, label: creation.next.label }]
      : []),
  ];
}
