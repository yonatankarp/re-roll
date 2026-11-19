import { expect, test } from "./fixtures.ts";
import { tauriIpc } from "./tauri-ipc.ts";

// The Store, which only the desktop app shows, through a faked Tauri: adding stores, one that reads
// and one that doesn't, a token kept and forgotten, and Remove asking twice.
const INDEX = JSON.stringify({
  format: 1,
  packages: [
    {
      id: "fixture-pack",
      title: "Fixture Pack",
      file: "fixture-pack.zip",
      size: 1024 ** 2,
      sha256: "a".repeat(64),
      parts: ["adventures/fixture-pack"],
      plugins: [
        {
          id: "fixture-pack",
          kind: "adventure",
          version: "1.0.0",
          distribution: "private",
          requires: [],
        },
      ],
    },
  ],
});

test("adds stores, lists what they offer and removes one", async ({ page }) => {
  await page.addInitScript(tauriIpc({ "fixture/store/store.json": INDEX }));
  await page.goto("/");
  // The desktop reader found the shipped adventures, and the menu offers the desktop's own options.
  await expect(
    page.getByRole("button", { name: "Ambush on the Old Road" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open content folder" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Store", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^No stores yet/)).toBeVisible();

  const repo = page.getByRole("textbox", { name: "Store repo" });
  const token = page.getByLabel("GitHub token");
  const add = page.getByRole("button", { name: "Add", exact: true });
  await repo.fill("not a repo");
  await add.click();
  await expect(page.getByText("That isn't a GitHub repo.")).toBeVisible();

  // A link to the repo works as well as owner/repo, and its packages are offered.
  await repo.fill("https://github.com/fixture/store");
  await add.click();
  await expect(
    page.getByRole("heading", { name: "fixture/store", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Fixture Pack · 1 MB · Install" }),
  ).toBeEnabled();

  // A store that can't be read says so; its token is kept until forgotten.
  await repo.fill("fixture/missing");
  await token.fill("not-a-real-token");
  await add.click();
  const missing = page
    .locator("section.menu > section")
    .filter({ has: page.getByRole("heading", { name: /^fixture\/missing/ }) });
  await expect(missing.getByRole("heading")).toHaveText(
    "fixture/missing (with a token)",
  );
  await expect(missing).toContainText("This store couldn't be read.");
  await missing.getByRole("button", { name: "Forget its token" }).click();
  await expect(missing.getByRole("heading")).toHaveText("fixture/missing");

  const remove = missing
    .getByRole("button")
    .filter({ hasText: /^(Remove|Really remove\?)$/ });
  await remove.click();
  await expect(remove).toHaveText("Really remove?");
  await remove.click();
  await expect(missing).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "fixture/store", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose an adventure" }),
  ).toBeVisible();
});
