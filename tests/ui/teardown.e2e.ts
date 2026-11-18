import { type Page, expect, test } from "@playwright/test";

// What the game screen leaves behind (issue #217): nothing of the board sounds once the player has gone
// back to the menu, and a drag the browser cancelled never moves the fighter.

// Into the first fight of the shipped adventure, on the fighter's own turn.
async function intoFight(page: Page): Promise<void> {
  // A monster's first sight covers the page with its picture until a click, as a player would dismiss it.
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
  const map = page.locator(".dnd-cell").first();
  const onward = page.getByRole("button", {
    name: /^(Carry on|Drive them off)$/,
  });
  await expect(async () => {
    if (await onward.first().isVisible()) await onward.first().click();
    else if (!(await map.isVisible())) await page.keyboard.press("Enter");
    await expect(map).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 30_000 });
}

test("leaving for the menu while the board plays ends its sounds", async ({
  page,
}) => {
  // Every sound the game makes starts with one of these, so their count is what was heard. Ambience
  // is off, as it would make its own.
  await page.addInitScript(() => {
    localStorage.setItem("re-roll:audio", JSON.stringify({ ambience: false }));
    const holder = window as unknown as { sounds: number };
    holder.sounds = 0;
    const base = BaseAudioContext.prototype;
    for (const make of ["createOscillator", "createBufferSource"]) {
      const real = Object.getOwnPropertyDescriptor(base, make)?.value as (
        this: BaseAudioContext,
      ) => AudioNode;
      Object.defineProperty(base, make, {
        value(this: BaseAudioContext) {
          holder.sounds += 1;
          return real.call(this);
        },
      });
    }
  });
  const sounds = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { sounds: number }).sounds);
  await intoFight(page);

  // Ending the turn hands the map to the goblins, whose attacks play one after another.
  await page.locator(".dnd-token.active").click();
  await page.locator(".dnd-menu button", { hasText: /^End/ }).click();
  await expect(page.locator(".dnd-board.playing")).toBeVisible();
  // The fight was heard at all. Waited for, as the first attack's sound can come a moment after play starts.
  await expect.poll(sounds).toBeGreaterThan(0);
  await page.getByText("Menu", { exact: true }).click();
  await page.getByRole("button", { name: "Main menu" }).click();
  await expect(
    page.getByRole("button", { name: "Ambush on the Old Road", exact: true }),
  ).toBeVisible();

  // Long enough for the goblins' whole turn, had it played on.
  const after = await sounds();
  await page.waitForTimeout(4000);
  expect(await sounds()).toBe(after);
});

test("a cancelled drag leaves the fighter where it stood", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await intoFight(page);

  const fighter = page.locator(".dnd-token.active");
  const start = await fighter.getAttribute("style");
  const from = await fighter.boundingBox();
  const to = await page.locator(".dnd-cell:not(.risky)").last().boundingBox();
  if (!from || !to) throw new Error("The map has no token or no lit square");
  const middle = (box: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => [box.x + box.width / 2, box.y + box.height / 2] as const;
  await page.mouse.move(...middle(from));
  await page.mouse.down();
  await page.mouse.move(...middle(to), { steps: 5 });
  await expect(fighter).toHaveClass(/dragging/);
  // As the browser does when it takes the pointer away, such as for a system gesture.
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })),
  );
  await expect(fighter).not.toHaveClass(/dragging/);
  // Let go over a lit square, which would have walked there.
  await page.mouse.up();
  await expect(page.locator("#app")).not.toHaveAttribute("aria-busy", "true");
  expect(await fighter.getAttribute("style")).toBe(start);

  // A drag let go on that square still walks there.
  await page.mouse.move(...middle(from));
  await page.mouse.down();
  await page.mouse.move(...middle(to), { steps: 5 });
  await page.mouse.up();
  await expect(fighter).not.toHaveAttribute("style", start ?? "");
  expect(errors).toEqual([]);
});
