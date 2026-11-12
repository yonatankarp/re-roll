import { PLUGIN_ROOTS } from "../app/cli/load-adventure.ts";

// `npm run test:soak` runs the same tests with many more seeds, and the book adventures where present.
export const SOAK = process.env.RE_ROLL_SOAK === "1";
export const runs = (unit: number, soak: number): number =>
  SOAK ? soak : unit;
export const BOOK_ROOTS = PLUGIN_ROOTS.includes("books");
