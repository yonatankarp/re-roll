import type { ContentAccess } from "#sdk";
import type { Actor } from "./state.ts";
import { deriveStats } from "./stats.ts";

// How a foe looks hurt, as a DM would describe it, rather than its hit points: those are the DM's to know.
export function wounds(hp: number, maxHp: number): string {
  if (hp <= 0) return "Down";
  if (hp >= maxHp) return "Unhurt";
  return hp * 2 > maxHp ? "Wounded" : "Bloodied";
}

// What a choice of target says of its health: the party's in HP, a foe's in how it looks.
export function healthNote(actor: Actor, access: ContentAccess): string {
  return actor.side === "party"
    ? `${String(actor.hp)} HP`
    : wounds(actor.hp, deriveStats(actor, access).maxHp).toLowerCase();
}
