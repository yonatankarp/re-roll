/// <reference lib="dom" />
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { openHeadless } from "../../app/cli/headless-game.ts";
import { savedFiles } from "./saved-files.ts";

// The page and headless play must offer the same choices. At each screen, the run the page autosaved is
// loaded headless, and what the page lets the player click is compared with the headless screen's choices.

// Every enabled button that answers the decision, as where it's drawn and the option it answers. The
// campfire's are only counted while it's open, since its last rests stay in the closed dialog.
function clickable(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-choice]")]
    .filter(
      (item) =>
        !item.disabled &&
        !item.closest("[hidden]") &&
        !item.closest("dialog.campfire:not([open])"),
    )
    .map((item) => {
      const where = item.closest(".campfire")
        ? "rest"
        : item.classList.contains("row-option")
          ? "sheet"
          : item.closest(".shop")
            ? "shop"
            : item.closest(".creation")
              ? "creation"
              : "list";
      return `${where}:${item.dataset.choice ?? ""}`;
    });
}

// What the page shows, with every tab of a turn opened, its longer lists unfolded, and the campfire lit.
async function onPage(page: Page): Promise<string[]> {
  await expect(page.locator(".settling")).toHaveCount(0);
  const shown = new Set<string>();
  const grab = async (): Promise<void> => {
    for (const id of await page.evaluate(clickable)) shown.add(id);
  };
  const more = page.locator("button.more");
  const unfold = async (): Promise<void> => {
    if (await more.isVisible()) await more.click();
  };
  await unfold();
  await grab();
  // Each of the character's doors opened, and each answer to a door's question.
  const doors = page.locator(".sheet-door:not([data-choice])");
  for (let index = 0; index < (await doors.count()); index += 1) {
    await doors.nth(index).click();
    const styles = page.locator(".sheet-styles .creation-pick");
    for (let style = 0; style < (await styles.count()); style += 1) {
      await styles.nth(style).click();
      await grab();
      await page.getByRole("button", { name: "Another answer" }).click();
    }
    await grab();
    await page.getByRole("button", { name: "All the ways in" }).click();
  }
  const tabs = page.locator(".options > .tabs > .tab");
  for (let index = 0; index < (await tabs.count()); index += 1) {
    await tabs.nth(index).click();
    await unfold();
    await grab();
  }
  const campfire = page.locator(".campfire-button");
  if (
    (await campfire.isVisible()) &&
    (await campfire.getAttribute("aria-disabled")) === "false"
  ) {
    await campfire.click();
    await expect(page.locator("dialog.campfire[open]")).toBeVisible();
    await grab();
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.locator("dialog.campfire[open]")).toHaveCount(0);
  }
  return [...shown].sort();
}

// The same run, loaded headless from the page's autosave.
async function headless(page: Page, folder: string): Promise<string[]> {
  const saves = Object.entries(await savedFiles(page)).filter(([key]) =>
    key.endsWith("-autosave.json"),
  );
  expect(saves).toHaveLength(1);
  const [[path, save]] = saves as [[string, string]];
  const play = await openHeadless(folder); // makes its saves folder
  await writeFile(join(folder, path), save);
  await play.load(path);
  const screen = play.screen();
  expect(screen.problems).toEqual([]);
  return [
    ...new Set(screen.choices.map((choice) => `${choice.where}:${choice.id}`)),
  ].sort();
}

test("the page and headless play offer the same choices", async ({ page }) => {
  const folder = await mkdtemp(join(tmpdir(), "re-roll-agree-"));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const agree = async (): Promise<string[]> => {
    const shown = await onPage(page);
    expect(shown).toEqual(await headless(page, folder));
    return shown;
  };
  try {
    // A monster's first sight covers the page with its picture until a click, as a player would dismiss it.
    await page.addLocatorHandler(page.locator(".art-plate"), (plate) =>
      plate.click(),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
    await page.getByRole("button", { name: "Begin the adventure" }).click();

    // Choosing a character, then the first scene, with its rests and the sheet's buttons.
    expect((await agree()).every((id) => id.startsWith("creation:"))).toBe(
      true,
    );
    await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
    await page.getByRole("button", { name: /^Human Fighter/ }).click();
    await expect(page.locator(".options.story")).toBeVisible();
    const scene = await agree();
    expect(scene.some((id) => id.startsWith("list:"))).toBe(true);
    expect(scene.some((id) => id.startsWith("rest:"))).toBe(true);

    // Into the fight, until the player's turn waits on the page.
    await page
      .getByRole("button", { name: "[Perception] Check the treeline" })
      .click();
    const map = page.locator(".dnd-cell").first();
    const turn = page.locator(".options > .tabs > .tab").first();
    const onward = page.getByRole("button", {
      name: /^(Carry on|Drive them off)$/,
    });
    for (let tries = 0; tries < 40; tries += 1) {
      if (
        (await map.isVisible()) &&
        (await turn.isVisible()) &&
        (await page.locator(".settling").count()) === 0
      ) {
        break;
      }
      if (await onward.first().isVisible()) await onward.first().click();
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
    }
    await expect(turn).toBeVisible();
    const fight = await agree();
    expect(fight.filter((id) => id.startsWith("list:")).length).toBeGreaterThan(
      1,
    );
    expect(errors).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
