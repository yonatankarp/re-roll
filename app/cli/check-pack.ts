import { systems } from "../systems.ts";
import { runCheckPack } from "./run-check-pack.ts";

// Library coverage only reports until #127–#136 add the missing entities. Then pass true (#126).
await runCheckPack(["plugins", "books"], systems, false);
