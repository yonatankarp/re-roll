import { type Page, expect } from "@playwright/test";

// Plays the story on until `ready` holds: clicks the scene's way on, or presses Enter for a die that waits for one.
// It retries on Playwright's own clock and fails with its timeout, never after a fixed number of sleeps.
export async function playUntil(
  page: Page,
  ready: () => Promise<boolean>,
): Promise<void> {
  // Alert asks to swap Initiative as a fight starts; until it's answered a map lights no squares.
  const onward = page
    .getByRole("button", {
      name: /^(Carry on|Drive them off|Keep your place)$/,
    })
    .first();
  await expect(async () => {
    if (await ready()) return;
    if (await onward.isVisible()) await onward.click();
    else await page.keyboard.press("Enter");
    expect(await ready()).toBe(true);
  }).toPass({ intervals: [300], timeout: 30_000 });
}
