import type { ContentAccess, SystemEvent } from "#sdk";
import { resistancesLeft } from "../core/legendary.ts";
import { EVENT_SCHEMAS } from "../core/state.ts";
import { unseenFoe } from "../core/fog.ts";
import { parseState } from "./parse-state.ts";
import { deriveStats, evaluateFormula, scaledDice } from "../core/stats.ts";
import {
  HIDE_SOURCE,
  TACTIC_WORDS,
  tacticSourceName,
} from "../core/tactics.ts";

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
      readonly surprised: "party" | "enemies" | null;
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
      readonly style: "melee" | "ranged" | "spell";
      readonly damage: string; // the dice it rolls on a hit, such as "1d8+3"
    }
  | {
      readonly kind: "deathSave";
      readonly actor: string;
      readonly natural: number;
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
  | { readonly kind: "cast"; readonly actor: string }
  | {
      readonly kind: "legendary";
      readonly actor: string;
      readonly label: string;
    }
  | { readonly kind: "resist"; readonly actor: string; readonly left: number }
  | { readonly kind: "lair"; readonly actor: string; readonly label: string };

function hpOf(state: unknown, actor: string): number {
  return parseState(state).actors[actor]?.hp ?? 0;
}

// How an attack looks: a weapon swing, a shot or a spell, and the damage dice it rolls.
function attackLook(
  state: unknown,
  actorId: string,
  label: string,
  access: ContentAccess,
): { readonly style: "melee" | "ranged" | "spell"; readonly damage: string } {
  const actor = parseState(state).actors[actorId];
  if (!actor) return { style: "melee", damage: "" };
  const stats = deriveStats(actor, access);
  const action = stats.actions.find((item) => item.name === label);
  if (!action) return { style: "melee", damage: "" };
  const { targeting, resolution } = action.activation;
  const range = "range" in targeting ? targeting.range : "touch";
  const style =
    action.spellLevel !== null
      ? "spell"
      : range === "touch" || range === "self" || range <= 10
        ? "melee"
        : "ranged";
  const damage =
    "damage" in resolution
      ? resolution.damage
          .map(({ amount }) => {
            const dice = scaledDice(amount, stats.scaling);
            const bonus = amount.bonus
              ? evaluateFormula(amount.bonus, stats)
              : 0;
            if (!dice) return String(bonus);
            if (bonus === 0) return dice;
            return `${dice}${bonus > 0 ? "+" : ""}${String(bonus)}`;
          })
          .join(" + ")
      : "";
  return { style, damage };
}

// What the board shows of an event: nothing of a foe the party can't see, before it or after.
export function dndCue(
  event: SystemEvent,
  before: unknown,
  after: unknown,
  access: ContentAccess,
): DndCue | null {
  const cue = cueOf(event, after, access);
  if (!cue || !("actor" in cue)) return cue;
  const hidden = (id: string): boolean =>
    unseenFoe(parseState(before), id, access) &&
    unseenFoe(parseState(after), id, access);
  // An unseen foe's attack still lands on the party, so it plays with no one to throw it.
  return hidden(cue.actor) && !(cue.kind === "attack" && !hidden(cue.target))
    ? null
    : cue;
}

function cueOf(
  event: SystemEvent,
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
      const state = parseState(after);
      const { actors, combat } = state;
      return {
        kind: "start",
        combatants: (combat?.order ?? []).flatMap((id) => {
          const actor = actors[id];
          return actor && !unseenFoe(state, id, access)
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
        surprised:
          EVENT_SCHEMAS["dnd5.5e:combatStarted"].parse(event.payload)
            .surprised ?? null,
      };
    }
    case "dnd5.5e:moved": {
      const { actor, to } = EVENT_SCHEMAS["dnd5.5e:moved"].parse(event.payload);
      return { kind: "move", actor, x: to.x, y: to.y };
    }
    case "dnd5.5e:combatEnded":
      return { kind: "end" };
    case "dnd5.5e:turnAdvanced": {
      const { combat } = parseState(after);
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
            ...attackLook(after, roll.actor, roll.label, access),
          };
    }
    case "dnd5.5e:deathSaveRolled": {
      const save = EVENT_SCHEMAS["dnd5.5e:deathSaveRolled"].parse(
        event.payload,
      );
      return { kind: "deathSave", actor: save.actor, natural: save.natural };
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
      // Hiding floats "hidden" once, not the Invisible condition it also gives.
      if (effect.modifier.kind === "tactic") {
        return {
          kind: "status",
          actor,
          text: TACTIC_WORDS[effect.modifier.tactic],
        };
      }
      if (effect.modifier.kind === "condition") {
        return effect.sourceId === HIDE_SOURCE
          ? null
          : { kind: "status", actor, text: effect.modifier.condition };
      }
      // Help, Sap and Vex, which leave Advantage or Disadvantage behind.
      const named = tacticSourceName(effect.sourceId);
      return named ? { kind: "status", actor, text: named } : null;
    }
    case "dnd5.5e:saveReported": {
      const save = EVENT_SCHEMAS["dnd5.5e:saveReported"].parse(event.payload);
      return save.success
        ? { kind: "status", actor: save.actor, text: `resists ${save.label}` }
        : null;
    }
    case "dnd5.5e:resourceSpent": {
      const spent = EVENT_SCHEMAS["dnd5.5e:resourceSpent"].parse(event.payload);
      return spent.resource.startsWith("slot:")
        ? { kind: "cast", actor: spent.actor }
        : null;
    }
    case "dnd5.5e:legendaryActionTaken": {
      const taken = EVENT_SCHEMAS["dnd5.5e:legendaryActionTaken"].parse(
        event.payload,
      );
      return { kind: "legendary", actor: taken.actor, label: taken.name };
    }
    case "dnd5.5e:legendaryResistanceUsed": {
      const { actor } = EVENT_SCHEMAS["dnd5.5e:legendaryResistanceUsed"].parse(
        event.payload,
      );
      const state = parseState(after);
      const resisting = state.actors[actor];
      return {
        kind: "resist",
        actor,
        left: resisting ? resistancesLeft(resisting, access, state) : 0,
      };
    }
    case "dnd5.5e:lairActionTaken": {
      const taken = EVENT_SCHEMAS["dnd5.5e:lairActionTaken"].parse(
        event.payload,
      );
      return { kind: "lair", actor: taken.actor, label: taken.name };
    }
    default:
      return null;
  }
}
