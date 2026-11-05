import { runCheckPack } from "../app/cli/run-check-pack.ts";
import { d6System } from "./fixtures/system-d6/index.ts";

await runCheckPack(["tests/fixtures"], [d6System]);
