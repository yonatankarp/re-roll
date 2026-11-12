// Run by tauri.conf.json's beforeBuildCommand, so a desktop build stops before private content is bundled.
import { resolve } from "node:path";
import { bundleProblems } from "../../engine/tools/check-bundle.ts";

const problems = await bundleProblems(
  resolve(import.meta.dirname, "../desktop/src-tauri/tauri.conf.json"),
);
for (const problem of problems) console.error(`check-bundle: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log("check-bundle: no private content in the bundle");
