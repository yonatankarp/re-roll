import {
  type ContentAccess,
  type Decision,
  type Frame,
  PLAYER_ACTOR,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import { z } from "zod";
import {
  type Context,
  HitSchema,
  MOVE,
  PASS,
  allies,
  choosePolicy,
  concentrationFrame,
  dealEvents,
  enemies,
  hasFlag,
  meleeReach,
  rollBonus,
  rollSave,
  speedLeft,
  stepToward,
  within5,
} from "./combat.ts";
import { encodeOption, parseOption } from "./combat/ids.ts";
import { teleportSquares } from "./combat/movement.ts";
import { SIZES, sizeOf } from "./combat/queries.ts";
import { moveOf, reachesFrom } from "./policy.ts";
import { coverFor, seeing } from "./sight.ts";
import {
  classOptionPolicy,
  classOptions,
  isClassOption,
  runClassOption,
} from "./class-options.ts";
import { escapeDc, grapplesOn } from "./combat/grapple.ts";
import { type Square, distanceFeet, pushTo, squareKey } from "./grid.ts";

export { pushTo };
import { FLEE } from "./legendary.ts";
import { finalDamage, rollD20 } from "./rules.ts";
import { type Ability, type Skill } from "./schemas.ts";
import {
  type ActiveEffect,
  type Actor,
  type DndState,
  INCAPACITATING,
  NS,
  dndEvent,
  equipped,
  hasCondition,
  isDead,
  isDown,
  isStable,
  frame,
} from "./state.ts";
import {
  type KnownAction,
  type Stats,
  checkBonus,
  damageResponses,
  deriveStats,
  modifierFor,
  saveBonus,
} from "./stats.ts";
import {
  GRAPPLE_SOURCE,
  HIDE_SOURCE,
  LIGHT_USED,
  MASTERY,
  TACTIC,
  hasTactic,
  masteryOf,
  speedOf,
  tacticsOf,
  weaponOf,
} from "./tactics.ts";

// The 2024 actions anyone can take in a fight besides attacking and casting (Dash, Disengage, Dodge, Help,
// Hide, Ready, Search, Study, Grapple, Shove, standing up, escaping a grapple), the off-hand attack of a second Light weapon,
// and the weapon masteries. Each is an option of the turn decision, so a save replays it like any other.

const DASH = `${TACTIC}dash`;
const DISENGAGE = `${TACTIC}disengage`;
// The same as a Bonus Action, through Cunning Action or Nimble Escape.
export const BONUS_DASH = `${TACTIC}bonus-dash`;
export const BONUS_DISENGAGE = `${TACTIC}bonus-disengage`;
export const BONUS_HIDE = `${TACTIC}bonus-hide`;
const DODGE = `${TACTIC}dodge`;
const HIDE = HIDE_SOURCE;
const SEARCH = `${TACTIC}search`;
export const STUDY = `${TACTIC}study`;
const HELP = `${TACTIC}help`;
const GRAPPLE = GRAPPLE_SOURCE;
const SHOVE = `${TACTIC}shove`;
const READY = `${TACTIC}ready`;
const STAND = `${TACTIC}stand`;
const ESCAPE = `${TACTIC}escape`;
export const OFFHAND = `${TACTIC}offhand`;
const OFFHAND_USED = "offhand";
const NICK_USED = `${MASTERY}nick`;
const CLEAVE_USED = `${MASTERY}cleave`;
const HIDE_DC = 15;
const STABILIZE_DC = 10;
const STUDY_DC = 15;

const CHECK_END = frame("checkCombatEnd", {});

// At 0 HP and still making death saves.
function dyingNow(actor: Actor): boolean {
  return (
    actor.side === "party" &&
    isDown(actor) &&
    !isDead(actor) &&
    !isStable(actor)
  );
}

function effect(
  actor: string,
  sourceId: string,
  casterId: string,
  modifier: ActiveEffect["modifier"],
  ends: ActiveEffect["ends"],
  more: Pick<ActiveEffect, "repeatSave"> = {},
): SystemEvent {
  return dndEvent(`${NS}:effectAdded`, {
    actor,
    effect: { sourceId, casterId, modifier, ends, ...more },
  });
}

// An Unarmed Strike's Grapple or Shove, and a mastery's save: 8 + the ability modifier + Proficiency Bonus.
function saveDc(stats: Stats, ability: Ability): number {
  return 8 + modifierFor(stats, ability) + stats.proficiency;
}

// The target picks the better of Strength and Dexterity against a Grapple or Shove.
function betterSave(target: Actor, access: ContentAccess): "str" | "dex" {
  const stats = deriveStats(target, access);
  return saveBonus(stats, "dex") > saveBonus(stats, "str") ? "dex" : "str";
}

function reportedSave(
  target: Actor,
  ability: Ability,
  dc: number,
  label: string,
  context: Context,
): { readonly saved: boolean; readonly events: readonly SystemEvent[] } {
  // The roll for the history (and a Legendary Resistance), then the line saying what it was against.
  const { saved, events } = rollSave(target, ability, dc, context);
  return {
    saved,
    events: [
      ...events,
      dndEvent(`${NS}:saveReported`, {
        actor: target.id,
        ability,
        dc,
        success: saved,
        label,
      }),
    ],
  };
}

// An ability check in a fight. Help's Advantage on a check is used up by it.
function check(
  actor: Actor,
  skill: Skill,
  ability: Ability,
  dc: number,
  label: (success: boolean) => string,
  context: Context,
): {
  readonly success: boolean;
  readonly total: number;
  events: SystemEvent[];
} {
  const stats = deriveStats(actor, context);
  const roll = rollD20(context.dice, {
    advantage: hasFlag(actor, "advantage", "checks", stats, ability),
    disadvantage:
      hasFlag(actor, "disadvantage", "checks", stats, ability) ||
      hasCondition(actor, "poisoned", "frightened"),
  });
  const total =
    roll.natural +
    checkBonus(stats, actor, { ability, skill }) +
    rollBonus(actor, "checks", context);
  const success = total >= dc;
  const helped = actor.activeEffects.some(
    ({ sourceId, modifier }) =>
      sourceId === HELP &&
      modifier.kind === "advantage" &&
      modifier.on === "checks",
  );
  return {
    success,
    total,
    events: [
      dndEvent(`${NS}:rollReported`, {
        actor: actor.id,
        against: "check",
        natural: roll.natural,
        total,
        target: dc,
        success,
        label: label(success),
      }),
      ...(helped
        ? [dndEvent(`${NS}:effectEnded`, { actor: actor.id, sourceId: HELP })]
        : []),
    ],
  };
}

// The squares a creature is pushed through, straight away from `from`, stopping at a wall, a creature or the
// map's edge. Null when it can't move at all, or there's no map.

// Forced movement uses none of the creature's own Speed and provokes no Opportunity Attacks.
function pushEvents(
  by: Actor,
  target: Actor,
  feet: number,
  state: DndState,
): SystemEvent[] {
  const to = pushTo(by.position, target, feet, state);
  return to ? [dndEvent(`${NS}:moved`, { actor: target.id, to, feet: 0 })] : [];
}

function standing(list: readonly Actor[]): readonly Actor[] {
  return list.filter((item) => !isDown(item));
}

function halfSpeed(stats: Stats): number {
  return Math.ceil(stats.speed / 10) * 5;
}

// With the Two-Weapon Fighting style, the off-hand attack keeps the ability modifier.
function twoWeaponStyle(actor: Actor): boolean {
  const build = actor.source.kind === "character" ? actor.source.build : null;
  return (build?.levels ?? []).some((level) =>
    level.answers.some(
      (answer) =>
        answer.kind === "feats" &&
        answer.values.some((id) => id.endsWith("/two-weapon-fighting")),
    ),
  );
}

// After an attack with a Light weapon, a different Light weapon (or a second of the same) can attack as a
// Bonus Action, or as part of the Attack action with Nick.
function offhandOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  const used = actor.usedThisTurn.flatMap((key) =>
    key.startsWith(LIGHT_USED) ? [key.slice(LIGHT_USED.length)] : [],
  );
  if (used.length === 0 || actor.usedThisTurn.includes(OFFHAND_USED)) return [];
  const carried = equipped(actor);
  return stats.actions.flatMap((action) => {
    const weapon = weaponOf(action.id, access);
    const reach = meleeReach(action);
    if (!weapon?.properties.includes("light") || reach === null) return [];
    const itemId = action.id.slice(action.id.indexOf(":") + 1);
    const another =
      used.some((id) => id !== action.id) ||
      carried.filter((id) => id === itemId).length > 1;
    const nick =
      masteryOf(actor, action.id, access) === "nick" &&
      !actor.usedThisTurn.includes(NICK_USED);
    if (!another || (!nick && !actor.budget.bonusAction)) return [];
    return standing(enemies(state, actor))
      .filter((foe) => distanceFeet(actor.position, foe.position) <= reach)
      .map((foe) => ({
        id: encodeOption(OFFHAND, foe.id, action.id),
        label: `Off-hand ${action.name}: ${foe.name} (${String(foe.hp)} HP)${nick ? ", with Nick" : ""}`,
      }));
  });
}

function readyable(stats: Stats): readonly KnownAction[] {
  return stats.actions.filter(
    (action) =>
      meleeReach(action) !== null &&
      action.activation.resolution.kind === "attack" &&
      action.activation.cost.includes("action") &&
      !action.activation.trigger &&
      action.spellLevel === null,
  );
}

// Dash, Disengage or Hide for the Bonus Action, as far as the bearer's passives allow.
function bonusTacticOptions(
  actor: Actor,
  state: DndState,
  stats: Stats,
): { id: string; label: string }[] {
  if (!actor.budget.bonusAction) return [];
  const allowed = new Set(
    stats.passives.flatMap((passive) =>
      passive.kind === "bonusTactics" ? passive.tactics : [],
    ),
  );
  const options: { id: string; label: string }[] = [];
  const extra = speedOf(actor, stats) / (1 + tacticsOf(actor, "dash").length);
  if (
    allowed.has("dash") &&
    extra > 0 &&
    !hasCondition(actor, "grappled", "restrained")
  ) {
    options.push({
      id: BONUS_DASH,
      label: `Dash as a Bonus Action (${String(extra)} ft more this turn)`,
    });
  }
  if (allowed.has("disengage") && !hasTactic(actor, "disengage")) {
    options.push({
      id: BONUS_DISENGAGE,
      label: "Disengage as a Bonus Action (no Opportunity Attacks this turn)",
    });
  }
  // The same shortcut as the Hide action's: no foe within 5 feet.
  if (
    allowed.has("hide") &&
    !hasTactic(actor, "hidden") &&
    !standing(enemies(state, actor)).some((foe) => within5(actor, foe))
  ) {
    options.push({
      id: BONUS_HIDE,
      label: `Hide as a Bonus Action (Stealth, DC ${String(HIDE_DC)})`,
    });
  }
  return options;
}

export function tacticOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): { id: string; label: string }[] {
  if (!state.combat || isDown(actor) || hasCondition(actor, ...INCAPACITATING))
    return [];
  const stats = deriveStats(actor, access);
  const options: { id: string; label: string }[] = [];
  const half = halfSpeed(stats);
  if (
    hasCondition(actor, "prone") &&
    (!actor.position || speedLeft(actor, stats) >= half)
  ) {
    options.push({
      id: STAND,
      label: `Stand up (${String(half)} ft of movement)`,
    });
  }
  options.push(...offhandOptions(actor, state, access, stats));
  options.push(...classOptions(actor, state, access));
  options.push(...bonusTacticOptions(actor, state, stats));
  if (!actor.budget.action) return options;
  // Everyone else's turns are played by tacticalPolicy, so they're offered only what it can pick, which also
  // spares working out every Study and Shove on every monster's turn.
  const full = actor.id === PLAYER_ACTOR;

  const foes = standing(enemies(state, actor));
  const near = foes.filter((foe) => within5(actor, foe));
  const friends = standing(allies(state, actor)).filter(
    (item) => item.id !== actor.id,
  );
  const extra = speedOf(actor, stats) / (1 + tacticsOf(actor, "dash").length);
  if (extra > 0 && !hasCondition(actor, "grappled", "restrained")) {
    options.push({
      id: DASH,
      label: `Dash (${String(extra)} ft more this turn)`,
    });
  }
  options.push({
    id: DODGE,
    label: "Dodge (attacks against you have Disadvantage)",
  });
  // Help also stabilizes a dying creature within 5 feet, which every companion should be able to do.
  for (const dying of allies(state, actor).filter(
    (item) => item.id !== actor.id && dyingNow(item) && within5(actor, item),
  )) {
    options.push({
      id: encodeOption(HELP, dying.id),
      label: `Stabilize ${dying.name} (Medicine, DC ${String(STABILIZE_DC)})`,
    });
  }
  if (foes.some((foe) => hasTactic(foe, "hidden"))) {
    options.push({ id: SEARCH, label: "Search for hidden foes (Perception)" });
  }
  for (const grapple of grapplesOn(actor)) {
    const grappler = state.actors[grapple.casterId];
    options.push({
      id: encodeOption(ESCAPE, grapple.casterId, grapple.sourceId),
      label: `Escape ${grappler ? `${grappler.name}'s` : "the"} grapple (Athletics or Acrobatics, DC ${String(escapeDc(grapple, state, access))})`,
    });
  }
  if (!full) return options;
  options.push({
    id: DISENGAGE,
    label: "Disengage (no Opportunity Attacks this turn)",
  });
  // shortcut: hiding needs only no foe within 5 feet, not Heavy Obscurement or cover. Check cover and light
  // here once the grid tracks them.
  if (!hasTactic(actor, "hidden") && near.length === 0) {
    options.push({
      id: HIDE,
      label: `Hide (Stealth, DC ${String(HIDE_DC)})`,
    });
  }
  for (const foe of foes) {
    options.push({
      id: encodeOption(STUDY, foe.id),
      label: `Study ${foe.name} (${capitalized(studySkill(foe, access))})`,
    });
  }
  if (friends.length > 0) {
    for (const foe of near) {
      options.push({
        id: encodeOption(HELP, foe.id),
        label: `Help an ally attack ${foe.name}`,
      });
    }
  }
  for (const friend of friends.filter((item) => within5(actor, item))) {
    options.push({
      id: encodeOption(HELP, friend.id),
      label: `Help ${friend.name} with a check`,
    });
  }
  const dc = String(saveDc(stats, "str"));
  const size = sizeOf(actor, access);
  // A Grapple or Shove is an Unarmed Strike against a creature no more than one size larger.
  // shortcut: it takes the whole Attack action, not one of its attacks, and needs no free hand.
  for (const foe of near.filter((item) => sizeOf(item, access) <= size + 1)) {
    const held = foe.activeEffects.some(
      (item) => item.sourceId === GRAPPLE && item.casterId === actor.id,
    );
    if (!held) {
      options.push({
        id: encodeOption(GRAPPLE, foe.id),
        label: `Grapple ${foe.name} (DC ${dc})`,
      });
    }
    if (!hasCondition(foe, "prone")) {
      options.push({
        id: encodeOption(SHOVE, foe.id, "prone"),
        label: `Shove ${foe.name} prone (DC ${dc})`,
      });
    }
    if (pushTo(actor.position, foe, 5, state)) {
      options.push({
        id: encodeOption(SHOVE, foe.id, "push"),
        label: `Shove ${foe.name} 5 ft away (DC ${dc})`,
      });
    }
  }
  for (const action of readyable(stats)) {
    options.push({
      id: encodeOption(READY, action.id),
      label: `Ready ${action.name} for a foe stepping into reach`,
    });
  }
  return options;
}

const STUDY_SKILLS: Readonly<Record<string, Skill>> = {
  aberration: "arcana",
  construct: "arcana",
  dragon: "arcana",
  elemental: "arcana",
  fey: "arcana",
  monstrosity: "arcana",
  beast: "nature",
  ooze: "nature",
  plant: "nature",
  celestial: "religion",
  fiend: "religion",
  undead: "religion",
};

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function studySkill(target: Actor, access: ContentAccess): Skill {
  return (
    STUDY_SKILLS[deriveStats(target, access).creatureType ?? ""] ?? "history"
  );
}

// What studying a creature tells you: its AC and how it takes damage.
function lore(target: Actor, access: ContentAccess): string {
  const { resistances, immunities, vulnerabilities } = damageResponses(
    target,
    access,
  );
  return [
    `AC ${String(deriveStats(target, access).ac)}`,
    ...(vulnerabilities.length > 0
      ? [`weak to ${vulnerabilities.join(", ")}`]
      : []),
    ...(resistances.length > 0 ? [`resists ${resistances.join(", ")}`] : []),
    ...(immunities.length > 0 ? [`immune to ${immunities.join(", ")}`] : []),
  ].join(", ");
}

// The turn decision with these actions added after Move and before fleeing and ending the turn, so the
// choices listed first stay as they were.
export function withTactics(
  decision: Decision | null,
  state: DndState,
  access: ContentAccess,
): Decision | null {
  if (!decision?.id.startsWith(`${NS}:turn:`)) return decision;
  const actor = state.actors[decision.actor];
  const extra = actor ? tacticOptions(actor, state, access) : [];
  if (extra.length === 0) return decision;
  const found = decision.options.findIndex(
    ({ id }) => id === FLEE || id === PASS,
  );
  const at = found === -1 ? decision.options.length - 1 : found;
  return {
    ...decision,
    options: [
      ...decision.options.slice(0, at),
      ...extra,
      ...decision.options.slice(at),
    ],
  };
}

export function isTactic(answer: string): boolean {
  return answer.startsWith(TACTIC);
}

export function runTactic(
  payload: { readonly actor: string; readonly answer: string },
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = state.actors[payload.actor];
  if (!actor) throw new Error(`Unknown actor ${payload.actor}`);
  if (isClassOption(payload.answer)) return runClassOption(payload, context);
  const [kind = "", targetId = "", detail = ""] = parseOption(payload.answer);
  const target = state.actors[targetId];
  const stats = deriveStats(actor, context);
  const spend = (budget: "action" | "bonusAction"): SystemEvent =>
    dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: budget });
  const self = (
    tactic: "dash" | "disengage" | "dodge" | "ready",
    action?: string,
  ): SystemEvent =>
    effect(
      actor.id,
      kind,
      actor.id,
      { kind: "tactic", tactic, ...(action ? { action } : {}) },
      "casterNextTurn",
    );
  const done: Frame[] = [CHECK_END, frame("afterAction", { actor: actor.id })];
  const needTarget = (): Actor => {
    if (!target) throw new Error(`${payload.answer} has no target`);
    return target;
  };

  switch (kind) {
    case STAND:
      return {
        events: [
          dndEvent(`${NS}:conditionRemoved`, {
            actor: actor.id,
            condition: "prone",
          }),
          ...(actor.position
            ? [
                dndEvent(`${NS}:moved`, {
                  actor: actor.id,
                  to: actor.position,
                  feet: halfSpeed(stats),
                }),
              ]
            : []),
        ],
      };
    // Dash and Disengage are for moving, so the turn goes on for it.
    case DASH:
      return { events: [spend("action"), self("dash")] };
    case DISENGAGE:
      return { events: [spend("action"), self("disengage")] };
    case BONUS_DASH:
      return { events: [spend("bonusAction"), self("dash")] };
    case BONUS_DISENGAGE:
      return { events: [spend("bonusAction"), self("disengage")] };
    case DODGE:
      return { events: [spend("action"), self("dodge")], frames: done };
    case READY:
      return {
        events: [spend("action"), self("ready", targetId)],
        frames: done,
      };
    case HIDE:
    case BONUS_HIDE: {
      const rolled = check(
        actor,
        "stealth",
        "dex",
        HIDE_DC,
        () => "stealth",
        context,
      );
      const hidden: SystemEvent[] = rolled.success
        ? [
            effect(
              actor.id,
              HIDE,
              actor.id,
              { kind: "condition", condition: "invisible" },
              "spellDuration",
            ),
            effect(
              actor.id,
              HIDE,
              actor.id,
              { kind: "tactic", tactic: "hidden", value: rolled.total },
              "spellDuration",
            ),
          ]
        : [];
      return {
        events: [
          spend(kind === HIDE ? "action" : "bonusAction"),
          ...rolled.events,
          ...hidden,
        ],
        frames: done,
      };
    }
    case SEARCH: {
      // A Perception check finds every hidden foe whose Stealth total it matches.
      const hidden = enemies(state, actor).flatMap((foe) => {
        const [mark] = tacticsOf(foe, "hidden");
        return mark ? [{ foe, dc: mark.value ?? HIDE_DC }] : [];
      });
      const lowest = Math.min(HIDE_DC, ...hidden.map(({ dc }) => dc));
      const rolled = check(
        actor,
        "perception",
        "wis",
        lowest,
        () => "perception",
        context,
      );
      const found = hidden.flatMap(({ foe, dc }) =>
        rolled.total >= dc
          ? [
              dndEvent(`${NS}:effectEnded`, {
                actor: foe.id,
                sourceId: HIDE,
              }),
            ]
          : [],
      );
      return {
        events: [spend("action"), ...rolled.events, ...found],
        frames: done,
      };
    }
    case STUDY: {
      // shortcut: what's learned is only reported, as nothing else in the rules reads it.
      const studied = needTarget();
      const skill = studySkill(studied, context);
      const rolled = check(
        actor,
        skill,
        "int",
        STUDY_DC,
        (success) =>
          success
            ? `${skill} (${studied.name}: ${lore(studied, context)})`
            : skill,
        context,
      );
      return { events: [spend("action"), ...rolled.events], frames: done };
    }
    case HELP: {
      const helped = needTarget();
      // On a dying creature, a Wisdom (Medicine) check to make it Stable.
      if (helped.side === actor.side && dyingNow(helped)) {
        const rolled = check(
          actor,
          "medicine",
          "wis",
          STABILIZE_DC,
          () => "medicine",
          context,
        );
        return {
          events: [
            spend("action"),
            ...rolled.events,
            ...(rolled.success
              ? [dndEvent(`${NS}:stabilized`, { actor: helped.id })]
              : []),
          ],
          frames: done,
        };
      }
      // On a foe, the next attack against it before your next turn has Advantage; on an ally, its next check.
      // shortcut: your own attack could use the Advantage on the foe too, though only an ally should.
      const modifier =
        helped.side === actor.side
          ? ({ kind: "advantage", on: "checks" } as const)
          : ({ kind: "advantage", on: "attacksAgainst", once: true } as const);
      return {
        events: [
          spend("action"),
          effect(helped.id, HELP, actor.id, modifier, "casterNextTurn"),
        ],
        frames: done,
      };
    }
    case GRAPPLE: {
      // The grappled creature escapes with its action; combat/grapple.ts ends the grapple on its own.
      const held = needTarget();
      const dc = saveDc(stats, "str");
      const ability = betterSave(held, context);
      const save = reportedSave(held, ability, dc, "Grapple", context);
      return {
        events: [
          spend("action"),
          ...save.events,
          ...(save.saved
            ? []
            : [
                effect(
                  held.id,
                  GRAPPLE,
                  actor.id,
                  { kind: "condition", condition: "grappled" },
                  "spellDuration",
                ),
              ]),
        ],
        frames: done,
      };
    }
    case ESCAPE: {
      // An Athletics or Acrobatics check, whichever is better, against the grapple's escape DC.
      const grapple = grapplesOn(actor).find(
        (item) => item.sourceId === detail && item.casterId === targetId,
      );
      if (!grapple) throw new Error(`${actor.id} isn't held by ${targetId}`);
      const athletics =
        checkBonus(stats, actor, { ability: "str", skill: "athletics" }) >=
        checkBonus(stats, actor, { ability: "dex", skill: "acrobatics" });
      const rolled = check(
        actor,
        athletics ? "athletics" : "acrobatics",
        athletics ? "str" : "dex",
        escapeDc(grapple, state, context),
        () => `Escape (${athletics ? "Athletics" : "Acrobatics"})`,
        context,
      );
      return {
        events: [
          spend("action"),
          ...rolled.events,
          ...(rolled.success
            ? [
                dndEvent(`${NS}:effectEnded`, {
                  actor: actor.id,
                  sourceId: grapple.sourceId,
                  casterId: grapple.casterId,
                }),
              ]
            : []),
        ],
        frames: done,
      };
    }
    case SHOVE: {
      const shoved = needTarget();
      const save = reportedSave(
        shoved,
        betterSave(shoved, context),
        saveDc(stats, "str"),
        "Shove",
        context,
      );
      const result = save.saved
        ? []
        : detail === "prone"
          ? [
              effect(
                shoved.id,
                SHOVE,
                actor.id,
                { kind: "condition", condition: "prone" },
                "spellDuration",
              ),
            ]
          : pushEvents(actor, shoved, 5, state);
      return {
        events: [spend("action"), ...save.events, ...result],
        frames: done,
      };
    }
    case OFFHAND: {
      const nick =
        masteryOf(actor, detail, context) === "nick" &&
        !actor.usedThisTurn.includes(NICK_USED);
      return {
        events: [
          nick
            ? dndEvent(`${NS}:oncePerTurnUsed`, {
                actor: actor.id,
                key: NICK_USED,
              })
            : spend("bonusAction"),
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: actor.id,
            key: OFFHAND_USED,
          }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: actor.id,
            actionId: detail,
            target: needTarget().id,
            ...(twoWeaponStyle(actor) ? {} : { noModifier: true }),
          }),
          ...done,
        ],
      };
    }
    default:
      throw new Error(`Unknown action ${payload.answer}`);
  }
}

// After an attack, the turn waits for the off-hand attack it allows, rather than ending.
export function keepsActing(actorId: string, context: Context): boolean {
  const actor = context.state.actors[actorId];
  if (!actor || !context.state.combat || isDown(actor)) return false;
  if (hasCondition(actor, ...INCAPACITATING)) return false;
  return (
    offhandOptions(actor, context.state, context, deriveStats(actor, context))
      .length > 0
  );
}

const AfterMoveSchema = z.object({
  actor: z.string(),
  x: z.number(), // where the move started
  y: z.number(),
});

// A readied attack goes off at a foe stepping into reach. A grapple the move breaks ends in combat/grapple.ts.
// shortcut: a grappler doesn't drag the grappled creature along, and a readied attack fires on its own.
export function runAfterMove(
  payload: z.infer<typeof AfterMoveSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const mover = state.actors[payload.actor];
  if (!state.combat || !mover?.position || isDown(mover)) return {};
  const from = { x: payload.x, y: payload.y };
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (const foe of enemies(state, mover)) {
    const [ready] = tacticsOf(foe, "ready");
    if (!ready?.action || !foe.budget.reaction || isDown(foe)) continue;
    if (hasCondition(foe, ...INCAPACITATING)) continue;
    const action = deriveStats(foe, context).actions.find(
      (item) => item.id === ready.action,
    );
    const reach = action ? meleeReach(action) : null;
    if (
      reach === null ||
      distanceFeet(from, foe.position) <= reach ||
      distanceFeet(mover.position, foe.position) > reach
    ) {
      continue;
    }
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
      dndEvent(`${NS}:effectEnded`, { actor: foe.id, sourceId: READY }),
    );
    frames.push(
      frame("attackRoll", {
        attacker: foe.id,
        actionId: ready.action,
        target: mover.id,
      }),
    );
  }
  return { events, frames };
}

export { AfterMoveSchema };

const MasteryHitSchema = HitSchema.extend({ dealt: z.number() });

function masteryAttack(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): {
  readonly attacker: Actor;
  readonly target: Actor;
  readonly action: KnownAction;
  readonly ability: Ability;
  readonly mastery: NonNullable<ReturnType<typeof masteryOf>>;
} | null {
  const { state } = context;
  const attacker = state.actors[payload.attacker];
  const target = state.actors[payload.target];
  if (!state.combat || !attacker || !target) return null;
  const mastery = masteryOf(attacker, payload.actionId, context);
  const action = deriveStats(attacker, context).actions.find(
    (item) => item.id === payload.actionId,
  );
  const resolution = action?.activation.resolution;
  if (!mastery || !action || resolution?.kind !== "attack") return null;
  const ability = resolution.attack.ability ?? "str";
  return { attacker, target, action, ability, mastery };
}

// What a mastered weapon adds to a hit. Graze works on a miss instead, and Nick on the off-hand attack.
export function runMasteryHit(
  payload: z.infer<typeof MasteryHitSchema>,
  context: Context,
): SystemResult {
  const found = masteryAttack(payload, context);
  if (!found) return {};
  const { attacker, target, action, ability, mastery } = found;
  const { state } = context;
  const stats = deriveStats(attacker, context);
  const source = `${MASTERY}${mastery}`;
  const up = !isDown(target);
  // Advantage and Disadvantage don't stack, so a second Sap or Vex before the first is used adds nothing.
  const has = (actor: Actor): boolean =>
    actor.activeEffects.some((item) => item.sourceId === source);
  switch (mastery) {
    case "sap":
      return up && !has(target)
        ? {
            events: [
              effect(
                target.id,
                source,
                attacker.id,
                { kind: "disadvantage", on: "attacks", once: true },
                "casterNextTurn",
              ),
            ],
          }
        : {};
    case "slow":
      return up && payload.dealt > 0 && !hasTactic(target, "slowed")
        ? {
            events: [
              effect(
                target.id,
                source,
                attacker.id,
                { kind: "tactic", tactic: "slowed" },
                "casterNextTurn",
              ),
            ],
          }
        : {};
    // shortcut: Vex's Advantage goes on the attacker's next attack against anyone, not only this target.
    case "vex":
      return payload.dealt > 0 && !has(attacker)
        ? {
            events: [
              effect(
                attacker.id,
                source,
                attacker.id,
                { kind: "advantage", on: "attacks", once: true },
                "casterNextTurnEnd",
              ),
            ],
          }
        : {};
    case "topple": {
      if (!up || hasCondition(target, "prone")) return {};
      const save = reportedSave(
        target,
        "con",
        saveDc(stats, ability),
        "Topple",
        context,
      );
      return {
        events: [
          ...save.events,
          ...(save.saved
            ? []
            : [
                effect(
                  target.id,
                  source,
                  attacker.id,
                  { kind: "condition", condition: "prone" },
                  "spellDuration",
                ),
              ]),
        ],
      };
    }
    case "push":
      return up && sizeOf(target, context) <= SIZES.indexOf("large")
        ? { events: pushEvents(attacker, target, 10, state) }
        : {};
    case "cleave": {
      const reach = meleeReach(action);
      if (reach === null || attacker.usedThisTurn.includes(CLEAVE_USED)) {
        return {};
      }
      const [next] = standing(enemies(state, attacker))
        .filter(
          (item) =>
            item.id !== target.id &&
            within5(item, target) &&
            distanceFeet(attacker.position, item.position) <= reach,
        )
        .sort((a, b) => a.hp - b.hp);
      if (!next) return {};
      return {
        events: [
          dndEvent(`${NS}:oncePerTurnUsed`, {
            actor: attacker.id,
            key: CLEAVE_USED,
          }),
        ],
        frames: [
          frame("attackRoll", {
            attacker: attacker.id,
            actionId: action.id,
            target: next.id,
            noModifier: true,
          }),
        ],
      };
    }
    case "graze":
    case "nick":
      return {};
    default:
      return mastery satisfies never;
  }
}

export { MasteryHitSchema };

// Graze: a miss still deals the ability modifier as damage of the weapon's type.
export function runMasteryMiss(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const found = masteryAttack(payload, context);
  if (found?.mastery !== "graze" || isDown(found.target)) return {};
  const { attacker, target, action, ability } = found;
  const { resolution } = action.activation;
  const type = "damage" in resolution ? resolution.damage[0]?.type : undefined;
  const amount = modifierFor(deriveStats(attacker, context), ability);
  if (!type || amount <= 0) return {};
  const { events, dealt } = dealEvents(
    target,
    [
      {
        amount: finalDamage(amount, type, damageResponses(target, context)),
        type,
      },
    ],
    false,
    context,
  );
  return { events, frames: [...concentrationFrame(target, dealt), CHECK_END] };
}

// Where a creature that spent its action on a Dash walks: toward the foe it means to fight next turn.
function dashTarget(actor: Actor, context: Context): Square | null {
  return stepToward(
    { ...actor, budget: { ...actor.budget, action: true } },
    context,
  );
}

// A monster hides as a Bonus Action only where the 2024 rules let it: every foe sees it through at least
// Three-Quarters Cover, or not at all in the dark.
function hiddenFromAll(actor: Actor, context: Context): boolean {
  const { state } = context;
  return standing(enemies(state, actor)).every((foe) => {
    const cover = coverFor(state, foe.position, actor, [foe.id]);
    return (
      cover === 5 ||
      cover === "total" ||
      seeing(foe, actor.position, state, context) === "none"
    );
  });
}

// The system's tactics, with these actions: stand up first, escape a grapple that does more than hold, take
// the off-hand attack, walk on after a Dash, and spend an action that would otherwise go unused on an escape,
// a Search, a Dash toward the foe or a Dodge.
// Grapple, Shove, Help, Hide, Study and Ready are never picked: here each costs a whole action that an
// attack or spell uses better. Disengage would need a step away from foes, which stepToward never takes,
// so a Bonus Action Disengage is never picked either. A Bonus Action Dash or Hide is, as above.
export function tacticalPolicy(decision: Decision, context: Context): string {
  const mover = context.state.actors[decision.actor];
  if (
    decision.id.startsWith(`${NS}:moveTo:`) &&
    mover &&
    hasTactic(mover, "dash")
  ) {
    const square = dashTarget(mover, context);
    if (square) return squareKey(square);
  }
  const classOption = classOptionPolicy(decision, context);
  if (classOption !== null) return classOption;
  if (!decision.id.startsWith(`${NS}:turn:`)) {
    return choosePolicy(decision, context);
  }
  const ids = new Set(decision.options.map((option) => option.id));
  if (ids.has(STAND)) return STAND;
  const escapes = decision.options.filter((option) =>
    option.id.startsWith(encodeOption(ESCAPE, "")),
  );
  // Restrained, swallowed up or crushed each turn "until the grapple ends".
  const crushing = escapes.find(({ id }) => {
    const [, grappler, source] = parseOption(id);
    return mover?.activeEffects.some(
      ({ sourceId, casterId, modifier }) =>
        sourceId === source &&
        casterId === grappler &&
        (modifier.kind !== "condition" || modifier.condition !== "grappled"),
    );
  });
  if (crushing) return crushing.id;
  const chosen = choosePolicy(
    {
      ...decision,
      // Dodge stays, for the party to weigh against attacking (policy.ts).
      options: decision.options.filter(
        (option) => !isTactic(option.id) || option.id === DODGE,
      ),
    },
    context,
  );
  const { state } = context;
  const actor = state.actors[decision.actor];
  if (!actor) return chosen;
  // A dying friend in reach is stabilized with the Action, unless the choice already heals it or leaves the
  // Action free. The player's character first, since its death ends the run; a companion once it has failed a save.
  const [dying] = decision.options
    .flatMap((option) => {
      const [kind, id = ""] = parseOption(option.id);
      const who = state.actors[id];
      return kind === HELP && who && dyingNow(who) ? [{ option, who }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.who.id === PLAYER_ACTOR) - Number(a.who.id === PLAYER_ACTOR) ||
        b.who.deathSaves.failures - a.who.deathSaves.failures,
    );
  const [chosenId = "", chosenTarget] = parseOption(chosen);
  const chosenAction = deriveStats(actor, context).actions.find(
    (item) => item.id === chosenId,
  );
  if (
    dying &&
    chosenTarget !== dying.who.id &&
    (chosen === PASS ||
      chosen === MOVE ||
      chosenAction?.activation.cost.includes("action")) &&
    (dying.who.id === PLAYER_ACTOR ||
      dying.who.deathSaves.failures > 0 ||
      chosen === PASS)
  ) {
    return dying.option.id;
  }
  // A teleport or Leap that lands in reach when walking won't get there.
  if (chosen === MOVE && actor.budget.action) {
    const step = stepToward(actor, context);
    const stats = deriveStats(actor, context);
    const leap =
      step && reachesFrom(actor, step, context)
        ? undefined
        : decision.options.find((option) => {
            const [id, target] = parseOption(option.id);
            const action = stats.actions.find((item) => item.id === id);
            const move = action && moveOf(action);
            return (
              target === actor.id &&
              move &&
              teleportSquares(
                actor,
                move.feet,
                move.movement,
                state,
                context,
              ).some((square) => reachesFrom(actor, square, context))
            );
          });
    if (leap) return leap.id;
  }
  // Cunning Action's Dash when walking alone won't bring a foe into reach this turn.
  if (chosen === MOVE && ids.has(BONUS_DASH) && actor.budget.action) {
    const step = stepToward(actor, context);
    if (!step || !reachesFrom(actor, step, context)) return BONUS_DASH;
  }
  if (chosen !== PASS) return chosen;
  if (ids.has(BONUS_HIDE) && hiddenFromAll(actor, context)) return BONUS_HIDE;
  const offhand = decision.options
    .filter((option) => option.id.startsWith(encodeOption(OFFHAND, "")))
    .sort(
      (a, b) =>
        (state.actors[parseOption(a.id)[1] ?? ""]?.hp ?? 0) -
        (state.actors[parseOption(b.id)[1] ?? ""]?.hp ?? 0),
    )[0];
  if (offhand) return offhand.id;
  if (hasTactic(actor, "dash") && ids.has(MOVE) && dashTarget(actor, context)) {
    return MOVE;
  }
  const foes = standing(enemies(state, actor));
  const [escape] = escapes;
  if (escape) return escape.id;
  if (ids.has(SEARCH)) return SEARCH;
  if (ids.has(DASH) && !ids.has(MOVE) && foes.length > 0) return DASH;
  if (ids.has(DODGE) && foes.some((foe) => within5(foe, actor))) return DODGE;
  return PASS;
}
