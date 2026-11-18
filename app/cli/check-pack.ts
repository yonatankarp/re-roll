import { systems } from "../systems.ts";
import { runCheckPack } from "./run-check-pack.ts";

await runCheckPack(["plugins", "books"], systems);
