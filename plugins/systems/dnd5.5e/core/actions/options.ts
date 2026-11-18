import { classOptions } from "../class-options.ts";
import {
  allies,
  enemies,
  meleeReach,
  PASS,
  speedLeft,
  within5,
} from "../combat.ts";
import { hasteActing, limitsOf } from "../combat/durations.ts";
import { heightChoices, heightOf } from "../combat/falling.ts";
import {
  COLLECT,
  collectable,
  escapeFrom,
  SHAKE,
  shakeable,
} from "../combat/fear.ts";
import { escapeDc, grapplesOn } from "../combat/grapple.ts";
import { encodeOption } from "../combat/ids.ts";
import { mountOptions } from "../combat/mounts.ts";
import { hasPassive, sizeOf, squareName } from "../combat/queries.ts";
import { fogged, knownFoes, partySight } from "../fog.ts";
import { distanceFeet, pushTo, squareKey } from "../grid.ts";
import { FLEE } from "../legendary.ts";
import { unhindered } from "../movement-modes.ts";
import { ABILITY_NAMES } from "../schemas.ts";
import {
  type Actor,
  dndEvent,
  type DndState,
  familiarOwner,
  hasCondition,
  INCAPACITATING,
  isDown,
  NS,
} from "../state.ts";
import { deriveStats, type KnownAction, type Stats } from "../stats.ts";
import { bonusDashFeet, hasTactic, TACTIC, walkSpeed } from "../tactics.ts";
import { bonusAttackOptions, tradeOptions } from "./bonus-attacks.ts";
import { checkName } from "./checks.ts";
import { capitalized, dyingNow, standing } from "./common.ts";
import { saveDc } from "./contests.ts";
import { dimHide, hiddenFromAll } from "./hide.ts";
import {
  BONUS_DASH,
  BONUS_DISENGAGE,
  BONUS_DODGE,
  BONUS_HELP,
  BONUS_HIDE,
  BONUS_SEARCH,
  BONUS_STUDY,
  BREAK_OUT,
  DASH,
  DISENGAGE,
  DODGE,
  ESCAPE,
  GRAPPLE,
  HELP,
  HIDE,
  HIDE_DC,
  READY,
  RISE,
  SEARCH,
  SHOVE,
  SINK,
  SLIP,
  STABILIZE_DC,
  STAND,
  STUDY,
  STUDY_IMAGE,
  STUDY_PHANTASM,
} from "./ids.ts";
import { studyableImages, studySkill } from "./study.ts";
import {
  type ContentAccess,
  type Decision,
  PLAYER_ACTOR,
  type SystemEvent,
} from "#sdk";

export function dashBonus(stats: Stats): number {
  return stats.passives.reduce(
    (total, passive) =>
      total + (passive.kind === "dashBonus" ? passive.feet : 0),
    0,
  );
}

export function halfSpeed(stats: Stats): number {
  return Math.ceil(stats.speed / 10) * 5;
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
// What a Bonus Action tactic costs beyond the Bonus Action: nothing ([]), a use of a resource, as Timely Retreat's,
// or null when nothing lets the bearer take it.
export function bonusTacticCost(
  actor: Actor,
  stats: Stats,
  tactic: "dash" | "disengage" | "hide" | "dodge" | "search" | "study" | "help",
): SystemEvent[] | null {
  // Expeditious Retreat's Dash as a Bonus Action costs nothing more.
  if (
    tactic === "dash" &&
    actor.activeEffects.some(({ modifier }) => modifier.kind === "bonusDash")
  ) {
    return [];
  }
  // Conjure Woodland Beings' Disengage as a Bonus Action, likewise.
  if (
    tactic === "disengage" &&
    actor.activeEffects.some(
      ({ modifier }) => modifier.kind === "bonusDisengage",
    )
  ) {
    return [];
  }
  let cost: SystemEvent[] | null = null;
  for (const passive of stats.passives) {
    if (passive.kind !== "bonusTactics" || !passive.tactics.includes(tactic)) {
      continue;
    }
    if (!passive.resource) return [];
    if (
      (actor.resourcesSpent[passive.resource] ?? 0) <
      (stats.resources[passive.resource] ?? 0)
    ) {
      cost ??= [
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: passive.resource,
        }),
      ];
    }
  }
  return cost;
}

// Uncertain Footing: a hampered creature can't take the Dash action.
const canDash = (actor: Actor): boolean =>
  !actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "actionLimit" && modifier.noDash,
  );

// Hunter's Rime: a creature Hunter's Mark marks can't take the Disengage action.
function canDisengage(actor: Actor): boolean {
  return !actor.activeEffects.some(
    ({ modifier }) => modifier.kind === "actionLimit" && modifier.noDisengage,
  );
}

function bonusTacticOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  if (!actor.budget.bonusAction) return [];
  const allowed = new Set(
    (
      ["dash", "disengage", "hide", "dodge", "search", "study", "help"] as const
    ).filter((tactic) => bonusTacticCost(actor, stats, tactic) !== null),
  );
  const shaded = dimHide(actor, state, access, stats);
  const options: { id: string; label: string }[] = [];
  const extra = bonusDashFeet(actor, stats) + dashBonus(stats);
  if (
    allowed.has("dash") &&
    extra > 0 &&
    !hasCondition(actor, "grappled", "restrained") &&
    canDash(actor)
  ) {
    options.push({
      id: BONUS_DASH,
      label: `Dash as a Bonus Action (${String(extra)} ft more this turn)`,
    });
  }
  if (
    allowed.has("disengage") &&
    !hasTactic(actor, "disengage") &&
    canDisengage(actor)
  ) {
    options.push({
      id: BONUS_DISENGAGE,
      label: "Disengage as a Bonus Action (no Opportunity Attacks this turn)",
    });
  }
  if (allowed.has("dodge") && !hasTactic(actor, "dodge")) {
    options.push({
      id: BONUS_DODGE,
      label: "Dodge as a Bonus Action (attacks against you have Disadvantage)",
    });
  }
  if (
    (allowed.has("hide") || shaded) &&
    !hasTactic(actor, "hidden") &&
    (shaded || hiddenFromAll(actor, state, access))
  ) {
    options.push({
      id: BONUS_HIDE,
      label: `Hide as a Bonus Action (Stealth, DC ${String(HIDE_DC)})`,
    });
  }
  if (allowed.has("search") && searchable(actor, state, access)) {
    options.push({
      id: BONUS_SEARCH,
      label: "Search as a Bonus Action (Perception)",
    });
  }
  if (allowed.has("help")) {
    options.push(
      ...helpOptions(actor, state, access, stats).map((option) => ({
        id: option.id.replace(HELP, BONUS_HELP),
        label: `${option.label} as a Bonus Action`,
      })),
    );
  }
  // Study is the player's, as its action is (tacticOptions).
  if (allowed.has("study") && actor.id === PLAYER_ACTOR) {
    for (const foe of standing(knownFoes(state, actor, access))) {
      options.push({
        id: encodeOption(BONUS_STUDY, foe.id),
        label: `Study ${foe.name} as a Bonus Action (${capitalized(studySkill(foe, access))})`,
      });
    }
  }
  return options;
}

// Help: distracting a foe for an ally's next attack, or helping an ally beside it with a check. With Tag Team the
// player may also trade places with a willing ally beside it.
function helpOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
  stats: Stats,
): { id: string; label: string }[] {
  const foes = standing(knownFoes(state, actor, access));
  const friends = standing(allies(state, actor)).filter(
    (item) => item.id !== actor.id,
  );
  // Harper Agent's Distracting Melody helps against an enemy farther off.
  const helpFeet = Math.max(
    5,
    ...stats.passives.flatMap((passive) =>
      passive.kind === "helpRange" ? [passive.feet] : [],
    ),
  );
  const options: { id: string; label: string }[] = [];
  const swaps =
    actor.id === PLAYER_ACTOR && hasPassive(stats, "helpSwap")
      ? friends.filter(
          (item) =>
            within5(actor, item) && !hasCondition(item, ...INCAPACITATING),
        )
      : [];
  const add = (target: Actor, label: string): void => {
    options.push({ id: encodeOption(HELP, target.id), label });
    for (const ally of swaps) {
      options.push({
        id: encodeOption(HELP, target.id, ally.id),
        label: `${label}, trading places with ${ally.name}`,
      });
    }
  };
  if (friends.length > 0) {
    for (const foe of foes.filter(
      (item) =>
        within5(actor, item) ||
        distanceFeet(actor.position, item.position) <= helpFeet,
    )) {
      add(foe, `Help an ally attack ${foe.name}`);
    }
  }
  for (const friend of friends.filter((item) => within5(actor, item))) {
    add(friend, `Help ${friend.name} with a check`);
  }
  return options;
}

// Searching is offered where the party saw a foe slip out of sight, not for one it never knew of.
function searchable(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): boolean {
  const sight = fogged(state) ? partySight(state, access) : null;
  return enemies(state, actor).some(
    (foe) =>
      hasTactic(foe, "hidden") &&
      (actor.side !== "party" ||
        !sight ||
        (foe.position !== null && sight.squares.has(squareKey(foe.position)))),
  );
}

export function tacticOptions(
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): { id: string; label: string }[] {
  if (!state.combat || isDown(actor) || hasCondition(actor, ...INCAPACITATING))
    return [];
  const stats = deriveStats(actor, access);
  // An uncommanded Steel Defender or Primal Companion only Dodges, once its action is free.
  if (limitsOf(actor).dodgeOnly) {
    return actor.budget.action
      ? [{ id: DODGE, label: "Dodge (attacks against you have Disadvantage)" }]
      : [];
  }
  const options: { id: string; label: string }[] = [];
  const half = halfSpeed(stats);
  // Prone that Hideous Laughter keeps it in can't be ended by standing.
  if (
    hasCondition(actor, "prone") &&
    !actor.activeEffects.some(
      ({ cantStand, modifier }) =>
        cantStand &&
        modifier.kind === "condition" &&
        modifier.condition === "prone",
    ) &&
    (!actor.position || speedLeft(actor, stats) >= half)
  ) {
    options.push({
      id: STAND,
      label: `Stand up (${String(half)} ft of movement)`,
    });
  }
  const height = heightOf(actor);
  for (const { mode, up } of heightChoices(actor, state, access)) {
    const to = height + (up ? 10 : -10);
    options.push({
      id: encodeOption(up ? RISE : SINK, mode),
      label: `${mode === "fly" ? "Fly" : "Climb"} ${up ? "up" : "down"} 10 ft (${to > 0 ? `${String(to)} ft up` : "to the ground"}, 10 ft of movement)`,
    });
  }
  // shortcut: every grapple counts as nonmagical, and the 5 feet come from its Speed before the grapple stops it.
  if (unhindered(actor, stats, true) && stats.speed - actor.moved >= 5) {
    for (const grapple of grapplesOn(actor)) {
      const grappler = state.actors[grapple.casterId];
      options.push({
        id: encodeOption(SLIP, grapple.casterId, grapple.sourceId),
        label: `Slip free of ${grappler ? `${grappler.name}'s` : "the"} grapple (5 ft of movement)`,
      });
    }
  }
  options.push(...mountOptions(actor, state, access));
  options.push(...bonusAttackOptions(actor, state, access, stats));
  options.push(...classOptions(actor, state, access));
  options.push(...bonusTacticOptions(actor, state, access, stats));
  if (!actor.budget.action) return options;
  options.push(...tradeOptions(actor, stats));
  // Shut away, it can only try to get out, as from a Maze.
  const seal = actor.activeEffects.find(
    ({ modifier }) => modifier.kind === "sealed",
  );
  if (seal) {
    if (seal.modifier.kind === "sealed" && seal.modifier.escape) {
      const { ability, dc, skill } = seal.modifier.escape;
      options.push({
        id: encodeOption(BREAK_OUT, seal.casterId, seal.sourceId),
        label: `Try to escape (${ABILITY_NAMES[ability]}, ${capitalized(skill)}, DC ${String(dc)})`,
      });
    }
    if (seal.modifier.kind === "sealed" && seal.modifier.leave) {
      options.push({
        id: encodeOption(BREAK_OUT, seal.casterId, seal.sourceId),
        label: "Come back",
      });
    }
    return options;
  }
  // Everyone else's turns are played by tacticalPolicy, so they're offered only what it can pick, which also
  // spares working out every Study and Shove on every monster's turn.
  const full = actor.id === PLAYER_ACTOR;

  const foes = standing(knownFoes(state, actor, access));
  const near = foes.filter((foe) => within5(actor, foe));
  const extra = walkSpeed(actor, stats) + dashBonus(stats);
  if (
    extra > 0 &&
    !hasCondition(actor, "grappled", "restrained") &&
    canDash(actor)
  ) {
    options.push({
      id: DASH,
      label: `Dash (${String(extra)} ft more this turn)`,
    });
  }
  // Haste's additional action: Dash, Disengage or Hide besides its one attack.
  if (hasteActing(actor)) {
    if (canDisengage(actor)) {
      options.push({
        id: DISENGAGE,
        label: "Disengage (no Opportunity Attacks this turn)",
      });
    }
    if (!hasTactic(actor, "hidden") && hiddenFromAll(actor, state, access)) {
      options.push({
        id: HIDE,
        label: `Hide (Stealth, DC ${String(HIDE_DC)})`,
      });
    }
    return options;
  }
  options.push({
    id: DODGE,
    label: "Dodge (attacks against you have Disadvantage)",
  });
  // Shaking an ally out of a spell, as out of Sleep, and saving against a spell with an action, as Irresistible Dance.
  for (const ally of shakeable(actor, state)) {
    const escape = escapeFrom(ally)?.escape;
    options.push({
      id: encodeOption(SHAKE, ally.id),
      label: escape
        ? `Free ${ally.name} (${checkName(escape)}, DC ${String(escape.dc)})`
        : `Shake ${ally.name} out of it`,
    });
  }
  for (const held of collectable(actor)) {
    options.push({
      id: encodeOption(COLLECT, held.casterId, held.sourceId),
      label: held.escape
        ? `Break free (${checkName(held.escape)}, DC ${String(held.escape.dc)})`
        : `Collect yourself (${ABILITY_NAMES[held.repeatSave?.ability ?? "wis"]} save, DC ${String(held.repeatSave?.dc ?? 10)})`,
    });
  }
  // Help also stabilizes a dying creature within 5 feet, which every companion should be able to do.
  for (const dying of allies(state, actor).filter(
    (item) => item.id !== actor.id && dyingNow(item) && within5(actor, item),
  )) {
    options.push({
      id: encodeOption(HELP, dying.id),
      label: `Stabilize ${dying.name} (Medicine, DC ${String(STABILIZE_DC)})`,
    });
  }
  if (searchable(actor, state, access)) {
    options.push({ id: SEARCH, label: "Search for hidden foes (Perception)" });
  }
  // Studying something it might see through, without naming it an illusion.
  for (const zone of studyableImages(actor, state)) {
    options.push({
      id: encodeOption(STUDY_IMAGE, zone.owner, zone.sourceId),
      label: `Study what's at ${squareName(zone.at)} (Investigation)`,
    });
  }
  for (const phantasm of actor.activeEffects.filter(
    ({ studyDc }) => studyDc !== undefined,
  )) {
    options.push({
      id: encodeOption(STUDY_PHANTASM, phantasm.casterId, phantasm.sourceId),
      label: "Study what you see (Investigation)",
    });
  }
  for (const grapple of grapplesOn(actor)) {
    const grappler = state.actors[grapple.casterId];
    options.push({
      id: encodeOption(ESCAPE, grapple.casterId, grapple.sourceId),
      label: `Escape ${grappler ? `${grappler.name}'s` : "the"} grapple (Athletics or Acrobatics, DC ${String(escapeDc(grapple, state, access))})`,
    });
  }
  // A familiar can't attack, but it can Help and take its other actions, which tacticalPolicy weighs for it.
  if (!full && familiarOwner(actor) === null) return options;
  if (canDisengage(actor)) {
    options.push({
      id: DISENGAGE,
      label: "Disengage (no Opportunity Attacks this turn)",
    });
  }
  if (!hasTactic(actor, "hidden") && hiddenFromAll(actor, state, access)) {
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
  options.push(...helpOptions(actor, state, access, stats));
  if (!full) return options;
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

// The turn decision with these actions added after Move and before fleeing and ending the turn, so the
// choices listed first stay as they were.
// While another creature controls the player's character, the tactics make its choices in a fight.
// shortcut: a Reaction is still put to the player.
export function controlledChoice(
  decision: Decision | null,
  state: DndState,
): Decision | null {
  return decision?.actor === PLAYER_ACTOR &&
    state.combat &&
    state.actors[PLAYER_ACTOR]?.ownSide
    ? { ...decision, policy: true }
    : decision;
}

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
