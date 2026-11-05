import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fillScenes, readAloudText } from "./tools/fill-read-aloud.ts";

const HTML = `
<h2 class="x" id="First" data-content-chunk-id="not-this">First</h2>
<aside class="text--quote-box"><p>Skip me.</p></aside>
<aside class="text--quote-box">
<p>One &amp; <a href="#">done</a>.</p>
<p>Two&#39;s  here.</p>
</aside>
<h3 id="Next">Next</h3>
<aside class="text--quote-box"><p>Under next.</p></aside>`;

describe("fill-read-aloud", () => {
  it("picks boxes under the heading, decodes text and stops at the next heading", () => {
    expect(readAloudText(HTML, { heading: "First", boxes: [1] })).toBe(
      "One & done.\n\nTwo's here.",
    );
    expect(() =>
      readAloudText(HTML, { heading: "First", boxes: [2] }),
    ).toThrow();
    expect(readAloudText(HTML, { heading: "Next", boxes: [0] })).toBe(
      "Under next.",
    );
  });

  it("selects paragraphs and never matches a chunk id as the anchor", () => {
    expect(
      readAloudText(HTML, { heading: "First", boxes: [1], paragraphs: [0] }),
    ).toBe("One & done.");
    expect(() =>
      readAloudText(HTML, { heading: "not-this", boxes: [0] }),
    ).toThrow();
  });

  it("rewrites only mapped scenes and keeps comments", () => {
    const yaml = "# note\n- id: a\n  text: old\n- id: b\n  text: kept\n";
    const out = fillScenes(HTML, yaml, {
      a: { heading: "Next", boxes: [0] },
    });
    expect(out).toContain("# note");
    expect(parse(out)).toEqual([
      { id: "a", text: "Under next." },
      { id: "b", text: "kept" },
    ]);
    expect(() =>
      fillScenes(HTML, yaml, { missing: { heading: "Next", boxes: [0] } }),
    ).toThrow();
  });
});
