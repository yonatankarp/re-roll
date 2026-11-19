import { expect, test } from "./fixtures.ts";

// The Sound panel's settings last over a reload, and narration asks before it downloads the voice,
// then fetches it only from the host the CSP allows, and says why when it can't.
test("keeps sound settings and asks before downloading the narrator", async ({
  page,
}) => {
  const voice: string[] = [];
  // Ahead of the fixture's own abort, to see what the narrator's worker asked for.
  await page.route(
    /^https:\/\/([^/]+\.)?(huggingface\.co|hf\.co)\//,
    (route) => {
      voice.push(route.request().url());
      return route.abort();
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Ambush on the Old Road" }).click();
  await page.getByRole("button", { name: "Begin the adventure" }).click();
  await page.getByRole("button", { name: /^Pick a ready hero/ }).click();
  await page.getByRole("button", { name: /^Human Fighter/ }).click();

  const openSound = async () => {
    await page.locator(".game-menu > summary").click();
    await page.getByRole("button", { name: "Sound…" }).click();
    const panel = page.getByRole("dialog", { name: "Sound" });
    await expect(panel).toBeVisible();
    return panel;
  };
  const narration = page.locator(".narration");
  await expect(narration).toBeHidden(); // off until the player turns it on

  let panel = await openSound();
  await expect(panel.getByLabel("Ambience")).toBeChecked();
  await expect(panel.getByLabel("Narration")).not.toBeChecked();
  await panel.getByLabel("Ambience").uncheck();
  await panel.getByLabel("Narration").check();
  await panel.getByLabel("Narrator").selectOption("bm_george");
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel).toBeHidden();

  // Nothing is fetched until the player says so.
  const download = narration.getByRole("button", { name: "Download voice" });
  await expect(download).toBeVisible();
  expect(voice).toEqual([]);
  await download.click();
  await expect(narration.getByRole("status")).toHaveText(
    /^The narrator couldn't read this scene/,
  );
  await expect(
    narration.getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  expect(voice.length).toBeGreaterThan(0);
  for (const url of voice) {
    expect(url).toMatch(
      /^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\//,
    );
  }

  await page.reload();
  await page.getByRole("button", { name: /^Continue / }).click();
  panel = await openSound();
  await expect(panel.getByLabel("Ambience")).not.toBeChecked();
  await expect(panel.getByLabel("Narration")).toBeChecked();
  await expect(panel.getByLabel("Narrator")).toHaveValue("bm_george");
});
