import type { GameSystem } from "#sdk";
import { dnd55e } from "../plugins/systems/dnd5.5e/core/index.ts";

// The one static list of system plugins.
export const systems: readonly GameSystem[] = [dnd55e];
