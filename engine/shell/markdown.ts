// A book section's Markdown as the page shows it: headings, paragraphs, lists, tables and quotes,
// with bold and italic. Parsing is plain data, so tests need no DOM; drawing only ever sets text,
// never HTML, so nothing in a book can run in the page.

export interface Span {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
}

export type Block =
  | {
      readonly kind: "heading";
      readonly level: number;
      readonly spans: readonly Span[];
    }
  | { readonly kind: "paragraph"; readonly spans: readonly Span[] }
  | { readonly kind: "quote"; readonly spans: readonly Span[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly Span[])[];
    }
  | {
      readonly kind: "table";
      readonly rows: readonly (readonly (readonly Span[])[])[];
    };

// Bold, italic and links (kept as their words); anything else is text as written. A run of * or _ turns
// bold (two), italic (one) or both (three) on or off, so nesting as "***Name.** Text*" reads right. A mark with
// space on both sides, as in "2 * 3", is text.
export function spans(text: string): Span[] {
  const out: Span[] = [];
  let bold = false;
  let italic = false;
  let buffer = "";
  const flush = (): void => {
    if (!buffer) return;
    out.push({
      text: buffer,
      ...(bold ? { bold: true } : {}),
      ...(italic ? { italic: true } : {}),
    });
    buffer = "";
  };
  const pattern =
    /\[([^\]]+)\]\([^)]*\)|`([^`]+)`|\*{1,3}|(?<![\p{L}\d])_{1,3}|_{1,3}(?![\p{L}\d])/gu;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    buffer += text.slice(at, match.index);
    at = match.index + match[0].length;
    const [mark, link, code] = match;
    if (link !== undefined || code !== undefined) {
      buffer += link ?? code ?? "";
      continue;
    }
    const before = text[match.index - 1] ?? " ";
    const after = text[at] ?? " ";
    if (/\s/.test(before) && /\s/.test(after)) {
      buffer += mark;
      continue;
    }
    flush();
    if (mark.length !== 1) bold = !bold;
    if (mark.length !== 2) italic = !italic;
  }
  buffer += text.slice(at);
  flush();
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());

const LIST = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "").length,
        spans: spans(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }
    const take = (test: (text: string) => boolean): string[] => {
      const taken: string[] = [];
      while (index < lines.length && test(lines[index] ?? "")) {
        taken.push(lines[index] ?? "");
        index += 1;
      }
      return taken;
    };
    if (line.trim().startsWith("|")) {
      const rows = take((text) => text.trim().startsWith("|"))
        .filter((row) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(row)) // the line under the header
        .map((row) => cells(row).map(spans));
      blocks.push({ kind: "table", rows });
      continue;
    }
    if (line.startsWith(">")) {
      const text = take((text) => text.startsWith(">"))
        .map((text) => text.replace(/^>\s?/, ""))
        .join(" ");
      blocks.push({ kind: "quote", spans: spans(text.trim()) });
      continue;
    }
    const first = LIST.exec(line);
    if (first) {
      const items: string[] = [];
      for (const text of take(
        (text) => text.trim() !== "" && !/^#{1,6}\s/.test(text),
      )) {
        const item = LIST.exec(text);
        if (item) items.push(item[2] ?? "");
        else items[items.length - 1] = `${items.at(-1) ?? ""} ${text.trim()}`;
      }
      blocks.push({
        kind: "list",
        ordered: first[1] !== undefined,
        items: items.map(spans),
      });
      continue;
    }
    const text = take(
      (text) =>
        text.trim() !== "" &&
        !/^(#{1,6}\s|\||>)/.test(text) &&
        !LIST.test(text),
    )
      .map((text) => text.trim())
      .join(" ");
    blocks.push({ kind: "paragraph", spans: spans(text) });
  }
  return blocks;
}

function inline(parts: readonly Span[]): Node[] {
  return parts.map((part) => {
    if (!part.bold && !part.italic) return document.createTextNode(part.text);
    const node = document.createElement(part.bold ? "strong" : "em");
    node.textContent = part.text;
    if (part.bold && part.italic) {
      const inner = document.createElement("em");
      inner.append(...node.childNodes);
      node.append(inner);
    }
    return node;
  });
}

export function renderMarkdown(markdown: string): Node[] {
  return parseMarkdown(markdown).map((block) => {
    switch (block.kind) {
      case "heading": {
        // Section headings sit under the book's own h2.
        const node = document.createElement(
          `h${String(Math.min(6, block.level + 2))}`,
        );
        node.append(...inline(block.spans));
        return node;
      }
      case "paragraph":
      case "quote": {
        const node = document.createElement(
          block.kind === "quote" ? "blockquote" : "p",
        );
        node.append(...inline(block.spans));
        return node;
      }
      case "list": {
        const node = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = document.createElement("li");
          li.append(...inline(item));
          node.append(li);
        }
        return node;
      }
      case "table": {
        const table = document.createElement("table");
        for (const [at, row] of block.rows.entries()) {
          const tr = document.createElement("tr");
          for (const cell of row) {
            const td = document.createElement(at === 0 ? "th" : "td");
            td.append(...inline(cell));
            tr.append(td);
          }
          table.append(tr);
        }
        const wrap = document.createElement("div");
        wrap.className = "book-table"; // a wide table scrolls on its own, not the page
        wrap.append(table);
        return wrap;
      }
    }
  });
}
