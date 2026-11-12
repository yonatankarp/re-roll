import {
  type Actor,
  type DndState,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
  frame,
} from "../state.ts";
import { type ContentAccess, type Decision, PLAYER_ACTOR } from "#sdk";
import {
  ALL,
  CREATE_CHARACTER,
  DEATH_SAVE,
  encodeOption,
  MOVE,
  PASS,
} from "./ids.ts";
import { deriveStats, lookup } from "../stats.ts";
import { AIM_AREA, PICK } from "../targeting.ts";
import { fleeOptions } from "../legendary.ts";
import { PregenSchema } from "../schemas.ts";
import {
  actorOf,
  canAfford,
  inReach,
  moveSquares,
  slotToSpend,
  speedLeft,
  targetCount,
  upcastSlots,
  withUpcasts,
} from "./queries.ts";

// The decision a fight asks next: the player's character first, then whoever's turn it is.

function turnOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): Decision["options"] {
  if (hasCondition(actor, ...INCAPACITATING)) {
    return [{ id: PASS, label: "End your turn" }];
  }
  const stats = deriveStats(actor, access);
  const options: { id: string; label: string }[] = [];
  for (const action of stats.actions) {
    const { activation } = action;
    if (activation.trigger || !canAfford(action, actor, stats)) continue;
    const { targeting } = activation;
    const add = (target: string, label: string): void => {
      options.push(...withUpcasts(action, actor, stats, target, label));
    };
    if ("self" in targeting) {
      add(actor.id, action.name);
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
    const repeats = activation.projectiles !== undefined;
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
  if (moveSquares(actor, state, stats).length > 0) {
    options.push({
      id: MOVE,
      label: `Move (${String(speedLeft(actor, stats))} ft left)`,
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
    const options = access
      .contentIds()
      .filter((id) => id.includes(":pregen/"))
      .map((id) => ({ id, label: lookup(access, PregenSchema, id).name }));
    options.push({ id: CREATE_CHARACTER, label: "Create a new character" });
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
  const actorId = combat.order[combat.index];
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
