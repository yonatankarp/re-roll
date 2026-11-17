import {
  type Actor,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
  PICKED_UP,
  frame,
  turnId,
} from "../state.ts";
import { type ContentAccess, type Decision, PLAYER_ACTOR } from "#sdk";
import {
  ALL,
  CREATE_CHARACTER,
  DEATH_SAVE,
  encodeOption,
  ITEM_PREFIX,
  MOVE,
  PASS,
  PICK_UP,
  SUMMON_WEAPON,
} from "./ids.ts";
import { distanceFeet } from "../grid.ts";
import { lightAt } from "../sight.ts";
import { deriveStats, lookup } from "../stats.ts";
import { commandedFamiliar } from "./effects.ts";
import { AIM_AREA, PICK } from "../targeting.ts";
import { fleeOptions } from "../legendary.ts";
import { type Activation, ItemSchema, PregenSchema } from "../schemas.ts";
import { heroOptions } from "../character-sheet.ts";
import { silencedSpells, sunlit } from "../zones.ts";
import {
  actorOf,
  canAfford,
  goldFor,
  inReach,
  moveSquares,
  ridden,
  slotToSpend,
  speedLeft,
  targetCount,
  upcastSlots,
  withUpcasts,
} from "./queries.ts";

// The decision a fight asks next: the player's character first, then whoever's turn it is.

// Only in Dim Light or Darkness, or only in sunlight, as its activation says.
export function whereItWorks(
  activation: Activation,
  actor: Actor,
  state: DndState,
): boolean {
  if (activation.whileIn === "shadows") {
    return lightAt(actor.position, state) !== "bright";
  }
  if (activation.whileIn === "sunlight") return sunlit(actor.position, state);
  return true;
}

function turnOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): Decision["options"] {
  if (hasCondition(actor, ...INCAPACITATING)) {
    return [{ id: PASS, label: "End your turn" }];
  }
  const stats = deriveStats(actor, access);
  const options: Decision["options"][number][] = [];
  const hushed = silencedSpells(actor, state, access);
  for (const action of stats.actions) {
    const { activation } = action;
    // An eye ray is only taken when Eye Rays rolls it, and an hour's casting only between fights (camp.ts).
    if (
      activation.trigger ||
      activation.outOfCombat ||
      action.rolled ||
      !canAfford(action, actor, stats) ||
      goldFor(action) > (state.gold ?? 0)
    )
      continue;
    if (hushed?.(action)) continue;
    if (!whereItWorks(activation, actor, state)) continue;
    const { targeting } = activation;
    const add = (target: string, label: string): void => {
      options.push(...withUpcasts(action, actor, stats, target, label));
    };
    if ("self" in targeting) {
      // A potion only heals, so at full health it's hidden, though an older save that drank it still replays.
      const full =
        action.id.startsWith(ITEM_PREFIX) &&
        activation.resolution.kind === "automatic" &&
        activation.resolution.effects.some((item) => item.kind === "heal") &&
        actor.hp >= stats.maxHp;
      // A command for a familiar that isn't near enough to take it does nothing, so it's hidden too.
      const idle =
        activation.resolution.kind === "automatic" &&
        activation.resolution.effects.some(
          (item) =>
            item.kind === "commandFamiliar" &&
            !commandedFamiliar(item, actor, state),
        );
      if (full || idle) {
        options.push({
          id: encodeOption(action.id, actor.id),
          label: action.name,
          hidden: true,
        });
      } else add(actor.id, action.name);
      continue;
    }
    const candidates = inReach(action, actor, state, access);
    if (candidates.length === 0) continue;
    if ("area" in targeting) {
      // On a grid an area is aimed at a square after it's chosen; without one it takes the whole side.
      const aimed =
        targeting.area.shape !== "emanation" && actor.position !== null;
      add(
        aimed ? AIM_AREA : ALL,
        aimed ? `${action.name}: aim it` : action.name,
      );
      continue;
    }
    // Each slot can give a different number of targets: one is a click on a creature, more are chosen one by one.
    // Darts or rays can also all go at one creature, or at the lowest HP first.
    const repeats =
      activation.projectiles !== undefined && !activation.distinct;
    const base = slotToSpend(action, actor, stats) ?? undefined;
    for (const slot of [undefined, ...upcastSlots(action, actor, stats)]) {
      const count = targetCount(action, slot ?? base);
      const note = slot === undefined ? "" : ` (level ${String(slot)} slot)`;
      const id = (target: string): string =>
        slot === undefined
          ? encodeOption(action.id, target)
          : encodeOption(action.id, target, slot);
      if (count === 1 || repeats) {
        for (const target of candidates) {
          options.push({
            id: id(target.id),
            label: `${action.name}: ${target.name} (${String(target.hp)} HP)${note}`,
          });
        }
      }
      if (count > 1) {
        options.push({
          id: id(PICK),
          label: `${action.name}: choose ${repeats ? `where ${String(count)} go` : `up to ${String(count)} targets`}${note}`,
        });
      }
      if (repeats && count > 1) {
        options.push({
          id: id(ALL),
          label: `${action.name}: lowest HP first${note}`,
        });
      }
    }
  }
  // One weapon lying within 5 feet can be picked up a turn, for free.
  if (!actor.usedThisTurn.includes(PICKED_UP)) {
    const bonded =
      actor.budget.bonusAction &&
      stats.passives.some((passive) => passive.kind === "warBond");
    (state.combat?.dropped ?? []).forEach((drop, index) => {
      if (actor.position && distanceFeet(actor.position, drop.at) <= 5) {
        options.push({
          id: encodeOption(PICK_UP, index),
          label: `Pick up ${lookup(access, ItemSchema, drop.item).name}`,
        });
      } else if (bonded && drop.by === actor.id) {
        options.push({
          id: encodeOption(SUMMON_WEAPON, index),
          label: `Summon ${lookup(access, ItemSchema, drop.item).name} to your hand (Bonus Action)`,
        });
      }
    });
  }
  if (moveSquares(actor, state, stats, access).length > 0) {
    // A rider moves with its mount's Speed.
    const mount = ridden(actor, state);
    const left = mount
      ? speedLeft(mount, deriveStats(mount, access))
      : speedLeft(actor, stats);
    options.push({
      id: MOVE,
      label: `Move (${String(left)} ft left)`,
    });
  }
  options.push(...fleeOptions(actor, state, access));
  options.push({ id: PASS, label: "End your turn" });
  return options;
}

export function nextDndDecision(
  state: DndState,
  access: ContentAccess,
): Decision | null {
  const player = state.actors[PLAYER_ACTOR];
  if (player?.source.kind === "character" && player.source.build === null) {
    const options: Decision["options"] = [
      ...access
        .contentIds()
        .filter((id) => id.includes(":pregen/"))
        .map((id) => ({ id, label: lookup(access, PregenSchema, id).name })),
      // The old step-by-step way in, kept for saves that took it; the sheet's "Build a hero yourself" replaces it.
      { id: CREATE_CHARACTER, label: "Create a new character", hidden: true },
      ...heroOptions(access),
    ];
    return {
      id: `${NS}:chooseCharacter`,
      actor: PLAYER_ACTOR,
      prompt: "Choose your character.",
      options,
      resume: frame("characterChosen", {}),
      revisable: true, // so Back from making a character returns here
    };
  }

  const { combat } = state;
  if (!combat) return null;
  const actorId = turnId(combat);
  if (actorId === undefined) return null;
  const actor = actorOf(state, actorId);

  if (isDown(actor)) {
    return {
      id: `${NS}:deathSave:${actorId}:${String(combat.round)}`,
      actor: actorId,
      prompt: `${actor.name} is dying.`,
      options: [{ id: DEATH_SAVE, label: "Roll a death saving throw" }],
      resume: frame("takeAction", { actor: actorId }),
    };
  }
  return {
    id: `${NS}:turn:${actorId}:${String(combat.round)}:${actor.budget.action ? "a" : ""}${actor.budget.bonusAction ? "b" : ""}${String(actor.moved)}`,
    actor: actorId,
    prompt: `Round ${String(combat.round)}: ${actor.name}'s turn (${String(actor.hp)} HP).`,
    options: turnOptions(actor, state, access),
    resume: frame("takeAction", { actor: actorId }),
  };
}
