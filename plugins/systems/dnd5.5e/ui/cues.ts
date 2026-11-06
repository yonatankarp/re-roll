import type { ContentAccess, SystemEvent } from "#sdk";
import { EVENT_SCHEMAS, StateSchema } from "../core/state.ts";
import { deriveStats } from "../core/stats.ts";

// Plain data for the combat board to animate, one per event worth showing. No DOM here, so tests can check it.

export type DndCue =
  | {
      readonly kind: "start";
      readonly combatants: readonly {
        readonly id: string;
        readonly name: string;
        readonly side: string;
        readonly hp: number;
        readonly maxHp: number;
        readonly x: number | null;
        readonly y: number | null;
      }[];
      readonly grid: { readonly width: number; readonly height: number } | null;
    }
  | {
      readonly kind: "move";
      readonly actor: string;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: "end" }
  | { readonly kind: "turn"; readonly actor: string }
  | {
      readonly kind: "attack";
      readonly actor: string;
      readonly target: string;
      readonly label: string;
      readonly natural: number;
      readonly total: number;
      readonly ac: number;
      readonly hit: boolean;
    }
  | {
      readonly kind: "check";
      readonly actor: string;
      readonly label: string;
      readonly natural: number;
      readonly total: number;
      readonly dc: number;
      readonly success: boolean;
    }
  | {
      readonly kind: "damage";
      readonly actor: string;
      readonly amount: number;
      readonly type: string;
      readonly critical: boolean;
      readonly hp: number;
    }
  | {
      readonly kind: "heal";
      readonly actor: string;
      readonly amount: number;
      readonly hp: number;
    }
  | { readonly kind: "down"; readonly actor: string }
  | { readonly kind: "status"; readonly actor: string; readonly text: string }
  | { readonly kind: "cast"; readonly actor: string };

function hpOf(state: unknown, actor: string): number {
  return StateSchema.parse(state).actors[actor]?.hp ?? 0;
}

export function dndCue(
  event: SystemEvent,
  _before: unknown,
  after: unknown,
  access: ContentAccess,
): DndCue | null {
  if (!("payload" in event)) {
    switch (event.kind) {
      case "actorDowned":
        return { kind: "down", actor: event.actor };
      case "actorDefeated":
        return { kind: "down", actor: event.actor };
      default:
        return null;
    }
  }
  switch (event.kind) {
    // Everyone as the fight begins, so the board doesn't show how it ends while it plays the start.
    case "dnd5.5e:combatStarted": {
      const { actors, combat } = StateSchema.parse(after);
      return {
        kind: "start",
        combatants: (combat?.order ?? []).flatMap((id) => {
          const actor = actors[id];
          return actor
            ? [
                {
                  id,
                  name: actor.name,
                  side: actor.side === "enemy" ? "Enemy" : "Ally",
                  hp: actor.hp,
                  maxHp: deriveStats(actor, access).maxHp,
                  x: actor.position?.x ?? null,
                  y: actor.position?.y ?? null,
                },
              ]
            : [];
        }),
        grid: combat?.grid ?? null,
      };
    }
    case "dnd5.5e:moved": {
      const { actor, to } = EVENT_SCHEMAS["dnd5.5e:moved"].parse(event.payload);
      return { kind: "move", actor, x: to.x, y: to.y };
    }
    case "dnd5.5e:combatEnded":
      return { kind: "end" };
    case "dnd5.5e:turnAdvanced": {
      const { combat } = StateSchema.parse(after);
      const actor = combat?.order[combat.index];
      return actor ? { kind: "turn", actor } : null;
    }
    case "dnd5.5e:rollReported": {
      const roll = EVENT_SCHEMAS["dnd5.5e:rollReported"].parse(event.payload);
      return roll.against === "check"
        ? {
            kind: "check",
            actor: roll.actor,
            label: roll.label,
            natural: roll.natural,
            total: roll.total,
            dc: roll.target,
            success: roll.success,
          }
        : {
            kind: "attack",
            actor: roll.actor,
            target: roll.against,
            label: roll.label,
            natural: roll.natural,
            total: roll.total,
            ac: roll.target,
            hit: roll.success,
          };
    }
    case "dnd5.5e:damaged": {
      const hurt = EVENT_SCHEMAS["dnd5.5e:damaged"].parse(event.payload);
      return {
        kind: "damage",
        actor: hurt.actor,
        amount: hurt.amount,
        type: hurt.type,
        critical: hurt.critical,
        hp: hpOf(after, hurt.actor),
      };
    }
    case "dnd5.5e:healed": {
      const healed = EVENT_SCHEMAS["dnd5.5e:healed"].parse(event.payload);
      return {
        kind: "heal",
        actor: healed.actor,
        amount: healed.amount,
        hp: hpOf(after, healed.actor),
      };
    }
    case "dnd5.5e:effectAdded": {
      const { actor, effect } = EVENT_SCHEMAS["dnd5.5e:effectAdded"].parse(
        event.payload,
      );
      return effect.modifier.kind === "condition"
        ? { kind: "status", actor, text: effect.modifier.condition }
        : null;
    }
    case "dnd5.5e:resourceSpent": {
      const spent = EVENT_SCHEMAS["dnd5.5e:resourceSpent"].parse(event.payload);
      return spent.resource.startsWith("slot:")
        ? { kind: "cast", actor: spent.actor }
        : null;
    }
    default:
      return null;
  }
}
