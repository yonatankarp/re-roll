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
  const variants = settings.filter((setting) => setting.variant);
  const groups = settings
    .filter((setting) => !setting.variant)
    .map((setting) => {
      const cards = setting.options.map((option) => {
        const card = button("", () => {
          chosen[setting.id] = option.id;
          for (const other of cards) {
            other.setAttribute("aria-checked", String(other === card));
            other.tabIndex = other === card ? 0 : -1;
          }
        });
        card.className = "setting-card";
        card.setAttribute("role", "radio");
        card.setAttribute(
          "aria-checked",
          String(option.id === setting.default),
        );
        // One tab stop for the group, on the chosen card; arrows move the choice, as radios do.
        card.tabIndex = option.id === setting.default ? 0 : -1;
        const detail = el("span", { text: option.detail });
        detail.id = `setting-${setting.id}-${option.id}`;
        card.setAttribute("aria-label", option.label);
        card.setAttribute("aria-describedby", detail.id);
        card.append(el("strong", { text: option.label }), detail);
        return card;
      });
      const group = el("div", { class: "setting-cards" }, ...cards);
      group.addEventListener("keydown", (event) => {
        const step = {
          ArrowRight: 1,
          ArrowDown: 1,
          ArrowLeft: -1,
          ArrowUp: -1,
        }[event.key];
        const at = cards.indexOf(event.target as HTMLButtonElement);
        if (step === undefined || at < 0) return;
        event.preventDefault();
        const next = cards[(at + step + cards.length) % cards.length];
        next?.focus();
        next?.click();
      });
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", setting.label);
      return el(
        "section",
        { class: "setting" },
        el("h3", { text: setting.label }),
        group,
      );
    });
  // Variant rules stay folded away, each a switch from its off option to its on one.
  const switches = variants.map((setting) => {
    const [off, on] = setting.options;
    const card = button("", () => {
      const turnedOn = chosen[setting.id] !== on?.id;
      chosen[setting.id] = (turnedOn ? on?.id : off?.id) ?? setting.default;
      card.setAttribute("aria-checked", String(turnedOn));
    });
    card.className = "setting-card";
    card.setAttribute("role", "switch");
    card.setAttribute("aria-checked", String(setting.default === on?.id));
    const detail = el("span", { text: on?.detail ?? "" });
    detail.id = `setting-${setting.id}`;
    card.setAttribute("aria-label", setting.label);
    card.setAttribute("aria-describedby", detail.id);
    card.append(el("strong", { text: setting.label }), detail);
    return card;
  });
  const drawer = el(
    "details",
    { class: "setting variant-rules" },
    el("summary", { text: "Variant rules" }),
    el("div", { class: "setting-cards" }, ...switches),
  );
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
    ...(switches.length > 0 ? [drawer] : []),
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
