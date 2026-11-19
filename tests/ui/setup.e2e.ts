import { expect, test } from "./fixtures.ts";

// Before a game: the difficulty cards and variant switches; after it, the load screen shows the
// difficulty chosen, and Delete asks twice before it removes the save.
test("picks a difficulty, then finds and deletes its save", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();

  // Esc on the setup goes back to the menu.
  await expect(page.locator(".setup")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Choose an adventure" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();

  const card = (name: string) =>
    page.locator(".setting-card[role=radio]").filter({ hasText: name });
  await expect(card("Normal")).toHaveAttribute("aria-checked", "true");
  await card("Hard").click();
  await expect(card("Hard")).toHaveAttribute("aria-checked", "true");
  await expect(card("Normal")).toHaveAttribute("aria-checked", "false");

  // A variant rule is a switch, folded away until asked for.
  await page.locator(".variant-rules > summary").click();
  const variant = page.locator(".variant-rules [role=switch]").first();
  await expect(variant).toHaveAttribute("aria-checked", "false");
  await variant.click();
  await expect(variant).toHaveAttribute("aria-checked", "true");
  await variant.click();
  await expect(variant).toHaveAttribute("aria-checked", "false");

  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();
  await expect(page.locator(".hud")).toContainText("Hollis Brand");

  await page.locator(".game-menu > summary").click();
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.getByRole("button", { name: "Load a game (1)" }).click();
  const save = page.locator(".save-card:not(.skeleton)");
  await expect(save).toContainText("Hard");
  await expect(save).toContainText("Hollis Brand");

  // The first press arms Delete, Esc takes it back, and two presses delete.
  // Its name changes once armed, so it's found by its text.
  const remove = save
    .getByRole("button")
    .filter({ hasText: /^(Delete|Really delete\?)$/ });
  await remove.click();
  await expect(remove).toHaveText("Really delete?");
  await expect(remove).toHaveAccessibleName(/^Confirm delete /);
  await page.keyboard.press("Escape");
  await expect(remove).toHaveText("Delete");
  await remove.click();
  await remove.click();
  await expect(page.getByText("No saved games yet.")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("button", { name: /^Load a game/ })).toBeHidden();
});
