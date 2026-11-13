import { expect, test } from "@playwright/test";

// Plays into the first fight of the shipped adventure by mouse, as a player would, and fails on any console error.
test("starts the shipped adventure and plays a turn on the map", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();
  await page
    .getByRole("button", { name: "[Perception] Check the treeline" })
    .click();

  // The check's die waits for a click, then a found item, the ambush or the fight's scene may come first.
  const map = page.locator(".dnd-cell").first();
  const onward = page.getByRole("button", {
    name: /^(Carry on|Drive them off)$/,
  });
  for (let tries = 0; tries < 20 && !(await map.isVisible()); tries += 1) {
    if (await onward.first().isVisible()) await onward.first().click();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
  }
  await expect(map).toBeVisible();

  const log = page.locator("ol.log > li");
  const before = await log.count();

  // The farthest lit square that gives no Opportunity Attack (any square, if all do) moves the fighter
  // there. The log doesn't record a move, but the fighter's token leaves its square.
  const fighter = page.locator(".dnd-token.active");
  const start = await fighter.getAttribute("style");
  const squares = page.locator(".dnd-cell");
  const safe = page.locator(".dnd-cell:not(.risky)");
  await ((await safe.count()) > 0 ? safe : squares).last().click();
  await expect(fighter).not.toHaveAttribute("style", start ?? "");

  // The fighter's own token offers its actions, such as Second Wind, once it has finished walking.
  const action = page.locator(".dnd-menu button").first();
  await expect(async () => {
    await fighter.click();
    await expect(action).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await action.click();
  await expect
    .poll(() => log.count(), { timeout: 15_000 })
    .toBeGreaterThan(before);

  expect(errors).toEqual([]);
});

// Builds a character on the sheet: a change, Undo, Next through every part, point-buy from the review,
// a name, then asks before the story's early ending.
test("makes a character and confirms an early ending", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Build it myself/ }).click();
  const current = page.locator(".creation-steps [aria-current=step]");
  const subtitle = page.locator(".sheet-card-subtitle");
  await expect(current).toHaveText("Species");
  await expect(subtitle).toContainText("Dwarf Fighter");
  await page.getByRole("button", { name: /^Elf/ }).click();
  await expect(subtitle).toContainText("Elf Fighter");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(subtitle).toContainText("Dwarf Fighter");

  // Next alone makes a sound character.
  for (const title of [
    "Class",
    "Background",
    "Abilities",
    "Skills & spells",
    "Name",
    "Review",
  ]) {
    await page.getByRole("button", { name: `Next: ${title}` }).click();
    await expect(current).toHaveText(title);
  }

  await page.getByRole("button", { name: "Change Abilities" }).click();
  await expect(current).toHaveText("Abilities");
  await page.getByRole("button", { name: /^Point buy/ }).click();
  await expect(page.getByText("0 of 27 points left")).toBeVisible();
  await page.getByRole("button", { name: "Lower Strength" }).click();
  await expect(page.getByText("2 of 27 points left")).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();

  await page.getByRole("button", { name: "Change Name" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Ilyra");
  await page.getByRole("button", { name: "Next: Review" }).click();
  await expect(page.locator(".sheet-card h4")).toHaveText("Ilyra");
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await expect(page.getByText("You are playing Ilyra").first()).toBeVisible();

  await page
    .getByRole("button", { name: "Turn back and warn the village" })
    .click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep playing" }).click();
  await expect(confirm).toBeHidden();
  await page
    .getByRole("button", { name: "Turn back and warn the village" })
    .click();
  await page.getByRole("button", { name: "End the adventure here" }).click();
  await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();

  expect(errors).toEqual([]);
});
