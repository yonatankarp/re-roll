// The 2024 books list the skills in a table, not under headings (#187). Each row is a skill entity: its name,
// and its other cells as its text, as the term hover reads a table row ("Dexterity: Stay on your feet…").
import { ALL_SKILLS, glossaryName } from "../schemas.ts";

const SKILL_IDS = new Set(ALL_SKILLS.map(glossaryName));
const idOf = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

// The rows of a section's table of skills, or none when a row isn't one of the engine's skills.
export function skillRows(
  body: string,
): { id: string; name: string; text: string }[] {
  const rows = body
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .slice(1) // the header
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  const out = rows.map(([name = "", ...rest]) => ({
    id: idOf(name),
    name,
    text: rest.join(": "),
  }));
  return out.length > 0 && out.every((row) => SKILL_IDS.has(row.id) && row.text)
    ? out
    : [];
}
