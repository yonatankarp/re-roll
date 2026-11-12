import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { systems } from "../app/systems.ts";
import { buildLibrary } from "../engine/tools/library.ts";
import { approveImport, importParsed } from "../engine/tools/import.ts";
import { checkPlugins } from "../engine/tools/check-pack.ts";
import {
  parseBudgetsFromHtml,
  parseHazardsFromHtml,
  parsePoisonsFromHtml,
  parseRollTable,
  parseTablesFromHtml,
  parseTrapsFromHtml,
} from "../plugins/systems/dnd5.5e/core/import/tables.ts";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";
import {
  EncounterBudgetSchema,
  HazardSchema,
  PoisonSchema,
  RollTableSchema,
  TrapSchema,
} from "../plugins/systems/dnd5.5e/core/schemas.ts";
import { memoryStorage } from "./memory-storage.ts";

// Every page here is invented.
const table = (head: string[], rows: string[][], caption = "") =>
  `<table><caption>${caption ? `<h4 id="c">${caption}</h4>` : ""}</caption><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

const BOOK = `<html><head><title>Test Tome</title></head><body>
<h1 id="Ch1">Chapter One: Lands</h1><p>Intro words here.</p>
<h2 id="Moss">Mossy Keep</h2>
<p>A <strong>damp</strong> keep &amp; its cellar.</p>
<aside class="text--quote-box"><p>Read this aloud.</p></aside>
${table(
  ["Roll", "Smell"],
  [
    ["1", "Rot"],
    ["2", "a|b"],
  ],
  "Smells",
)}
<h4 id="Deep">Deep Cellar</h4><ul><li>one</li><li>two</li></ul>
<h2 id="Empty">Nothing Here</h2>
<h2 id="Gob">Goblin NPCs</h2><p>Grizzle is sly.</p>
<figure><p>art credit</p></figure>
</body></html>`;

describe("reference library", () => {
  const library = buildLibrary(BOOK);

  it("writes one file per heading with its path, anchor and a kind", () => {
    expect(library.title).toBe("Test Tome");
    expect(library.entries.map((e) => [e.path, e.anchor])).toEqual([
      [["Chapter One: Lands"], "Ch1"],
      [["Chapter One: Lands", "Mossy Keep"], "Moss"],
      [["Chapter One: Lands", "Goblin NPCs"], "Gob"],
    ]);
    expect(library.entries.map((e) => e.kind)).toEqual([
      "location",
      "location",
      "npc",
    ]);
    expect(library.entries.every((e) => e.words > 0)).toBe(true);
  });

  it("keeps tables, quotes, emphasis and deeper headings, and drops art", () => {
    const keep = library.files.get(library.entries[1]?.file ?? "") ?? "";
    expect(keep).toContain("A **damp** keep & its cellar.");
    expect(keep).toContain("> Read this aloud.");
    expect(keep).toContain("**Smells**");
    expect(keep).toContain(
      "| Roll | Smell |\n| --- | --- |\n| 1 | Rot |\n| 2 | a\\|b |",
    );
    expect(keep).toContain("#### Deep Cellar\n\n- one\n\n- two");
    expect([...library.files.values()].join("")).not.toContain("art credit");
  });
});

describe("roll tables", () => {
  const d100 = table(
    ["d100", "Find"],
    [
      ["01–50", "Dust"],
      ["51–99", "Coin"],
      ["00", "Gem"],
    ],
    "Finds",
  );

  it("reads ranges, treating 00 as 100 on a d100", () => {
    expect(parseRollTable(d100)).toEqual({
      die: "d100",
      columns: ["Find"],
      rows: [
        { min: 1, max: 50, cells: ["Dust"] },
        { min: 51, max: 99, cells: ["Coin"] },
        { min: 100, max: 100, cells: ["Gem"] },
      ],
    });
  });

  it("ignores other tables, drops footnotes, and rejects gaps", () => {
    expect(parseRollTable(table(["Level", "XP"], [["1", "50"]]))).toBeNull();
    const noted = table(
      ["1d4", "Item"],
      [["1", "A"], ["2–3", "B"], ["4", "C"], ["* note"]],
    );
    expect(parseRollTable(noted)).toMatchObject({ rows: [{}, {}, {}] });
    expect(
      parseRollTable(
        table(
          ["d6", "x"],
          [
            ["1", "A"],
            ["3–6", "B"],
          ],
        ),
      ),
    ).toEqual({ problem: "gap or overlap" });
    expect(parseRollTable(table(["d6", "x"], [["1–5", "A"]]))).toEqual({
      problem: "doesn't reach the die's top",
    });
    expect(parseRollTable(table(["d6", "x"], [["1–6", "A", "B"]]))).toEqual({
      problem: "ragged row",
    });
  });

  it("names tables from the caption or the nearest heading and keeps names unique", () => {
    const html = `<title>Test Tome</title><h3>Market</h3>${d100}${table(
      ["d2", "R"],
      [
        ["1", "x"],
        ["2", "y"],
      ],
    )}${table(
      ["d2", "R"],
      [
        ["1", "x"],
        ["2", "y"],
      ],
    )}`;
    const parsed = parseTablesFromHtml(html, "tome");
    expect(parsed.map((p) => p.slug)).toEqual(["finds", "market", "market-2"]);
    for (const { entry } of parsed)
      expect(RollTableSchema.safeParse(entry).success).toBe(true);
    expect(parsed[0]?.entry).toMatchObject({
      id: "tome:table/finds",
      source: "Test Tome: Market",
    });
  });
});

describe("traps, hazards, poisons and budgets", () => {
  const html = `<title>Test Tome</title>
<h3>Example Traps</h3>
<h4 id="a">Falling Rock</h4><p><em>Deadly Trap (Levels 5–10)</em></p>
<p><strong>Trigger:</strong> Step on the plate.</p><p><strong>Duration:</strong> Instantaneous</p>
<p>Make a DC 13 Dexterity save or take 22 (4d10) damage.</p>
${table(
  ["Levels", "Damage", "Save DC"],
  [
    ["5–10", "22 (4d10)", "15"],
    ["11–16", "55 (10d10)", "17"],
  ],
)}
<h3>Example Hazards</h3>
<h4 id="b">Bad Mold</h4><p><em>Nuisance Hazard (Levels 1–4)</em></p><p>Spores with DC 11 and DC 12 saves.</p>
<h3>Sample Poisons</h3>
<h4 id="c">Grim Draught (1,500 GP)</h4><p><em>Ingested Poison</em></p><p>Make a DC 17 Constitution save.</p>
${table(["", "Encounter Difficulty"], [])}
${table(
  ["Party’s Level", "Low", "Moderate", "High"],
  [
    ["1", "50", "75", "100"],
    ["2", "100", "150", "200"],
  ],
  "XP Budget per Character",
)}`;

  it("parses fields code can read", () => {
    const [trap] = parseTrapsFromHtml(html, "tome");
    expect(trap?.entry).toMatchObject({
      id: "tome:trap/falling-rock",
      severity: "deadly",
      levels: [{ min: 5, max: 10 }],
      trigger: "Step on the plate.",
      duration: "Instantaneous",
      dcs: [13],
      scaling: [
        { levels: { min: 5, max: 10 }, dc: 15, damage: "22 (4d10)" },
        { levels: { min: 11, max: 16 }, dc: 17, damage: "55 (10d10)" },
      ],
    });
    const [hazard] = parseHazardsFromHtml(html, "tome");
    expect(hazard?.entry).toMatchObject({
      severity: "nuisance",
      dcs: [11, 12],
    });
    const [poison] = parsePoisonsFromHtml(html, "tome");
    expect(poison?.entry).toMatchObject({
      name: "Grim Draught",
      costGp: 1500,
      delivery: "ingested",
      dc: 17,
    });
    const [budget] = parseBudgetsFromHtml(html, "tome");
    expect(budget?.entry).toMatchObject({
      rows: [
        { level: 1, low: 50, moderate: 75, high: 100 },
        { level: 2, low: 100, moderate: 150, high: 200 },
      ],
    });
    expect(TrapSchema.safeParse(trap?.entry).success).toBe(true);
    expect(HazardSchema.safeParse(hazard?.entry).success).toBe(true);
    expect(PoisonSchema.safeParse(poison?.entry).success).toBe(true);
    expect(EncounterBudgetSchema.safeParse(budget?.entry).success).toBe(true);
  });

  it("skips headings that aren't the entry shape", () => {
    expect(
      parseTrapsFromHtml("<h4>Falling Rock</h4><p>Just prose.</p>", "tome"),
    ).toEqual([]);
  });
});

async function srdFiles(): Promise<Record<string, string>> {
  const root = "plugins/rules/srd52";
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    files[path] = await readFile(path, "utf8");
  }
  return files;
}

describe("imported tables in a plugin", () => {
  it("load and pass check-pack", async () => {
    const storage = memoryStorage(await srdFiles());
    const html = `<title>Test Tome</title>${table(
      ["d4", "Omen"],
      [
        ["1", "a"],
        ["2", "b"],
        ["3", "c"],
        ["4", "d"],
      ],
      "Omens",
    )}`;
    for (const folder of ["tables"]) {
      const summary = await importParsed({
        storage,
        system: dnd55e,
        pluginId: "tome",
        folder,
        html,
      });
      expect(summary).toMatchObject({ written: 1, invalid: [] });
      await approveImport({
        storage,
        system: dnd55e,
        pluginId: "tome",
        folder,
        slugs: "all",
        requires: [{ plugin: "srd52", version: "^1" }],
      });
    }
    const report = await checkPlugins(storage, ["plugins", "books"], systems);
    expect(report.issues).toEqual([]);
    expect(report.checked).toContain("tome");
  });
});
