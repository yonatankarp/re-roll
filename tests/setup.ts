import { existsSync } from "node:fs";
import { fc } from "@fast-check/vitest";

// Fixed seeds, so a failing property fails the same way on every run and machine.
fc.configureGlobal({ seed: 20261112 });

// The books project would pass by skipping every book-gated test if books/ were missing.
if (process.env.RE_ROLL_BOOKS === "1" && !existsSync("books/rules/phb")) {
  throw new Error("npm run test:books needs books/ (the private books repo)");
}
