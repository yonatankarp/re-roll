import { expect, test } from "./fixtures.ts";
import { playUntil } from "./onward.ts";

// The fight's map by hand: drag the hero to a square, open its menu and close it, and zoom.
test("drags a token, opens a token's menu and zooms the map", async ({
  page,
}) => {
  await page.addLocatorHandler(page.locator(".art-plate"), (plate) =>
    plate.click(),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();
  await page
    .getByRole("button", { name: /Perception ?\] Check the treeline$/ })
    .click();
  const hero = page.locator('.dnd-token[data-id="player"]');
  // The fight is the player's to act in once a square lights up to move to.
  const lit = page.locator(".dnd-cell[data-option]");
  await playUntil(page, async () => (await lit.count()) > 0);

  // Dragging the hero onto a lit square walks it there.
  const safe = page.locator(".dnd-cell[data-option]:not(.risky)");
  const target = ((await safe.count()) > 0 ? safe : lit).last();
  const start = await hero.getAttribute("style");
  const from = await hero.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("The hero or the square isn't on screen");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 8,
  });
  await expect(hero).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect(hero).not.toHaveClass(/dragging/);
  await expect(hero).not.toHaveAttribute("style", start ?? "");

  // The hero's own token opens a menu of what it can do (a foe's does the one thing it can, or says
  // why it can't), and Esc closes it. A click while the walk plays out only hurries it along.
  const board = page.locator(".dnd-board");
  const menu = page.locator(".dnd-menu");
  await expect(board).not.toHaveClass(/playing/, { timeout: 15_000 });
  await hero.click();
  await expect(
    menu.getByRole("button", { name: "End your turn" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The zoom buttons, the wheel with Control, and Fit to go back.
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  const zoomOut = page.getByRole("button", { name: "Zoom out" });
  await expect(zoomOut).toBeDisabled();
  await zoomIn.click();
  await expect(board).toHaveClass(/zoomed/);
  await expect(zoomOut).toBeEnabled();
  await page.getByRole("button", { name: "Fit the map" }).click();
  await expect(board).not.toHaveClass(/zoomed/);
  const field = await page.locator(".dnd-field").boundingBox();
  if (!field) throw new Error("The map isn't on screen");
  await page.mouse.move(field.x + field.width / 2, field.y + field.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect(board).toHaveClass(/zoomed/);
});
