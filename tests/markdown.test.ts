import { describe, expect, it } from "vitest";
import { parseMarkdown, spans } from "../engine/shell/markdown.ts";

describe("book markdown", () => {
  it("reads headings, paragraphs, lists, tables and quotes", () => {
    const blocks = parseMarkdown(
      [
        "## A Room",
        "",
        "Some *dusty* text",
        "on two lines.",
        "",
        "- one",
        "- two **bold**",
        "",
        "1. first",
        "2. second",
        "",
        "| Roll | Result |",
        "|---|:--:|",
        "| 1 | A [link](x.md) |",
        "",
        "> A quote",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "table",
      "quote",
    ]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      spans: [
        { text: "Some " },
        { text: "dusty", italic: true },
        { text: " text on two lines." },
      ],
    });
    expect(blocks[3]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[4]).toEqual({
      kind: "table",
      rows: [
        [[{ text: "Roll" }], [{ text: "Result" }]],
        [[{ text: "1" }], [{ text: "A link" }]],
      ],
    });
  });

  it("keeps snake_case words and bold-italic", () => {
    expect(spans("a_b and ***c***")).toEqual([
      { text: "a_b and " },
      { text: "c", bold: true, italic: true },
    ]);
  });
});

describe("nested marks", () => {
  it("reads bold inside italic", () => {
    expect(spans("***Name.** Text* and 2 * 3")).toEqual([
      { text: "Name.", bold: true, italic: true },
      { text: " Text", italic: true },
      { text: " and 2 * 3" },
    ]);
  });
});
