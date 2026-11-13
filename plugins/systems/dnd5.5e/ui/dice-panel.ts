import { el } from "./board-context.ts";
import { SKINS, chooseSkin, chosenSkin, preview } from "./dice-skins.ts";

// A "Dice…" entry for the game menu, opening a panel to pick the set your dice are thrown in. Like the
// shell's Sound panel, it's a dialog the shell places; the choice applies from the next throw.
export function dicePanel(): {
  readonly item: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
} {
  const dialog = document.createElement("dialog");
  dialog.className = "sound-panel dnd-dice-panel";
  dialog.setAttribute("aria-label", "Dice");
  const sets = el("div", "dnd-dice-sets");
  sets.setAttribute("role", "radiogroup");
  sets.setAttribute("aria-label", "Dice set");
  const chosen = chosenSkin().id;
  for (const skin of SKINS) {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "dnd-dice-set";
    radio.value = skin.id;
    radio.checked = skin.id === chosen;
    radio.addEventListener("change", () => {
      chooseSkin(skin.id);
    });
    const row = document.createElement("label");
    row.className = "dnd-dice-set";
    row.append(radio, preview(skin, 56), el("span", "", skin.name));
    sets.append(row);
  }
  const done = document.createElement("button");
  done.textContent = "Done";
  const form = document.createElement("form");
  form.method = "dialog";
  form.append(done);
  dialog.append(el("h2", "", "Dice"), sets, form);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  const item = document.createElement("button");
  item.type = "button";
  item.textContent = "Dice…";
  // The menu folds away as the panel opens, so focus goes back to the menu's own button after.
  dialog.addEventListener("close", () => {
    item.closest("details")?.querySelector("summary")?.focus();
  });
  item.addEventListener("click", () => {
    item.closest("details")?.removeAttribute("open");
    dialog.showModal();
  });
  return { item, dialog };
}
