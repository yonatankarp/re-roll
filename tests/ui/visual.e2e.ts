import { expect, test } from "./fixtures.ts";

// Screenshots of the first screens in each engine, so a layout that breaks in one of them fails.
// Screens whose content grows with the rules, such as the character sheet, are left out.
// Baselines come from the Linux CI runners (fonts render differently elsewhere), from a run without
// books/, so no private title is ever in one. A failed ui job uploads the new screenshots in its
// playwright-traces artifact (tests/ui/visual.e2e.ts-snapshots/): look at each, then commit them.
test.skip(process.platform !== "linux", "baselines are Linux CI's");

test("the menu and setup look as they did", async ({ page, problems }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const settled = () => page.evaluate("document.fonts.ready.then(() => true)");
  // Playwright's own styles for stilling animations and the caret are a <style>, which the CSP blocks.
  const look = {
    animations: "allow",
    caret: "initial",
    maxDiffPixelRatio: 0.01,
  } as const;

  try {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Ambush on the Old Road" }),
    ).toBeVisible();
    await settled();
    await expect(page).toHaveScreenshot("menu.png", look);

    await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
    await expect(page.locator(".setup")).toBeVisible({ timeout: 15_000 });
    await settled();
    await expect(page).toHaveScreenshot("setup.png", look);
  } finally {
    // WebKit's screenshots add a <style> of Playwright's own, from no file, as the app's code never is.
    const own = /^CSP: style-src-elem blocked inline at :\d+:\d+$/;
    const others = problems.filter((text) => !own.test(text));
    problems.splice(0, problems.length, ...others);
  }
});
