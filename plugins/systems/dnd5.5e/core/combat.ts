import {
  type ContentAccess,
  type Decision,
  type EncounterOptions,
  type Frame,
  PLAYER_ACTOR,
  type SystemContext,
  type SystemEvent,
  type SystemResult,
  awaitDecision,
} from "#sdk";
import { z } from "zod";
import {
  type Square,
  distanceFeet,
  inArea,
  parseSquare,
  placeOnMap,
  placeSides,
  rangeFeet,
  reachableSquares,
  squareKey,
  wallKeys,
} from "./grid.ts";
import {
  FLEE,
  betweenTurns,
  bossAction,
  chooseBossAction,
  conditionsApplied,
  fleeOptions,
  lairTurns,
  legendaryResistance,
  runFlee,
} from "./legendary.ts";
import { concentrationDc, finalDamage, halved, rollD20 } from "./rules.ts";
import type {
  Ability,
  Battlemap,
  Damage,
  Duration,
  LeafEffect,
  Loot,
  Resolution,
  Targeting,
} from "./schemas.ts";
import { ClassSchema, MonsterSchema, PregenSchema } from "./schemas.ts";
import { treasure } from "./gear.ts";
import { dropToOneEvents, traitSaveAdvantage } from "./trait-rules.ts";
import {
  behindTotalCover,
  coverBonus,
  coverFor,
  difficultSquares,
  seeing,
  terrainOf,
} from "./sight.ts";
import {
  criticalFrom,
  offerInspiration,
  onceEnded,
  turnRecharge,
} from "./class-rules.ts";
import {
  ADD,
  AIM_AREA,
  BACK,
  CONFIRM,
  PICK,
  aimScore,
  aimSquares,
  caughtBy,
  describeCaught,
  directionName,
  nextPick,
  pickOptions,
} from "./targeting.ts";
import {
  type Actor,
  type DndState,
  NS,
  INCAPACITATING,
  applyDndEvent,
  dndEvent,
  freshActor,
  hasCondition,
  isDead,
  isDown,
} from "./state.ts";
import {
  type KnownAction,
  type Stats,
  attackBonus,
  damageResponses,
  deriveStats,
  evaluateFormula,
  immuneToCondition,
  lookup,
  modifierFor,
  passiveModifiers,
  rollAmount,
  rollDiceNotation,
  saveBonus,
  scaleActivation,
} from "./stats.ts";
import {
  dodging,
  grappledAwayFrom,
  hasTactic,
  lightAttackEvents,
  masteryOf,
  revealEvents,
  speedOf,
} from "./tactics.ts";

export type Context = SystemContext<DndState>;

export const PASS = "pass";
export const CREATE_CHARACTER = "create";
export const HIT_DICE = "hitDice";
const DEATH_SAVE = "deathSave";
const SEPARATOR = "|";
export const ALL = "all"; // an area takes everyone, and projectiles go for the lowest HP
const DECLINE = "decline";
export const MOVE = "move";
const STAY = "stay";
const ITEM_PREFIX = "item:"; // an action that uses up the item, such as a potion
export const AIM = "@"; // an area aimed at a square ("@x,y") or a creature ("@" and its id)

function actorOf(state: DndState, id: string): Actor {
  const actor = state.actors[id];
  if (!actor) throw new Error(`Unknown actor ${id}`);
  return actor;
}

function frame(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
): Frame {
  return { kind: `${NS}:${kind}`, payload };
}

export const CHECK_END = frame("checkCombatEnd", {});

export function hasFlag(
  actor: Actor,
  kind: "advantage" | "disadvantage",
  on: "attacks" | "saves" | "checks" | "attacksAgainst",
  stats: Stats,
): boolean {
  return [
    ...actor.activeEffects.map((effect) => effect.modifier),
    ...passiveModifiers(stats.passives),
  ].some((modifier) => modifier.kind === kind && modifier.on === on);
}

function hasPassive(
  stats: Stats,
  kind: "packTactics" | "undeadFortitude" | "magicResistance",
): boolean {
  return stats.passives.some((passive) => passive.kind === kind);
}

// Effects from one source count once, so casting Bless twice can't add two d4s.
export function rollBonus(
  actor: Actor,
  to: "attacks" | "saves" | "checks",
  context: Context,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const effect of actor.activeEffects) {
    const { modifier } = effect;
    if (modifier.kind !== "bonus" || modifier.to !== to) continue;
    if (seen.has(effect.sourceId)) continue;
    seen.add(effect.sourceId);
    const caster = context.state.actors[effect.casterId] ?? actor;
    total += rollAmount(
      modifier.amount,
      deriveStats(caster, context),
      context.dice,
    );
  }
  const stats = deriveStats(actor, context);
  for (const modifier of passiveModifiers(stats.passives)) {
    if (modifier.kind === "bonus" && modifier.to === to) {
      total += rollAmount(modifier.amount, stats, context.dice);
    }
  }
  return total;
}

export function allies(state: DndState, actor: Actor): readonly Actor[] {
  return state.combat
    ? state.combat.order.flatMap((id) => {
        const other = actorOf(state, id);
        return other.side === actor.side ? [other] : [];
      })
    : [];
}

export function enemies(state: DndState, actor: Actor): readonly Actor[] {
  return state.combat
    ? state.combat.order.flatMap((id) => {
        const other = actorOf(state, id);
        return other.side !== actor.side ? [other] : [];
      })
    : [];
}

// A spell can use a slot of its own level or higher, which is also how Pact Magic casts low spells.
// The feet a melee action reaches, or null for a ranged one.
export function meleeReach(action: KnownAction): number | null {
  const { targeting } = action.activation;
  if (!("creatures" in targeting)) return null;
  const feet = rangeFeet(targeting.range);
  return feet > 0 && feet <= 10 ? feet : null;
}

// Whether an action can reach this creature from where the actor stands. For an area, the creature is
// what it's aimed at: a sphere's centre must be in range, and a cone or line must reach it.
export function reaches(
  action: KnownAction,
  actor: Actor,
  target: Actor,
): boolean {
  const { targeting } = action.activation;
  if ("self" in targeting) return true;
  const distance = distanceFeet(actor.position, target.position);
  if ("area" in targeting && targeting.range === "self") {
    return distance <= targeting.area.radius;
  }
  return distance <= rangeFeet(targeting.range);
}

export function within5(a: Actor, b: Actor): boolean {
  return distanceFeet(a.position, b.position) <= 5;
}

export function speedLeft(actor: Actor, stats: Stats): number {
  const held = hasCondition(actor, "grappled", "restrained", ...INCAPACITATING);
  return held || !actor.position
    ? 0
    : Math.max(0, speedOf(actor, stats) - actor.moved);
}

export function moveSquares(
  actor: Actor,
  state: DndState,
  stats: Stats,
): ReturnType<typeof reachableSquares> {
  const grid = state.combat?.grid;
  if (!grid || !actor.position) return [];
  const others = Object.values(state.actors).filter(
    (item) => item.id !== actor.id && item.position && !isDead(item),
  );
  const keys = (list: readonly Actor[]): Set<string> =>
    new Set(
      list.flatMap((item) => (item.position ? [squareKey(item.position)] : [])),
    );
  const walls = state.combat?.walls ?? [];
  return reachableSquares(
    actor.position,
    speedLeft(actor, stats),
    grid,
    new Set([
      ...keys(
        others.filter((item) => item.side !== actor.side && !isDown(item)),
      ),
      ...walls,
    ]),
    new Set([...keys(others), ...walls]),
    difficultSquares(state),
  );
}

// "C7" for the third column of the seventh row, as on a battle map.
export function squareName(square: Square): string {
  return `${String.fromCharCode(65 + (square.x % 26))}${String(square.y + 1)}`;
}

function slotToSpend(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): number | null {
  const lowest = action.spellLevel ?? 1;
  for (let level = lowest; level <= stats.slots.length; level += 1) {
    const spent = actor.resourcesSpent[`slot:${String(level)}`] ?? 0;
    if (spent < (stats.slots[level - 1] ?? 0)) return level;
  }
  return null;
}

// The higher slots worth offering: ones above the slot the spell would use anyway, if the spell gains from them.
function upcastSlots(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): readonly number[] {
  const lowest = slotToSpend(action, actor, stats);
  if (!action.upcast || lowest === null) return [];
  return stats.slots.flatMap((count, index) => {
    const level = index + 1;
    return level > lowest &&
      (actor.resourcesSpent[`slot:${String(level)}`] ?? 0) < count
      ? [level]
      : [];
  });
}

function withUpcasts(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
  target: string,
  label: string,
): { id: string; label: string }[] {
  const id = `${action.id}${SEPARATOR}${target}`;
  return [
    { id, label },
    ...upcastSlots(action, actor, stats).map((slot) => ({
      id: `${id}${SEPARATOR}${String(slot)}`,
      label: `${label} (level ${String(slot)} slot)`,
    })),
  ];
}

// A Charmed creature can't target its charmer with attacks or harmful magic.
function charmersOf(actor: Actor): ReadonlySet<string> {
  return new Set(
    actor.activeEffects.flatMap(({ modifier, casterId }) =>
      modifier.kind === "condition" && modifier.condition === "charmed"
        ? [casterId]
        : [],
    ),
  );
}

function fitsType(
  item: Actor,
  targeting: Targeting,
  access: ContentAccess,
): boolean {
  if ("self" in targeting || !targeting.creatureTypes) return true;
  return targeting.creatureTypes.includes(
    deriveStats(item, access).creatureType ?? "",
  );
}

export function canAfford(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): boolean {
  return action.activation.cost.every((cost) => {
    if (cost === "action") return actor.budget.action;
    if (cost === "bonusAction") return actor.budget.bonusAction;
    if (cost === "reaction") return actor.budget.reaction;
    if (cost === "slot") return slotToSpend(action, actor, stats) !== null;
    return (
      (actor.resourcesSpent[cost.resource] ?? 0) <
      (stats.resources[cost.resource] ?? 0)
    );
  });
}

// The creatures an action can be aimed at from where the actor stands.
function inReach(
  action: KnownAction,
  actor: Actor,
  state: DndState,
  access: ContentAccess,
): readonly Actor[] {
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  const charmers = charmersOf(actor);
  return (
    targeting.side === "enemy"
      ? enemies(state, actor).filter(
          (item) => !isDown(item) && !charmers.has(item.id),
        )
      : allies(state, actor)
  )
    .filter((item) => !isDead(item))
    .filter((item) => fitsType(item, targeting, access))
    .filter((item) => reaches(action, actor, item))
    .filter((item) => !behindTotalCover(state, actor, item));
}

// How many creatures, darts or rays an action takes when cast with this slot.
function targetCount(action: KnownAction, slot: number | undefined): number {
  const above = (slot ?? 0) - (action.spellLevel ?? 0);
  const activation = action.upcast
    ? scaleActivation(action.activation, action.upcast.perSlotLevel, above)
    : action.activation;
  const { projectiles, targeting } = activation;
  return projectiles ?? ("creatures" in targeting ? targeting.creatures : 1);
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
      const suffix = slot === undefined ? "" : `${SEPARATOR}${String(slot)}`;
      const note = slot === undefined ? "" : ` (level ${String(slot)} slot)`;
      const id = (target: string): string =>
        `${action.id}${SEPARATOR}${target}${suffix}`;
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

export function startCombat(
  encounter: {
    readonly id: string;
    readonly monsters: readonly {
      readonly monster: string;
      readonly count: number;
    }[];
    readonly forPartySize?: number | undefined;
    readonly battlemap?: Battlemap | undefined;
    readonly loot?: Loot | undefined;
    readonly lair?: boolean | undefined;
    readonly surprise?: "party" | "enemies" | undefined;
  },
  context: Context,
  { canFlee, defeatContinues }: EncounterOptions,
): SystemResult {
  const party = Object.values(context.state.actors).filter(
    (actor) => actor.side === "party" && !isDead(actor),
  );
  const { forPartySize } = encounter;
  const monsters: Actor[] = [];
  for (const { monster, count: written } of encounter.monsters) {
    const count = forPartySize
      ? Math.max(1, Math.round((written * party.length) / forPartySize))
      : written;
    const statBlock = lookup(context, MonsterSchema, monster);
    const slug = monster.slice(monster.lastIndexOf("/") + 1);
    for (let index = 1; index <= count; index += 1) {
      monsters.push(
        freshActor({
          id: `${encounter.id}:${slug}-${String(index)}`,
          name:
            count > 1 ? `${statBlock.name} ${String(index)}` : statBlock.name,
          side: "enemy",
          source: { kind: "monster", statBlockId: monster },
          hp: statBlock.hp,
          inventory: [],
        }),
      );
    }
  }

  // The story's word on surprise, such as from a Stealth check, beats the encounter's own.
  const surprised = context.state.surprise ?? encounter.surprise;
  const caught = { party: "party", enemies: "enemy" }[surprised ?? "party"];
  const rolled = [...party, ...monsters].map((actor, position) => ({
    id: actor.id,
    position,
    total:
      (surprised && actor.side === caught
        ? rollD20(context.dice, { advantage: false, disadvantage: true })
            .natural
        : context.dice.roll(20)) + deriveStats(actor, context).initiative,
  }));
  // Ties keep their listed order, so the result is the same on every machine.
  const sorted = rolled.sort(
    (a, b) => b.total - a.total || a.position - b.position,
  );
  const order = sorted.map((item) => item.id);
  // Lair actions come on initiative count 20 and lose ties, so after everyone who rolled 20 or more.
  const lair = encounter.lair
    ? { at: sorted.filter((item) => item.total >= 20).length }
    : undefined;
  const { battlemap } = encounter;
  const walls = battlemap ? wallKeys(battlemap.walls) : [];
  const terrain = battlemap ? terrainOf(battlemap) : null;
  const toSquare = ([x, y]: readonly [number, number]): Square => ({ x, y });
  const { grid, positions } = battlemap
    ? ((): ReturnType<typeof placeSides> => {
        const mapGrid = { width: battlemap.columns, height: battlemap.rows };
        const taken = new Set(walls);
        return {
          grid: mapGrid,
          positions: {
            ...placeOnMap(
              party.map((actor) => actor.id),
              battlemap.party.map(toSquare),
              mapGrid,
              taken,
            ),
            ...placeOnMap(
              monsters.map((actor) => actor.id),
              battlemap.monsters.map(toSquare),
              mapGrid,
              taken,
            ),
          },
        };
      })()
    : placeSides(
        party.map((actor) => actor.id),
        monsters.map((actor) => actor.id),
      );

  return {
    events: [
      { kind: "encounterStarted", encounter: encounter.id },
      dndEvent(`${NS}:combatStarted`, {
        encounter: encounter.id,
        monsters,
        order,
        grid,
        positions,
        ...(battlemap
          ? {
              walls: [...walls],
              ...(terrain ? { terrain } : {}),
              map: {
                image: battlemap.image,
                imageWidth: battlemap.imageWidth,
                imageHeight: battlemap.imageHeight,
                crop: battlemap.crop,
              },
            }
          : {}),
        ...(canFlee ? { canFlee } : {}),
        ...(defeatContinues ? { defeatContinues } : {}),
        ...(encounter.loot ? { loot: encounter.loot } : {}),
        ...(surprised ? { surprised } : {}),
        ...(lair ? { lair } : {}),
      }),
    ],
    // With nobody on 20 or more, the lair acts before anyone.
    ...(lair?.at === 0
      ? {
          frames: lairTurns(
            {
              ...context.state,
              actors: Object.fromEntries(
                monsters.map((item) => [item.id, item]),
              ),
              combat: { encounter: encounter.id, order, index: 0, round: 1 },
            },
            "start",
            context,
          ),
        }
      : {}),
  };
}

function payCosts(
  action: KnownAction,
  actor: Actor,
  context: Context,
  slotLevel?: number,
): SystemEvent[] {
  const events: SystemEvent[] = [];
  for (const cost of action.activation.cost) {
    if (cost === "action" || cost === "bonusAction" || cost === "reaction") {
      events.push(
        dndEvent(`${NS}:budgetSpent`, { actor: actor.id, kind: cost }),
      );
    } else if (cost === "slot") {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: `slot:${String(slotLevel ?? slotToSpend(action, actor, deriveStats(actor, context)) ?? action.spellLevel ?? 1)}`,
        }),
      );
    } else {
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: cost.resource,
        }),
      );
    }
  }
  return events;
}

export function concentrationFrame(
  target: Actor,
  amount: number,
): readonly Frame[] {
  return target.concentratingOn !== null && amount > 0
    ? [
        frame("concentrationSave", {
          actor: target.id,
          dc: concentrationDc(amount),
        }),
      ]
    : [];
}

// Reports the damage, and whatever follows from it, as events.
// The difficulty setting scales the damage the party takes, and only that, so the books' monsters keep
// their numbers: Story takes a third of it, Hard adds half again.
const DAMAGE_TO_PARTY = { story: 1 / 3, normal: 1, hard: 1.5 } as const;

function scaledForParty(
  target: Actor,
  amount: number,
  state: DndState,
): number {
  if (target.side !== "party" || amount <= 0) return amount;
  const factor = DAMAGE_TO_PARTY[state.difficulty ?? "normal"];
  return Math.max(1, Math.round(amount * factor));
}

export function damageEvents(
  target: Actor,
  rolled: number,
  type: Damage["type"],
  critical: boolean,
  context: Context,
): SystemEvent[] {
  const amount = scaledForParty(target, rolled, context.state);
  if (amount <= 0) return [];
  // Damage left over after reaching 0 HP kills a character if it's at least their maximum.
  const remaining = amount - target.tempHp - Math.max(0, target.hp);
  const fortitude =
    target.hp > 0 &&
    remaining >= 0 &&
    !critical &&
    type !== "radiant" &&
    hasPassive(deriveStats(target, context), "undeadFortitude")
      ? rollSave(target, "con", 5 + amount, context)
      : null;
  if (fortitude?.saved) {
    return [
      ...fortitude.events,
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining - 1,
        type,
        critical,
        massive: false,
      }),
    ];
  }
  const endured = fortitude
    ? null
    : dropToOneEvents(
        target,
        amount,
        remaining,
        { type, critical },
        deriveStats(target, context),
      );
  if (endured) return endured;
  const massive =
    target.side === "party" && remaining >= deriveStats(target, context).maxHp;
  const events: SystemEvent[] = [
    ...(fortitude?.events ?? []),
    dndEvent(`${NS}:damaged`, {
      actor: target.id,
      amount,
      type,
      critical,
      massive,
    }),
  ];
  if (target.side === "enemy") {
    if (target.hp > 0 && remaining >= 0) {
      events.push({ kind: "actorDefeated", actor: target.id });
    }
  } else if (massive) {
    events.push({ kind: "actorDefeated", actor: target.id });
  } else if (target.hp > 0 && remaining >= 0) {
    events.push({ kind: "actorDowned", actor: target.id });
  }
  return events;
}

// Several hits on one target, reported in turn so each one sees the HP the last one left.
export function dealEvents(
  target: Actor,
  hits: readonly { readonly amount: number; readonly type: Damage["type"] }[],
  critical: boolean,
  context: Context,
): { events: SystemEvent[]; dealt: number } {
  let { state } = context;
  const events: SystemEvent[] = [];
  let dealt = 0;
  for (const { amount, type } of hits) {
    const current = state.actors[target.id] ?? target;
    for (const event of damageEvents(
      current,
      amount,
      type,
      critical,
      context,
    )) {
      events.push(event);
      if (state.actors[target.id]) state = applyDndEvent(state, event);
    }
    dealt += Math.max(0, scaledForParty(target, amount, context.state));
  }
  return { events, dealt };
}

// shortcut: a timed spell lasts until the effect is removed some other way, since nothing tracks minutes yet.
export function effectEnds(
  duration: Duration,
): "concentration" | "casterNextTurn" | "casterNextTurnEnd" | "spellDuration" {
  if (typeof duration !== "object") return "casterNextTurn";
  if ("until" in duration) {
    return duration.until === "yourNextTurnEnd"
      ? "casterNextTurnEnd"
      : "casterNextTurn";
  }
  return "concentration" in duration ? "concentration" : "spellDuration";
}

function leafEvents(
  effects: readonly LeafEffect[],
  sourceId: string,
  caster: Actor,
  target: Actor,
  context: Context,
  save?: { readonly ability: Ability; readonly dc: number },
): SystemEvent[] {
  const stats = deriveStats(caster, context);
  const events: SystemEvent[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "heal": {
        const max = deriveStats(target, context).maxHp;
        const rolled = rollAmount(effect.amount, stats, context.dice);
        // Healing beyond the maximum is lost, so only what's really gained is reported.
        events.push(
          dndEvent(`${NS}:healed`, {
            actor: target.id,
            amount: Math.min(rolled, max - Math.max(target.hp, 0)),
            max,
          }),
        );
        break;
      }
      case "tempHp":
        events.push(
          dndEvent(`${NS}:tempHpGained`, {
            actor: target.id,
            amount: rollAmount(effect.amount, stats, context.dice),
          }),
        );
        break;
      case "modifier":
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: effect.modifier,
              ends: effectEnds(effect.duration),
            },
          }),
        );
        break;
      case "applyCondition":
        if (immuneToCondition(deriveStats(target, context), effect.condition))
          break;
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId,
              casterId: caster.id,
              modifier: { kind: "condition", condition: effect.condition },
              ends: effectEnds(effect.duration),
              ...(effect.repeatSave && save ? { repeatSave: save } : {}),
              ...(effect.endsOnDamage ? { endsOnDamage: true } : {}),
            },
          }),
        );
        // Being Incapacitated ends Concentration.
        if (
          INCAPACITATING.includes(effect.condition) &&
          target.concentratingOn !== null
        ) {
          events.push(
            dndEvent(`${NS}:concentrationEnded`, { actor: target.id }),
          );
        }
        break;
      case "removeCondition":
        events.push(
          dndEvent(`${NS}:conditionRemoved`, {
            actor: target.id,
            condition: effect.condition,
          }),
        );
        break;
      case "extraAction":
        events.push(dndEvent(`${NS}:actionRegained`, { actor: target.id }));
        break;
      case "forcedMove":
      case "note":
      case "reduceDamage":
        // shortcut: forced movement needs the grid in step 6, and a note is only for reading.
        // Reduced damage is worked out by the reaction that holds up the hit.
        break;
      default:
        effect satisfies never;
    }
  }
  return events;
}

// The saved flag, and the roll for the history. An automatic failure rolls no die, so it has no event.
export function rollSave(
  target: Actor,
  ability: Ability,
  dc: number,
  context: Context,
  magical = false,
  cover = 0, // half or three-quarters cover adds to Dexterity saves
  conditions: readonly string[] = [],
): { readonly saved: boolean; readonly events: SystemEvent[] } {
  if (
    (ability === "str" || ability === "dex") &&
    hasCondition(target, "paralyzed", "petrified", "stunned", "unconscious")
  ) {
    return { saved: false, events: [] };
  }
  const stats = deriveStats(target, context);
  const roll = rollD20(context.dice, {
    advantage:
      hasFlag(target, "advantage", "saves", stats) ||
      (magical && hasPassive(stats, "magicResistance")) ||
      (ability === "dex" && dodging(target)) ||
      traitSaveAdvantage(stats, ability, conditions),
    disadvantage:
      hasFlag(target, "disadvantage", "saves", stats) ||
      (ability === "dex" && hasCondition(target, "restrained")),
  });
  const total =
    roll.natural +
    saveBonus(stats, ability) +
    rollBonus(target, "saves", context) +
    (ability === "dex" ? cover : 0);
  const saved = total >= dc;
  return {
    saved,
    events: [
      dndEvent(`${NS}:saveRolled`, {
        actor: target.id,
        ability,
        natural: roll.natural,
        total,
        dc,
        success: saved,
      }),
    ],
  };
}

// Every creature in the fight an area could catch.
function areaPool(
  targeting: Targeting,
  context: ContentAccess & { readonly state: DndState },
): readonly Actor[] {
  return (context.state.combat?.order ?? []).flatMap((id) => {
    const item = context.state.actors[id];
    return item && !isDead(item) && fitsType(item, targeting, context)
      ? [item]
      : [];
  });
}

export function resolveTargets(
  answerTarget: string,
  action: KnownAction,
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): readonly Actor[] {
  const { state } = context;
  const { targeting } = action.activation;
  if ("self" in targeting) return [actor];
  const side = (
    targeting.side === "enemy" ? enemies(state, actor) : allies(state, actor)
  ).filter((item) => !isDead(item) && fitsType(item, targeting, context));
  if ("area" in targeting) {
    const { shape, radius } = targeting.area;
    // Aimed at a square ("@x,y") or a creature ("@id"), an area catches everyone in it, the caster's side too.
    const aimedAt = answerTarget.startsWith(AIM)
      ? answerTarget.slice(AIM.length)
      : null;
    const aim =
      aimedAt === null
        ? null
        : (parseSquare(aimedAt) ?? state.actors[aimedAt]?.position ?? null);
    if (aim && actor.position) {
      // Total cover from where it spreads keeps a creature out of it.
      const centre =
        shape === "sphere" || shape === "cube" ? aim : actor.position;
      return caughtBy(
        targeting,
        actor,
        aim,
        areaPool(targeting, context),
      ).filter(
        (item) =>
          item.id === actor.id ||
          coverFor(state, centre, item, [actor.id]) !== "total",
      );
    }
    // Round the caster, or with no grid: only the side it's meant for, as if placed with care.
    return side.filter((item) =>
      inArea(shape, radius, actor.position, actor.position, item.position),
    );
  }
  const chosen = answerTarget === ALL ? [] : [actorOf(state, answerTarget)];
  const pool = side.filter(
    (item) =>
      !chosen.includes(item) &&
      reaches(action, actor, item) &&
      !behindTotalCover(state, actor, item),
  );
  // A higher slot can add targets to a single-target spell, and they go to the weakest after the one chosen.
  return [...chosen, ...[...pool].sort((a, b) => a.hp - b.hp)].slice(
    0,
    targeting.creatures,
  );
}

// A cast keeps its slot level in the frames it leaves behind, so later steps roll the same dice.
function findAction(
  actor: Actor,
  id: string,
  context: Context,
  slotLevel?: number,
): KnownAction {
  const action =
    deriveStats(actor, context).actions.find((item) => item.id === id) ??
    bossAction(actor, id, context);
  if (!action) throw new Error(`${actor.id} has no action ${id}`);
  const above = (slotLevel ?? 0) - (action.spellLevel ?? 0);
  return action.upcast
    ? {
        ...action,
        activation: scaleActivation(
          action.activation,
          action.upcast.perSlotLevel,
          above,
        ),
      }
    : action;
}

function spellSource(action: KnownAction): string {
  return action.id;
}

// Extra Attack only applies to the Attack action with a weapon, while a monster follows its stat block.
function attackRoutine(
  action: KnownAction,
  actor: Actor,
  stats: Stats,
): readonly string[] {
  const { cost, resolution } = action.activation;
  if (
    !cost.includes("action") ||
    (actor.source.kind === "character" &&
      resolution.kind === "attack" &&
      resolution.attack.type === "spell")
  ) {
    return [action.id];
  }
  return (
    stats.routines?.[action.id] ??
    Array<string>(stats.multiattack).fill(action.id)
  );
}

export function resolveAction(
  action: KnownAction,
  actor: Actor,
  targets: readonly Actor[],
  context: Context,
  slotLevel?: number,
  critical = false,
): SystemResult {
  const { resolution } = action.activation;
  const stats = deriveStats(actor, context);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];

  const usesConcentration = (effects: readonly LeafEffect[]): boolean =>
    effects.some(
      (effect) =>
        (effect.kind === "modifier" || effect.kind === "applyCondition") &&
        typeof effect.duration === "object" &&
        "concentration" in effect.duration,
    );

  const beginConcentration = (effects: readonly LeafEffect[]): void => {
    if (!usesConcentration(effects)) return;
    if (actor.concentratingOn !== null) {
      events.push(dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }));
    }
    events.push(
      dndEvent(`${NS}:concentrationStarted`, {
        actor: actor.id,
        spell: spellSource(action),
      }),
    );
  };

  const applyRolled = (
    target: Actor,
    damage: readonly {
      readonly total: number;
      readonly type: Damage["type"];
    }[],
    scale: (amount: number) => number,
  ): void => {
    const result = dealEvents(
      target,
      damage.map(({ total, type }) => ({
        amount: finalDamage(
          scale(total),
          type,
          damageResponses(target, context),
        ),
        type,
      })),
      false,
      context,
    );
    events.push(...result.events);
    frames.push(...concentrationFrame(target, result.dealt));
  };

  const rollSharedDamage = (list: readonly Damage[]) =>
    list.map(({ amount, type }) => ({
      total: rollAmount(amount, stats, context.dice, critical ? 2 : 1),
      type,
    }));

  switch (resolution.kind) {
    case "automatic": {
      beginConcentration(resolution.effects);
      const damage = rollSharedDamage(resolution.damage);
      for (const target of targets) {
        applyRolled(target, damage, (amount) => amount);
        events.push(
          ...leafEvents(
            resolution.effects,
            spellSource(action),
            actor,
            target,
            context,
          ),
        );
      }
      break;
    }
    case "save": {
      beginConcentration(resolution.onFail);
      const dc = evaluateFormula(resolution.dc, stats);
      // Damage against several targets at once is rolled once for all of them.
      const damage = rollSharedDamage(resolution.damage);
      for (const target of targets) {
        // shortcut: cover counts from the caster, even for a sphere whose centre is elsewhere.
        const { saved: rolledSave, events: saveEvents } = rollSave(
          target,
          resolution.ability,
          dc,
          context,
          action.spellLevel !== null,
          coverBonus(
            coverFor(context.state, actor.position, target, [actor.id]),
          ),
          conditionsApplied(resolution.onFail),
        );
        events.push(...saveEvents);
        const resisted = rolledSave
          ? null
          : legendaryResistance(
              target,
              conditionsApplied(resolution.onFail),
              context,
              events,
            );
        if (resisted) events.push(resisted);
        const saved = rolledSave || resisted !== null;
        applyRolled(target, damage, (amount) => {
          if (!saved) return amount;
          return resolution.onSuccessDamage === "half" ? halved(amount) : 0;
        });
        events.push(
          ...leafEvents(
            saved ? resolution.onSuccess : resolution.onFail,
            spellSource(action),
            actor,
            target,
            context,
            { ability: resolution.ability, dc },
          ),
        );
      }
      break;
    }
    case "attack": {
      for (const target of targets) {
        for (const actionId of attackRoutine(action, actor, stats)) {
          frames.push(
            frame("attackRoll", {
              attacker: actor.id,
              actionId,
              target: target.id,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          );
        }
      }
      break;
    }
    default:
      resolution satisfies never;
  }
  return { events, frames };
}

const TakeActionSchema = z.object({ actor: z.string(), answer: z.string() });

export function runTakeAction(
  payload: z.infer<typeof TakeActionSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const actor = actorOf(state, payload.actor);

  if (payload.answer === DEATH_SAVE) {
    const natural = dice.roll(20);
    const events: SystemEvent[] = [
      dndEvent(`${NS}:deathSaveRolled`, { actor: actor.id, natural }),
    ];
    const failuresAfter =
      actor.deathSaves.failures + (natural < 10 ? (natural === 1 ? 2 : 1) : 0);
    if (natural !== 20 && failuresAfter >= 3) {
      events.push({ kind: "actorDefeated", actor: actor.id });
    }
    return {
      events,
      frames: [CHECK_END, frame("endTurn", {})],
    };
  }

  if (payload.answer === PASS) return { frames: [frame("endTurn", {})] };
  if (payload.answer === MOVE) {
    // Squares next to the nearest enemy come first, as the likeliest choice.
    const foes = enemies(state, actor).filter((item) => !isDown(item));
    const nearest = (square: Square): number =>
      Math.min(...foes.map((foe) => distanceFeet(square, foe.position)));
    const squares = [
      ...moveSquares(actor, state, deriveStats(actor, context)),
    ].sort((a, b) => nearest(a.square) - nearest(b.square) || a.feet - b.feet);
    return {
      frames: [
        awaitDecision({
          id: `${NS}:moveTo:${actor.id}:${String(actor.moved)}`,
          actor: actor.id,
          prompt: `Where does ${actor.name} move?`,
          options: [
            ...squares.map(({ square, feet }) => ({
              id: squareKey(square),
              label: `${squareName(square)} (${String(feet)} ft)`,
            })),
            { id: STAY, label: "Stay where you are" },
          ],
          resume: frame("move", { actor: actor.id }),
        }),
      ],
    };
  }
  if (payload.answer === FLEE) return runFlee(actor, context);

  const [actionId = "", targetId = "", slot] = payload.answer.split(SEPARATOR);
  if (targetId === PICK) {
    return { frames: [pickFrame(actor, actionId, slot, [], context)] };
  }
  if (targetId === AIM_AREA) {
    return { frames: [aimFrame(actor, actionId, slot, context)] };
  }
  return castAction(actor, actionId, slot, targetId, context);
}

// The slot a cast spends: the one chosen, or else the lowest that will do.
function slotLevelFor(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  context: Context,
): number | undefined {
  const known = findAction(actor, actionId, context);
  if (!known.activation.cost.includes("slot")) return undefined;
  return slot === undefined
    ? (slotToSpend(known, actor, deriveStats(actor, context)) ?? undefined)
    : Number(slot);
}

// Pays for an action and resolves it, at a target id (a creature, ALL, or an aim) or at chosen creatures.
// Darts and rays go one each at the chosen ids, which may repeat.
function castAction(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  target: string | readonly string[],
  context: Context,
): SystemResult {
  const { state } = context;
  const slotLevel = slotLevelFor(actor, actionId, slot, context);
  const action = findAction(actor, actionId, context, slotLevel);
  const picked = typeof target === "string" ? null : target;
  const targetId = typeof target === "string" ? target : ALL;
  const { projectiles, resolution } = action.activation;
  const result: SystemResult =
    projectiles !== undefined && resolution.kind !== "save"
      ? {
          frames: Array.from({ length: projectiles }, (_, index) =>
            frame(resolution.kind === "attack" ? "attackRoll" : "projectile", {
              attacker: actor.id,
              actionId,
              target: picked?.[index] ?? targetId,
              ...(slotLevel === undefined ? {} : { slotLevel }),
            }),
          ),
        }
      : resolveAction(
          action,
          actor,
          picked
            ? picked.map((id) => actorOf(state, id))
            : resolveTargets(targetId, action, actor, context),
          context,
          slotLevel,
        );
  return {
    events: [
      ...payCosts(action, actor, context, slotLevel),
      ...lightAttackEvents(actor, actionId, context),
      // An attack gives a hidden creature away once it's rolled, with the hiding's Advantage.
      ...(resolution.kind === "attack" ? [] : revealEvents(actor)),
      ...(result.events ?? []),
    ],
    frames: [
      ...(result.frames ?? []),
      // Used up once its darts or rolls are done, since they look the action up again.
      ...(actionId.startsWith(ITEM_PREFIX)
        ? [
            frame("useItem", {
              actor: actor.id,
              item: actionId.slice(ITEM_PREFIX.length),
            }),
          ]
        : []),
      CHECK_END,
      frame("afterAction", { actor: actor.id }),
    ],
  };
}

const PickSchema = z.object({
  actor: z.string(),
  actionId: z.string(),
  slot: z.string().optional(),
  picked: z.array(z.string()),
  answer: z.string(),
});

// Asks for the next target, one at a time like a move, so every choice is in the save. Nothing is paid until the cast.
function pickFrame(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  picked: readonly string[],
  context: Context,
): Frame {
  const { state } = context;
  const action = findAction(actor, actionId, context);
  const count = targetCount(
    action,
    slotLevelFor(actor, actionId, slot, context),
  );
  const repeats = action.activation.projectiles !== undefined;
  return awaitDecision({
    id: `${NS}:targets:${actor.id}:${String(state.combat?.round ?? 0)}${SEPARATOR}${actionId}${SEPARATOR}${String(count)}${SEPARATOR}${picked.join(",")}`,
    actor: actor.id,
    prompt: `${action.name}: choose ${repeats ? `where each of ${String(count)} goes` : `up to ${String(count)} targets`} (${String(picked.length)} of ${String(count)}).`,
    options: [
      ...pickOptions(
        action.name,
        inReach(action, actor, state, context),
        picked,
        count,
        repeats,
      ),
    ],
    resume: frame("pickTargets", {
      actor: actor.id,
      actionId,
      ...(slot === undefined ? {} : { slot }),
      picked,
    }),
  });
}

export function runPickTargets(
  payload: z.infer<typeof PickSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  const { actionId, slot, picked, answer } = payload;
  if (answer === BACK) return {};
  if (answer === CONFIRM) {
    return castAction(actor, actionId, slot, picked, context);
  }
  const id = answer.slice(1);
  const at = picked.lastIndexOf(id);
  const next = answer.startsWith(ADD)
    ? [...picked, id]
    : picked.filter((_, index) => index !== at);
  return { frames: [pickFrame(actor, actionId, slot, next, context)] };
}

const AimSchema = z.object({
  actor: z.string(),
  actionId: z.string(),
  slot: z.string().optional(),
  answer: z.string(),
});

// Asks where an area goes: any square in range, or a direction for one that starts at the caster.
// Each option names who it would catch, the caster's side too, best first.
function aimFrame(
  actor: Actor,
  actionId: string,
  slot: string | undefined,
  context: Context,
): Frame {
  const { state } = context;
  const action = findAction(actor, actionId, context);
  const { targeting } = action.activation;
  const byDirection = "range" in targeting && targeting.range === "self";
  return awaitDecision({
    id: `${NS}:aim:${actor.id}:${String(state.combat?.round ?? 0)}${SEPARATOR}${actionId}`,
    actor: actor.id,
    prompt: `Where does ${actor.name} aim ${action.name}?`,
    options: [
      ...aimsFor(action, actor, context).map(({ square, caught }) => ({
        id: squareKey(square),
        label: `${byDirection && actor.position ? directionName(actor.position, square) : squareName(square)}: ${describeCaught(actor, caught)}`,
      })),
      { id: BACK, label: "Choose something else" },
    ],
    resume: frame("aimArea", {
      actor: actor.id,
      actionId,
      ...(slot === undefined ? {} : { slot }),
    }),
  });
}

// Every square an area can be aimed at, with who it catches, the best for its caster first.
function aimsFor(
  action: KnownAction,
  actor: Actor,
  context: ContentAccess & { readonly state: DndState },
): readonly {
  readonly square: Square;
  readonly caught: readonly Actor[];
  readonly score: number;
}[] {
  const { targeting } = action.activation;
  const grid = context.state.combat?.grid;
  if (!("area" in targeting) || !grid || !actor.position) return [];
  const pool = areaPool(targeting, context);
  return aimSquares(targeting, actor.position, grid)
    .map((square) => {
      const caught = caughtBy(targeting, actor, square, pool);
      return { square, caught, score: aimScore(targeting, actor, caught) };
    })
    .sort((a, b) => b.score - a.score);
}

export function runAimArea(
  payload: z.infer<typeof AimSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === BACK) return {};
  const actor = actorOf(context.state, payload.actor);
  return castAction(
    actor,
    payload.actionId,
    payload.slot,
    `${AIM}${payload.answer}`,
    context,
  );
}

export { AimSchema, PickSchema };

export { TakeActionSchema };

const AttackSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  slotLevel: z.number().optional(),
  noModifier: z.boolean().optional(), // an off-hand or Cleave attack, whose damage leaves out the ability modifier
});

// Who a projectile or later attack actually goes for, given who is still standing.
function aimAt(
  id: string,
  attacker: Actor,
  state: DndState,
): Actor | undefined {
  const standing = enemies(state, attacker).filter((item) => !isDown(item));
  if (id === ALL) {
    const charmers = charmersOf(attacker);
    return standing
      .filter(
        (item) =>
          !charmers.has(item.id) && !behindTotalCover(state, attacker, item),
      )
      .sort((a, b) => a.hp - b.hp)[0];
  }
  const aimed = actorOf(state, id);
  return isDown(aimed) ? standing[0] : aimed;
}

// An automatic hit such as a Magic Missile dart: all of them land, one at a time against current HP.
export function runProjectile(
  payload: z.infer<typeof AttackSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = aimAt(payload.target, attacker, state);
  if (!target) return {};
  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  if (resolution.kind !== "automatic") {
    throw new Error(`${action.id} isn't an automatic hit`);
  }
  const stats = deriveStats(attacker, context);
  const responses = damageResponses(target, context);
  const { events, dealt } = dealEvents(
    target,
    resolution.damage.map(({ amount, type }) => ({
      amount: finalDamage(rollAmount(amount, stats, dice), type, responses),
      type,
    })),
    false,
    context,
  );
  return { events, frames: concentrationFrame(target, dealt) };
}

const MoveSchema = z.object({ actor: z.string(), answer: z.string() });

// The longest melee reach a creature has, or null if it has no melee attack.
export function meleeReachOf(
  actor: Actor,
  access: ContentAccess,
): number | null {
  const reaches = deriveStats(actor, access).actions.flatMap((action) => {
    const reach = meleeReach(action);
    return reach !== null &&
      action.activation.resolution.kind === "attack" &&
      !action.activation.trigger &&
      action.spellLevel === null
      ? [reach]
      : [];
  });
  return reaches.length > 0 ? Math.max(...reaches) : null;
}

// Enemies that get an Opportunity Attack if the actor moves to `to`, and the attack each would make.
// shortcut: only where the move starts and ends counts, not every square on the way.
export function provokers(
  actor: Actor,
  to: Square,
  state: DndState,
  access: ContentAccess,
): readonly { readonly foe: Actor; readonly melee: KnownAction }[] {
  if (hasTactic(actor, "disengage")) return [];
  return enemies(state, actor).flatMap((foe) => {
    if (
      !foe.budget.reaction ||
      isDown(foe) ||
      hasCondition(foe, ...INCAPACITATING)
    ) {
      return [];
    }
    const melee = deriveStats(foe, access).actions.find((item) => {
      const reach = meleeReach(item);
      return (
        reach !== null &&
        item.activation.resolution.kind === "attack" &&
        !item.activation.trigger &&
        item.spellLevel === null &&
        distanceFeet(actor.position, foe.position) <= reach &&
        distanceFeet(to, foe.position) > reach
      );
    });
    return melee ? [{ foe, melee }] : [];
  });
}

// Leaving an enemy's reach gives it an Opportunity Attack, made before the move, so falling stops it.
export function runMove(
  payload: z.infer<typeof MoveSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const actor = actorOf(state, payload.actor);
  const to = parseSquare(payload.answer);
  if (payload.answer === STAY || !to) return {};
  const step = moveSquares(actor, state, deriveStats(actor, context)).find(
    ({ square }) => squareKey(square) === payload.answer,
  );
  if (!step) throw new Error(`${actor.name} can't reach ${payload.answer}`);
  const events: SystemEvent[] = [];
  const frames: Frame[] = [];
  for (const { foe, melee } of provokers(actor, to, state, context)) {
    events.push(
      dndEvent(`${NS}:budgetSpent`, { actor: foe.id, kind: "reaction" }),
    );
    frames.push(
      frame("attackRoll", {
        attacker: foe.id,
        actionId: melee.id,
        target: actor.id,
      }),
    );
  }
  return {
    events,
    frames: [
      ...frames,
      frame("finishMove", {
        actor: actor.id,
        x: to.x,
        y: to.y,
        feet: step.feet,
      }),
      ...(actor.position
        ? [frame("afterMove", { actor: actor.id, ...actor.position })]
        : []),
      CHECK_END,
    ],
  };
}

const FinishMoveSchema = z.object({
  actor: z.string(),
  x: z.number(),
  y: z.number(),
  feet: z.number(),
});

export function runFinishMove(
  payload: z.infer<typeof FinishMoveSchema>,
  context: Context,
): SystemResult {
  const actor = context.state.actors[payload.actor];
  if (!context.state.combat || !actor || isDown(actor) || isDead(actor)) {
    return {};
  }
  return {
    events: [
      dndEvent(`${NS}:moved`, {
        actor: actor.id,
        to: { x: payload.x, y: payload.y },
        feet: payload.feet,
      }),
    ],
  };
}

export { FinishMoveSchema, MoveSchema };

function isMelee(action: KnownAction): boolean {
  const { targeting } = action.activation;
  return (
    "creatures" in targeting &&
    (targeting.range === "touch" ||
      (typeof targeting.range === "number" && targeting.range <= 5))
  );
}

// Reports whether a reaction could still change the result of this attack.
function reactionFor(
  target: Actor,
  total: number,
  ac: number,
  context: Context,
  critical: boolean,
): KnownAction | null {
  if (
    !target.budget.reaction ||
    isDown(target) ||
    hasCondition(target, ...INCAPACITATING)
  ) {
    return null;
  }
  const stats = deriveStats(target, context);
  return (
    stats.actions.find((action) => {
      const { activation } = action;
      if (!activation.trigger?.hitByAttack || !canAfford(action, target, stats))
        return false;
      const { resolution } = activation;
      if (resolution.kind !== "automatic") return false;
      if (resolution.effects.some((effect) => effect.kind === "reduceDamage")) {
        return true;
      }
      if (critical) return false;
      const acBonus = resolution.effects.reduce((sum, effect) => {
        return effect.kind === "modifier" &&
          effect.modifier.kind === "bonus" &&
          effect.modifier.to === "ac"
          ? sum + (effect.modifier.amount.bonus?.base ?? 0)
          : sum;
      }, 0);
      return total < ac + acBonus;
    }) ?? null
  );
}

export function runAttackRoll(
  payload: z.infer<typeof AttackSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  // A hit can end the fight with more attacks still queued, and the monsters are gone by then.
  if (!state.combat) return {};
  const attacker = actorOf(state, payload.attacker);
  if (isDead(attacker) || isDown(attacker)) return {};

  // A later attack in a multiattack moves on if its first target has already fallen.
  const target = aimAt(payload.target, attacker, state);
  if (!target) return {};

  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  const stats = deriveStats(attacker, context);
  const targetStats = deriveStats(target, context);
  const packed =
    hasPassive(stats, "packTactics") &&
    allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id &&
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, target),
    );
  const close = within5(attacker, target);
  // A ranged attack is harder with an enemy standing next to the attacker.
  const crowded =
    meleeReach(action) === null &&
    enemies(state, attacker).some(
      (item) =>
        !isDown(item) &&
        !hasCondition(item, ...INCAPACITATING) &&
        within5(item, attacker),
    );
  const proneFar = hasCondition(target, "prone") && !close;
  // Darkness hides a creature from anyone without Darkvision in range: attacking an unseen target has
  // Disadvantage, and a target that can't see its attacker gives Advantage.
  const unseenTarget =
    seeing(attacker, target.position, state, context) === "none";
  const unseenAttacker =
    seeing(target, attacker.position, state, context) === "none";
  const advantage =
    packed ||
    unseenAttacker ||
    hasFlag(attacker, "advantage", "attacks", stats) ||
    hasFlag(target, "advantage", "attacksAgainst", targetStats) ||
    hasCondition(attacker, "invisible") ||
    hasCondition(
      target,
      "blinded",
      "paralyzed",
      "petrified",
      "restrained",
      "stunned",
      "unconscious",
    ) ||
    (hasCondition(target, "prone") && close);
  const disadvantage =
    crowded ||
    unseenTarget ||
    proneFar ||
    dodging(target) ||
    grappledAwayFrom(attacker, target) ||
    hasFlag(attacker, "disadvantage", "attacks", stats) ||
    hasFlag(target, "disadvantage", "attacksAgainst", targetStats) ||
    hasCondition(
      attacker,
      "blinded",
      "frightened",
      "poisoned",
      "prone",
      "restrained",
    ) ||
    hasCondition(target, "invisible");
  const roll = rollD20(dice, { advantage, disadvantage });
  const hadAdvantage = advantage && !disadvantage;
  const total =
    roll.natural +
    attackBonus(resolution, stats) +
    rollBonus(attacker, "attacks", context);
  const ac =
    targetStats.ac +
    coverBonus(coverFor(state, attacker.position, target, [attacker.id]));
  const critFrom = criticalFrom(stats);
  const hits = roll.natural >= critFrom || (roll.natural !== 1 && total >= ac);
  // A hit from within 5 feet on a Paralyzed or Unconscious target is a Critical Hit.
  const critical =
    roll.natural >= critFrom ||
    (hits &&
      isMelee(action) &&
      hasCondition(target, "paralyzed", "unconscious"));

  const report = dndEvent(`${NS}:rollReported`, {
    actor: attacker.id,
    against: target.id,
    natural: roll.natural,
    total,
    target: ac,
    success: hits,
    label: action.name,
  });
  // An effect like Guiding Bolt's lasts only until the next attack roll it applies to.
  const spent = [
    ...onceEnded(attacker, "attacks"),
    ...onceEnded(target, "attacksAgainst"),
    ...revealEvents(attacker),
  ];
  const hit = {
    attacker: attacker.id,
    actionId: action.id,
    target: target.id,
    critical,
    hadAdvantage,
    total,
    natural: roll.natural,
    ...(payload.slotLevel === undefined
      ? {}
      : { slotLevel: payload.slotLevel }),
    ...(payload.noModifier ? { noModifier: true } : {}),
  };

  if (!hits) {
    return (
      offerInspiration(attacker, { ...payload, target: target.id }, report) ?? {
        events: [report, ...spent],
        ...(masteryOf(attacker, action.id, context)
          ? { frames: [frame("masteryMiss", hit)] }
          : {}),
      }
    );
  }

  const reaction = reactionFor(target, total, ac, context, critical);
  if (reaction) {
    return {
      events: [report, ...spent],
      frames: [
        awaitDecision({
          id: `${NS}:reaction:${target.id}`,
          actor: target.id,
          prompt: `${attacker.name} hits ${target.name} with ${action.name}. React?`,
          options: [
            { id: reaction.id, label: reaction.name },
            { id: DECLINE, label: "Take the hit" },
          ],
          resume: frame("afterReaction", hit),
        }),
      ],
    };
  }
  return { events: [report, ...spent], frames: [frame("applyHit", hit)] };
}

export { AttackSchema };

const HitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
  hadAdvantage: z.boolean(),
  total: z.number(),
  natural: z.number(),
  slotLevel: z.number().optional(),
  halve: z.boolean().optional(), // set by a reaction like Uncanny Dodge
  reduceBy: z.number().optional(), // set by a reaction like Deflect Attacks
  noModifier: z.boolean().optional(),
});

const ReactionSchema = HitSchema.extend({ answer: z.string() });

export function runAfterReaction(
  payload: z.infer<typeof ReactionSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const { answer, ...hit } = payload;
  if (answer === DECLINE) return { frames: [frame("applyHit", hit)] };

  const target = actorOf(state, payload.target);
  const action = findAction(target, answer, context);
  const result = resolveAction(action, target, [target], context);
  const { resolution } = action.activation;
  const stats = deriveStats(target, context);
  const lessened = (
    resolution.kind === "automatic" ? resolution.effects : []
  ).flatMap((effect) => (effect.kind === "reduceDamage" ? [effect] : []));
  const reduceBy = lessened.reduce(
    (sum, effect) =>
      sum +
      (effect.amount ? rollAmount(effect.amount, stats, context.dice) : 0),
    0,
  );
  // The rest of the attack is held here and rechecked once the reaction has taken effect.
  return {
    events: [...payCosts(action, target, context), ...(result.events ?? [])],
    frames: [
      ...(result.frames ?? []),
      frame("recheckHit", {
        ...hit,
        ...(lessened.some((effect) => effect.halve) ? { halve: true } : {}),
        ...(reduceBy > 0 ? { reduceBy } : {}),
      }),
    ],
  };
}

export { ReactionSchema, HitSchema };

export function runRecheckHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const target = actorOf(state, payload.target);
  const ac =
    deriveStats(target, context).ac +
    coverBonus(
      coverFor(state, actorOf(state, payload.attacker).position, target, [
        payload.attacker,
      ]),
    );
  return payload.critical || payload.total >= ac
    ? { frames: [frame("applyHit", payload)] }
    : {};
}

export function runApplyHit(
  payload: z.infer<typeof HitSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const action = findAction(
    attacker,
    payload.actionId,
    context,
    payload.slotLevel,
  );
  const { resolution } = action.activation;
  if (resolution.kind !== "attack") {
    throw new Error(`${action.id} isn't an attack`);
  }
  const stats = deriveStats(attacker, context);
  const multiplier = payload.critical ? 2 : 1;
  const responses = damageResponses(target, context);

  const events: SystemEvent[] = [];
  let totalDealt = 0;
  const firstType = resolution.damage[0]?.type;

  // Add dice-based extra damage such as Sneak Attack to the first damage roll.
  let extra = 0;
  stats.passives.forEach((passive, index) => {
    if (passive.kind !== "extraDamage") return;
    const key = `extra:${String(index)}`;
    if (passive.oncePerTurn && attacker.usedThisTurn.includes(key)) return;
    const allyPresent = allies(state, attacker).some(
      (item) =>
        item.id !== attacker.id && !isDown(item) && within5(item, target),
    );
    const applies =
      passive.when === "advantage"
        ? payload.hadAdvantage
        : payload.hadAdvantage || allyPresent;
    if (!applies) return;
    extra += rollDiceNotation(passive.dice, dice, multiplier);
    if (passive.oncePerTurn) {
      events.push(
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: attacker.id, key }),
      );
    }
  });

  resolution.damage.forEach(({ amount, type }, index) => {
    const rolled =
      rollAmount(amount, stats, dice, multiplier) +
      (index === 0 && type === firstType
        ? extra + damageBonus(attacker, resolution, stats, context)
        : 0) -
      (index === 0 && payload.noModifier && resolution.attack.ability
        ? Math.max(0, modifierFor(stats, resolution.attack.ability))
        : 0);
    const final = finalDamage(Math.max(0, rolled), type, responses);
    totalDealt += final;
  });

  const hits = [
    ...(firstType ? [{ amount: totalDealt, type: firstType }] : []),
    ...hitRiders(attacker, target, resolution).map(({ amount, type }) => ({
      amount: finalDamage(
        rollAmount(amount, stats, dice, multiplier),
        type,
        responses,
      ),
      type,
    })),
  ];
  const dealt = dealEvents(
    target,
    lessenHits(hits, payload),
    payload.critical,
    context,
  );
  events.push(
    ...dealt.events,
    ...leafEvents(resolution.onHit, action.id, attacker, target, context),
  );
  return {
    events,
    frames: [
      ...concentrationFrame(target, dealt.dealt),
      ...(smitesFor(action, attacker, stats).length > 0
        ? [
            frame("afterHit", {
              attacker: attacker.id,
              actionId: action.id,
              target: target.id,
              critical: payload.critical,
            }),
          ]
        : []),
      ...(masteryOf(attacker, action.id, context)
        ? [frame("masteryHit", { ...payload, dealt: dealt.dealt })]
        : []),
      CHECK_END,
    ],
  };
}

// shortcut: a reaction lessens the damage after Resistance rather than before it, which only matters to rounding.
function lessenHits<T extends { readonly amount: number }>(
  hits: readonly T[],
  { halve, reduceBy = 0 }: z.infer<typeof HitSchema>,
): T[] {
  let left = reduceBy;
  return hits.map((item) => {
    const amount = halve ? halved(item.amount) : item.amount;
    const after = Math.max(0, amount - left);
    left -= amount - after;
    return { ...item, amount: after };
  });
}

// Extra damage riders: Divine Favor sits on the attacker, while Hex and Hunter's Mark sit on the target.
function hitRiders(
  attacker: Actor,
  target: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
): readonly Damage[] {
  const seen = new Set<string>();
  const carried = [
    ...attacker.activeEffects.map((effect) => ({ effect, by: "bearer" })),
    ...target.activeEffects.map((effect) => ({ effect, by: "caster" })),
  ];
  return carried.flatMap(({ effect, by }) => {
    const { modifier, sourceId, casterId } = effect;
    if (
      modifier.kind !== "hitDamage" ||
      modifier.dealtBy !== by ||
      (by === "caster" && casterId !== attacker.id) ||
      (modifier.weaponOnly && resolution.attack.type !== "weapon") ||
      seen.has(sourceId)
    ) {
      return [];
    }
    seen.add(sourceId);
    return [modifier.damage];
  });
}

// Flat damage added to a weapon's own roll, such as Rage.
function damageBonus(
  attacker: Actor,
  resolution: Extract<Resolution, { kind: "attack" }>,
  stats: Stats,
  context: Context,
): number {
  if (resolution.attack.type !== "weapon") return 0;
  const seen = new Set<string>();
  return [
    ...attacker.activeEffects.flatMap(({ modifier, sourceId }) => {
      if (seen.has(sourceId)) return [];
      if (modifier.kind === "damageBonus") seen.add(sourceId);
      return [modifier];
    }),
    ...passiveModifiers(stats.passives),
  ].reduce(
    (total, modifier) =>
      modifier.kind === "damageBonus" &&
      (!modifier.ability || modifier.ability === resolution.attack.ability)
        ? total + rollAmount(modifier.amount, stats, context.dice)
        : total,
    0,
  );
}

function smitesFor(
  hitWith: KnownAction,
  attacker: Actor,
  stats: Stats,
): readonly KnownAction[] {
  const { resolution } = hitWith.activation;
  if (resolution.kind !== "attack" || resolution.attack.type !== "weapon") {
    return [];
  }
  return stats.actions.filter((action) => {
    const { trigger } = action.activation;
    return (
      trigger?.afterHit !== undefined &&
      canAfford(action, attacker, stats) &&
      (trigger.afterHit === "weapon" || isMelee(hitWith))
    );
  });
}

const AfterHitSchema = z.object({
  attacker: z.string(),
  actionId: z.string(),
  target: z.string(),
  critical: z.boolean(),
});

export function runAfterHit(
  payload: z.infer<typeof AfterHitSchema>,
  context: Context,
): SystemResult {
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const stats = deriveStats(attacker, context);
  const hitWith = findAction(attacker, payload.actionId, context);
  const options = smitesFor(hitWith, attacker, stats).flatMap((action) =>
    withUpcasts(action, attacker, stats, target.id, action.name),
  );
  if (isDown(target) || isDown(attacker) || options.length === 0) return {};
  return {
    frames: [
      awaitDecision({
        id: `${NS}:afterHit:${attacker.id}`,
        actor: attacker.id,
        prompt: `${attacker.name} hits ${target.name}. Add a spell to the hit?`,
        options: [...options, { id: DECLINE, label: "Not this time" }],
        resume: frame("smite", payload),
      }),
    ],
  };
}

const SmiteSchema = AfterHitSchema.extend({ answer: z.string() });

export function runSmite(
  payload: z.infer<typeof SmiteSchema>,
  context: Context,
): SystemResult {
  if (payload.answer === DECLINE) return {};
  const { state } = context;
  const attacker = actorOf(state, payload.attacker);
  const target = actorOf(state, payload.target);
  const [actionId = "", , slot] = payload.answer.split(SEPARATOR);
  const known = findAction(attacker, actionId, context);
  const slotLevel =
    slot === undefined
      ? (slotToSpend(known, attacker, deriveStats(attacker, context)) ??
        undefined)
      : Number(slot);
  const action = findAction(attacker, actionId, context, slotLevel);
  // A smite's damage is part of the attack, so a Critical Hit doubles its dice too.
  const result = resolveAction(
    action,
    attacker,
    [target],
    context,
    slotLevel,
    payload.critical,
  );
  return {
    events: [
      ...payCosts(action, attacker, context, slotLevel),
      ...(result.events ?? []),
    ],
    frames: [...(result.frames ?? [])],
  };
}

export { AfterHitSchema, SmiteSchema };

const ConcentrationSchema = z.object({ actor: z.string(), dc: z.number() });

export function runConcentrationSave(
  payload: z.infer<typeof ConcentrationSchema>,
  context: Context,
): SystemResult {
  const actor = actorOf(context.state, payload.actor);
  if (actor.concentratingOn === null) return {};
  // Being down ends Concentration outright, as does any failed save.
  const save = isDown(actor)
    ? null
    : rollSave(actor, "con", payload.dc, context);
  const rolled = save?.events ?? [];
  if (!save?.saved) {
    return {
      events: [
        ...rolled,
        dndEvent(`${NS}:concentrationEnded`, { actor: actor.id }),
      ],
    };
  }
  return { events: rolled };
}

export { ConcentrationSchema };

export function combatEnded(
  state: DndState,
  outcome?: "defeat" | "flee",
): SystemEvent[] {
  return [
    {
      kind: "encounterEnded",
      encounter: state.combat?.encounter ?? "",
      ...(outcome ? { outcome } : {}),
    },
    dndEvent(`${NS}:combatEnded`, {}),
  ];
}

export function runCheckCombatEnd(context: Context): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const fighters = state.combat.order.map((id) => actorOf(state, id));
  const enemyStanding = fighters.some(
    (actor) => actor.side === "enemy" && !isDown(actor),
  );
  const partyStanding = fighters.some(
    (actor) => actor.side === "party" && !isDown(actor),
  );
  // The story follows the player's character, so their death ends the run even if companions win.
  const playerDead = isDead(actorOf(state, PLAYER_ACTOR));
  if (playerDead || (!partyStanding && enemyStanding)) {
    // shortcut: a party with nobody standing is defeated, even if someone could still recover.
    return !playerDead && state.combat.defeatContinues
      ? { events: combatEnded(state, "defeat") }
      : { events: [{ kind: "partyDefeated" }] };
  }
  if (!enemyStanding) {
    const { loot } = state.combat;
    const found = loot ? treasure(loot, context) : {};
    return {
      events: [...combatEnded(state), ...(found.events ?? [])],
      ...(found.frames ? { frames: found.frames } : {}),
    };
  }
  return {};
}

export function runAfterAction(
  payload: { readonly actor: string },
  context: Context,
): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const actor = actorOf(state, payload.actor);
  const stats = deriveStats(actor, context);
  // The turn carries on only while something other than ending it is still possible.
  const canContinue = stats.actions.some(
    (action) => !action.activation.trigger && canAfford(action, actor, stats),
  );
  return canContinue &&
    !isDown(actor) &&
    !hasCondition(actor, ...INCAPACITATING)
    ? {}
    : endOfTurn(context);
}

function currentActor(state: DndState): Actor | undefined {
  const actorId = state.combat?.order[state.combat.index];
  return actorId === undefined ? undefined : state.actors[actorId];
}

// One frame per source, as the same spell from two casters doesn't stack and a creature saves only once a turn.
// shortcut: with no map, everyone a zone was cast on stays in it until the effect ends.
function lingeringFrames(actor: Actor, when: "turnStart" | "turnEnd"): Frame[] {
  const seen = new Set<string>();
  return actor.activeEffects.flatMap(({ modifier, sourceId }) => {
    if (
      modifier.kind !== "lingeringDamage" ||
      modifier.when !== when ||
      seen.has(sourceId)
    ) {
      return [];
    }
    seen.add(sourceId);
    return [frame("lingeringTick", { actor: actor.id, sourceId, when })];
  });
}

const LingeringSchema = z.object({
  actor: z.string(),
  sourceId: z.string(),
  when: z.enum(["turnStart", "turnEnd"]),
});

export function runLingeringTick(
  payload: z.infer<typeof LingeringSchema>,
  context: Context,
): SystemResult {
  const { state, dice } = context;
  // The fight may have ended, removing the monsters, with this tick still queued.
  const target = state.actors[payload.actor];
  if (!target) return {};
  const effect = target.activeEffects.find(
    ({ modifier, sourceId }) =>
      sourceId === payload.sourceId &&
      modifier.kind === "lingeringDamage" &&
      modifier.when === payload.when,
  );
  if (effect?.modifier.kind !== "lingeringDamage" || isDead(target)) return {};
  const { damage, save, once } = effect.modifier;
  const stats = deriveStats(state.actors[effect.casterId] ?? target, context);
  const { saved, events: rolled } = save
    ? rollSave(
        target,
        save.ability,
        evaluateFormula(save.dc, stats),
        context,
        effect.sourceId.startsWith("spell:"),
      )
    : { saved: false, events: [] };
  const scale = (amount: number): number => {
    if (!saved || save?.onSuccess === "full") return amount;
    return save?.onSuccess === "half" ? halved(amount) : 0;
  };
  const responses = damageResponses(target, context);
  const { events, dealt } = dealEvents(
    target,
    damage.map(({ amount, type }) => ({
      amount: finalDamage(
        scale(rollAmount(amount, stats, dice)),
        type,
        responses,
      ),
      type,
    })),
    false,
    context,
  );
  events.unshift(...rolled);
  if (once || (saved && save?.endsEffect)) {
    events.push(
      dndEvent(`${NS}:effectEnded`, {
        actor: target.id,
        sourceId: effect.sourceId,
      }),
    );
  }
  return { events, frames: [...concentrationFrame(target, dealt), CHECK_END] };
}

export { LingeringSchema };

// A monster killed by something at the start of its own turn has no turn to take.
export function runAfterTurnStart(context: Context): SystemResult {
  const actor = currentActor(context.state);
  return actor && isDead(actor) ? endOfTurn(context) : {};
}

function endOfTurn(context: Context): SystemResult {
  const actor = currentActor(context.state);
  const ticks =
    actor && !isDead(actor) ? lingeringFrames(actor, "turnEnd") : [];
  return ticks.length > 0
    ? { frames: [...ticks, frame("finishTurn", {})] }
    : runFinishTurn(context);
}

// A target repeats its save at the end of each of its turns, ending that spell's effects on itself on a success.
export function runFinishTurn(context: Context): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const actor = currentActor(state);
  const repeated = (actor?.activeEffects ?? []).flatMap((effect) =>
    actor && effect.repeatSave && !isDown(actor)
      ? [{ actor, effect, save: effect.repeatSave }]
      : [],
  );
  const seen = new Set<string>();
  const events: SystemEvent[] = [];
  for (const { actor: target, effect, save } of repeated) {
    const { sourceId, modifier } = effect;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const rolled = rollSave(
      target,
      save.ability,
      save.dc,
      context,
      sourceId.startsWith("spell:"),
    );
    events.push(...rolled.events);
    const resisted = rolled.saved
      ? null
      : legendaryResistance(
          target,
          modifier.kind === "condition" ? [modifier.condition] : [],
          context,
          events,
        );
    if (resisted) events.push(resisted);
    if (rolled.saved || resisted) {
      events.push(
        dndEvent(`${NS}:effectEnded`, { actor: target.id, sourceId }),
      );
    }
  }
  const ending = [...events, ...(actor ? rechargeEvents(actor, context) : [])];
  const between = betweenTurns(state, ending, context);
  return between.length > 0
    ? { events: ending, frames: [...between, frame("advanceTurn", {})] }
    : runAdvanceTurn(context, ending);
}

// The next turn begins, with its start-of-turn effects.
export function runAdvanceTurn(
  context: Context,
  ending: readonly SystemEvent[] = [],
): SystemResult {
  const { state } = context;
  if (!state.combat) return {};
  const finished = [...ending, dndEvent(`${NS}:turnAdvanced`, {})];
  // Look ahead through the same events, so nothing happens at all unless the next creature has a start-of-turn effect.
  let after = state;
  for (const event of finished) after = applyDndEvent(after, event);
  const next = currentActor(after);
  const events = [
    ...finished,
    ...(next ? regenerationEvents(next, context) : []),
  ];
  const ticks = next ? lingeringFrames(next, "turnStart") : [];
  return ticks.length > 0
    ? { events, frames: [...ticks, frame("afterTurnStart", {})] }
    : { events };
}

// shortcut: Regeneration isn't stopped by the damage types that should stop it, as no damage type taken is kept yet.
function regenerationEvents(actor: Actor, context: Context): SystemEvent[] {
  if (isDown(actor)) return [];
  const stats = deriveStats(actor, context);
  const hp = stats.passives.reduce(
    (sum, passive) => sum + (passive.kind === "regeneration" ? passive.hp : 0),
    0,
  );
  const amount = Math.min(hp, stats.maxHp - actor.hp);
  return amount > 0
    ? [dndEvent(`${NS}:healed`, { actor: actor.id, amount, max: stats.maxHp })]
    : [];
}

// shortcut: the roll happens at the end of the monster's turn rather than the start of its next one,
// which gives the same chance, as nothing else can change it in between.
function rechargeEvents(actor: Actor, context: Context): SystemEvent[] {
  if (actor.source.kind !== "monster") return turnRecharge(actor, context);
  const monster = lookup(context, MonsterSchema, actor.source.statBlockId);
  return monster.actions.flatMap((action) => {
    if (action.recharge === undefined) return [];
    const cost = action.activation.cost.find(
      (item) => typeof item === "object",
    );
    if (typeof cost !== "object") return [];
    return (actor.resourcesSpent[cost.resource] ?? 0) > 0 &&
      context.dice.roll(6) >= action.recharge
      ? [
          dndEvent(`${NS}:resourceRestored`, {
            actor: actor.id,
            resource: cost.resource,
          }),
        ]
      : [];
  });
}

export function runEndTurn(context: Context): SystemResult {
  return context.state.combat ? endOfTurn(context) : {};
}

// Companions spend hit dice until healed. The player chooses die by die, in rest.ts.
export function shortRestEvents(
  context: Context,
  skip?: string,
): SystemEvent[] {
  return Object.values(context.state.actors).flatMap((actor) => {
    if (actor.side !== "party" || isDead(actor) || actor.id === skip) return [];
    if (actor.source.kind !== "character" || !actor.source.build) return [];
    const stats = deriveStats(actor, context);
    const events: SystemEvent[] = [];
    let { hp } = actor;
    for (const { classId } of actor.source.build.levels.slice(
      actor.resourcesSpent[HIT_DICE] ?? 0,
    )) {
      if (hp >= stats.maxHp) break;
      const die = lookup(context, ClassSchema, classId).hitDie;
      const rolled = rollDiceNotation(`1${die}`, context.dice);
      const amount = Math.min(
        Math.max(1, rolled + modifierFor(stats, "con")),
        stats.maxHp - hp,
      );
      hp += amount;
      events.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: HIT_DICE,
        }),
        dndEvent(`${NS}:healed`, { actor: actor.id, amount, max: stats.maxHp }),
      );
    }
    return events;
  });
}

function hpFraction(actor: Actor, context: Context): number {
  return actor.hp / deriveStats(actor, context).maxHp;
}

// Simple, predictable tactics, so non-player characters never need a model: heal, attack the weakest, react when it helps.
// Where a creature should step to: within reach of the nearest foe it can hurt, by the shortest walk.
// Null when no square gets it any closer than it is.
export function stepToward(actor: Actor, context: Context): Square | null {
  const { state } = context;
  const stats = deriveStats(actor, context);
  if (!actor.position) return null;
  const offensive = stats.actions.filter(
    (action) =>
      !action.activation.trigger &&
      "side" in action.activation.targeting &&
      action.activation.targeting.side === "enemy" &&
      canAfford(action, actor, stats),
  );
  if (offensive.length === 0) return null;
  const reach = Math.max(
    ...offensive.map((action) => {
      const { targeting } = action.activation;
      return "area" in targeting && targeting.range === "self"
        ? targeting.area.radius
        : "range" in targeting
          ? rangeFeet(targeting.range)
          : 0;
    }),
  );
  const foes = enemies(state, actor).filter(
    (item) => !isDown(item) && item.position,
  );
  // How far it is to walk from a square to a foe, round walls and through difficult terrain, ignoring
  // creatures. On a map with no walls that's the straight distance.
  const { grid, walls = [] } = state.combat ?? {};
  const walkFrom = new Map<string, ReadonlyMap<string, number>>();
  const walk = (from: Square | null, foe: Actor): number => {
    if (!grid || walls.length === 0 || !from || !foe.position) {
      return distanceFeet(from, foe.position);
    }
    let field = walkFrom.get(foe.id);
    if (!field) {
      field = new Map(
        reachableSquares(
          foe.position,
          Infinity,
          grid,
          new Set(walls),
          new Set(),
          difficultSquares(state),
        ).map((item) => [squareKey(item.square), item.feet]),
      );
      walkFrom.set(foe.id, field);
    }
    return field.get(squareKey(from)) ?? Infinity;
  };
  // In reach with a clear line is 0. Out of range, it's the walk still to go. A foe in range but behind
  // total cover counts the whole walk, so the creature goes round the wall until it has a line.
  const gap = (from: Square | null): number =>
    Math.min(
      ...foes.map((foe) => {
        const distance = distanceFeet(from, foe.position);
        if (distance > reach) return Math.max(0, walk(from, foe) - reach);
        return coverFor(state, from, foe, [actor.id]) === "total"
          ? walk(from, foe)
          : 0;
      }),
    );
  if (foes.length === 0) return null;
  const now = gap(actor.position);
  const gaps = new Map(
    moveSquares(actor, state, stats).map((item) => [item, gap(item.square)]),
  );
  const squares = [...gaps.keys()];
  const closest = Math.min(...gaps.values());
  if (squares.length === 0 || closest >= now) return null;
  // Of the squares that get it closest, the one off difficult terrain and nearest. One that fights from range
  // also wants the most cover from its foes; a melee creature is going up to them anyway.
  const difficult = difficultSquares(state);
  const ranged = reach > 10;
  const ranked = squares
    .filter((item) => gaps.get(item) === closest)
    .map((item) => ({
      ...item,
      cover: ranged
        ? foes.reduce(
            (sum, foe) =>
              sum +
              coverBonus(
                coverFor(
                  state,
                  foe.position,
                  { ...actor, position: item.square },
                  [foe.id],
                ),
              ),
            0,
          )
        : 0,
      rough: Number(difficult.has(squareKey(item.square))),
    }))
    .sort((a, b) => b.cover - a.cover || a.rough - b.rough || a.feet - b.feet);
  return ranked[0]?.square ?? null;
}

// Picks targets one at a time as a sensible caster would, then casts.
function pickPolicy(
  decision: Decision,
  actor: Actor,
  context: Context,
): string {
  const { actionId, slot, picked } = PickSchema.omit({ answer: true }).parse(
    decision.resume.payload,
  );
  const slotLevel = slotLevelFor(actor, actionId, slot, context);
  const action = findAction(actor, actionId, context, slotLevel);
  const { projectiles, resolution } = action.activation;
  const stats = deriveStats(actor, context);
  // Average dice, for how many darts a creature takes to drop.
  const average = { below: () => 0, roll: (sides: number) => (sides + 1) / 2 };
  const perHit =
    "damage" in resolution
      ? resolution.damage.reduce(
          (total, { amount }) => total + rollAmount(amount, stats, average),
          0,
        )
      : 0;
  const next = nextPick(
    inReach(action, actor, context.state, context),
    picked,
    targetCount(findAction(actor, actionId, context), slotLevel),
    projectiles !== undefined,
    { sourceId: spellSource(action), perHit },
  );
  if (next !== null) return `${ADD}${next}`;
  return decision.options.some((option) => option.id === CONFIRM)
    ? CONFIRM
    : BACK;
}

export function choosePolicy(decision: Decision, context: Context): string {
  const { state } = context;
  const [first] = decision.options;
  if (!first) throw new Error(`${decision.id} has no options`);
  if (decision.id.startsWith(`${NS}:reaction:`)) return first.id;
  if (decision.id.startsWith(`${NS}:inspiration:`)) return first.id;
  if (decision.id.startsWith(`${NS}:deathSave:`)) return first.id;
  if (/^dnd5\.5e:(legendary|lair):/.test(decision.id)) {
    return chooseBossAction(decision, context);
  }

  const actor = actorOf(state, decision.actor);
  if (decision.id.startsWith(`${NS}:moveTo:`)) {
    const square = stepToward(actor, context);
    return square ? squareKey(square) : STAY;
  }
  if (decision.id.startsWith(`${NS}:targets:`)) {
    return pickPolicy(decision, actor, context);
  }
  if (decision.id.startsWith(`${NS}:aim:`)) {
    const { actionId } = AimSchema.omit({ answer: true }).parse(
      decision.resume.payload,
    );
    const [best] = aimsFor(
      findAction(actor, actionId, context),
      actor,
      context,
    );
    return best && best.score > 0 ? squareKey(best.square) : BACK;
  }
  const stats = deriveStats(actor, context);
  // Only the player is offered flight. Run when the enemies left clearly outlast the party.
  if (decision.options.some((option) => option.id === FLEE)) {
    const standing = (list: readonly Actor[]): number =>
      list
        .filter((item) => !isDown(item))
        .reduce((sum, item) => sum + item.hp, 0);
    if (standing(enemies(state, actor)) > 3 * standing(allies(state, actor))) {
      return FLEE;
    }
  }
  // An area is only aimed where it catches more foes than it costs friends.
  const bestAim = new Map<string, number>();
  const worthOf = (action: KnownAction): number => {
    const known = bestAim.get(action.id);
    if (known !== undefined) return known;
    const score = aimsFor(action, actor, context)[0]?.score ?? 0;
    bestAim.set(action.id, score);
    return score;
  };
  const parsed = decision.options.flatMap((option) => {
    const [actionId = "", targetId = "", slot] = option.id.split(SEPARATOR);
    const action = stats.actions.find((item) => item.id === actionId);
    const target = state.actors[targetId];
    const worth = action && targetId === AIM_AREA ? worthOf(action) : null;
    return action && (worth === null || worth > 0)
      ? [{ option, action, target, targetId, slot, worth }]
      : [];
  });

  const heals = (action: KnownAction): boolean =>
    action.activation.resolution.kind === "automatic" &&
    action.activation.resolution.effects.some((item) => item.kind === "heal");

  // Slots go on fights that need them: the enemies left must outlast the caster's own HP, and a healer keeps its last slot.
  const foesHp = enemies(state, actor)
    .filter((item) => !isDown(item))
    .reduce((total, item) => total + item.hp, 0);
  const slotsLeft = stats.slots.reduce(
    (total, count, index) =>
      total +
      Math.max(
        0,
        count - (actor.resourcesSpent[`slot:${String(index + 1)}`] ?? 0),
      ),
    0,
  );
  const healer = stats.actions.some(
    (action) => (action.spellLevel ?? 0) > 0 && heals(action),
  );
  const spendsSlot = foesHp > stats.maxHp && slotsLeft > (healer ? 1 : 0);

  if (decision.id.startsWith(`${NS}:afterHit:`)) {
    return spendsSlot ? first.id : DECLINE;
  }

  const wounded = parsed
    .filter(
      ({ action, target }) =>
        heals(action) && target && hpFraction(target, context) < 0.5,
    )
    .sort((a, b) => (a.target?.hp ?? 0) - (b.target?.hp ?? 0))[0];
  if (wounded) return wounded.option.id;

  const foes = enemies(state, actor).filter((item) => !isDown(item));
  const areas = parsed.filter(
    ({ action, target }) =>
      !target &&
      !heals(action) &&
      action.spellLevel === null &&
      "area" in action.activation.targeting &&
      action.activation.targeting.side === "enemy",
  );
  // A monster's area attack, such as a breath weapon, is its strongest choice while it's ready. One with no recharge
  // has to catch more than one foe to beat attacking, and one that only applies a condition waits until at least
  // half the foes are free of it, as repeating it on the rest would waste the turn.
  const blast = areas.find(({ action, worth }) => {
    const { cost, resolution } = action.activation;
    if ("damage" in resolution && resolution.damage.length > 0) {
      return (
        (worth ?? foes.length) > 1 ||
        cost.some((item) => typeof item === "object")
      );
    }
    const applied = (
      resolution.kind === "save" ? resolution.onFail : []
    ).flatMap((item) =>
      item.kind === "applyCondition" ? [item.condition] : [],
    );
    const free = foes.filter((item) => !hasCondition(item, ...applied));
    return free.length > 0 && free.length * 2 >= foes.length;
  });
  if (blast) return blast.option.id;

  // One slot a turn, on a spell that's still doing nothing: never a second Concentration or the same buff twice.
  const freshTurn = actor.budget.action && actor.budget.bonusAction;
  const slotSpell = parsed
    .filter(({ action, target, slot }) => {
      const { activation, spellLevel } = action;
      if (slot !== undefined || (spellLevel ?? 0) === 0) return false;
      if (heals(action) || !activation.cost.includes("slot")) return false;
      const { resolution } = activation;
      const leaves =
        resolution.kind === "automatic"
          ? resolution.effects
          : resolution.kind === "save"
            ? resolution.onFail
            : resolution.onHit;
      const concentrates = leaves.some(
        (item) =>
          "duration" in item &&
          typeof item.duration === "object" &&
          "concentration" in item.duration,
      );
      if (concentrates && actor.concentratingOn !== null) return false;
      const lasting = leaves.some(
        (item) => item.kind === "modifier" || item.kind === "applyCondition",
      );
      const harms = "damage" in resolution && resolution.damage.length > 0;
      if (!harms && !lasting) return false;
      const side =
        "side" in activation.targeting && activation.targeting.side === "enemy"
          ? enemies(state, actor)
          : allies(state, actor);
      const aimedAt = target ? [target] : side;
      return !(
        !harms &&
        aimedAt.some((item) =>
          item.activeEffects.some((effect) => effect.sourceId === action.id),
        )
      );
    })
    .sort(
      (a, b) =>
        Number("area" in b.action.activation.targeting) -
          Number("area" in a.action.activation.targeting) ||
        (b.action.spellLevel ?? 0) - (a.action.spellLevel ?? 0),
    )[0];
  if (spendsSlot && freshTurn && slotSpell) return slotSpell.option.id;

  const attack = parsed
    .filter(
      ({ action, target }) =>
        target?.side !== actor.side &&
        target !== undefined &&
        !heals(action) &&
        (action.spellLevel ?? 0) === 0,
    )
    .map((item) => ({
      ...item,
      // Three-quarters cover is worth going around while someone else is in the open.
      hidden: Number(
        item.target !== undefined &&
          coverFor(state, actor.position, item.target, [actor.id]) === 5,
      ),
    }))
    .sort(
      (a, b) =>
        a.hidden - b.hidden ||
        (a.target?.hp ?? 0) - (b.target?.hp ?? 0) ||
        attackRoutine(b.action, actor, stats).length -
          attackRoutine(a.action, actor, stats).length,
    )[0];
  if (attack) return attack.option.id;
  // Nothing in reach yet: walk closer while there's still an action to use when it gets there.
  if (
    actor.budget.action &&
    decision.options.some((option) => option.id === MOVE) &&
    stepToward(actor, context)
  ) {
    return MOVE;
  }
  const lastResort = areas.find(
    ({ action: { activation } }) =>
      "damage" in activation.resolution &&
      activation.resolution.damage.length > 0,
  );
  if (lastResort) return lastResort.option.id;

  // With the Attack action spent: Action Surge when the fight is still on, and a monster's free trick like Nimble Escape.
  const extra = parsed.find(({ action, target }) => {
    const { cost, resolution } = action.activation;
    if (target?.id !== actor.id || heals(action)) return false;
    return resolution.kind === "automatic" &&
      resolution.effects.some((item) => item.kind === "extraAction")
      ? foesHp > stats.maxHp && !actor.budget.action
      : actor.source.kind === "monster" && cost.includes("bonusAction");
  });
  if (extra) return extra.option.id;
  return decision.options.at(-1)?.id ?? first.id;
}
