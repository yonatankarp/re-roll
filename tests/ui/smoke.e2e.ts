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
  await page.getByRole("button", { name: "Human Fighter" }).click();
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

  // A lit square that doesn't provoke an Opportunity Attack moves the fighter there, which the log doesn't record.
  const squares = page.locator(".dnd-cell");
  await page.locator(".dnd-cell:not(.risky)").last().click();
  await expect(squares).toHaveCount(0); // a full move leaves no squares to move to

  // The fighter's own token offers its actions, such as Second Wind, once it has finished walking.
  const action = page.locator(".dnd-menu button").first();
  await expect(async () => {
    await page.locator(".dnd-token.active").click();
    await expect(action).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await action.click();
  await expect
    .poll(() => log.count(), { timeout: 15_000 })
    .toBeGreaterThan(before);

  expect(errors).toEqual([]);
});
