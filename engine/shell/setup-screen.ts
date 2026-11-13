import { type AdventureChoice } from "./session.ts";
import { CANT_OPEN, OPENING, type ShellContext } from "./context.ts";
import { button, el, picture } from "./dom.ts";

// Before a new game: the choices its system asks for, such as difficulty, then Begin.
export async function showSetup(
  ctx: ShellContext,
  adventure: AdventureChoice,
): Promise<void> {
  const settings = await ctx.game.settingsFor(adventure.id);
  const begin = (chosen: Readonly<Record<string, string>>): void => {
    ctx.act(
      async () => {
        await ctx.game.start(
          adventure.id,
          crypto.randomUUID().slice(0, 8),
          chosen,
        );
        ctx.showGame();
      },
      { busy: OPENING, failed: CANT_OPEN },
    );
  };
  if (settings.length === 0) {
    begin({});
    return;
  }
  const chosen: Record<string, string> = Object.fromEntries(
    settings.map((setting) => [setting.id, setting.default]),
  );
  const heading = el("h2", { text: adventure.title });
  heading.tabIndex = -1;
  const groups = settings.map((setting) => {
    const cards = setting.options.map((option) => {
      const card = button("", () => {
        chosen[setting.id] = option.id;
        for (const other of cards) {
          other.setAttribute("aria-checked", String(other === card));
        }
      });
      card.className = "setting-card";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(option.id === setting.default));
      card.append(
        el("strong", { text: option.label }),
        el("span", { text: option.detail }),
      );
      return card;
    });
    const group = el("div", { class: "setting-cards" }, ...cards);
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", setting.label);
    return el(
      "section",
      { class: "setting" },
      el("h3", { text: setting.label }),
      group,
    );
  });
  const go = button("Begin the adventure", () => {
    begin({ ...chosen });
  });
  go.className = "begin";
  ctx.actions.replaceChildren(
    button("Menu", () => {
      ctx.act(ctx.showMenu);
    }),
  );
  const setup = el(
    "section",
    { class: "setup" },
    ...(adventure.cover
      ? [picture(ctx.game, adventure.cover, "", "setup-cover")]
      : []),
    heading,
    ...(adventure.levels
      ? [el("p", { class: "meta", text: `Levels ${adventure.levels}` })]
      : []),
    ...(adventure.blurb
      ? [el("p", { class: "setup-blurb", text: adventure.blurb })]
      : []),
    ...groups,
    go,
  );
  ctx.screen.replaceChildren(setup);
  ctx.keys = {
    owner: setup,
    handle: (event) => {
      if (event.key !== "Escape") return false;
      ctx.act(ctx.showMenu);
      return true;
    },
  };
  ctx.focusNext = heading;
}
