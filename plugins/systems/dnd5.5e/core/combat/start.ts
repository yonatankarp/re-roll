import {
  environmentConditionEvents,
  fightEnvironment,
  uncalmed,
} from "../environment.ts";
import {
  initiativeMoveFrames,
  initiativeSwapFrames,
  inspirationEchoes,
} from "./reactions.ts";
import { z } from "zod";
import {
  ActivationSchema,
  type Battlemap,
  type Loot,
  MonsterSchema,
} from "../schemas.ts";
import {
  type EncounterOptions,
  type Frame,
  frameHandler,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  frame,
  freshActor,
  hasCondition,
  INCAPACITATING,
  isDead,
  isDown,
  NS,
} from "../state.ts";
import {
  deriveStats,
  lookup,
  rollAmount,
  rollDiceNotation,
  scaledDice,
  type Stats,
} from "../stats.ts";
import { canUse, rechargeAmount } from "../rest.ts";
import { rollD20 } from "../rules.ts";
import {
  openedCorners,
  placeOnMap,
  placeSides,
  type Square,
  wallKeys,
} from "../grid.ts";
import { terrainOf } from "../sight.ts";
import { lairTurns } from "../legendary.ts";
import { type Context, hasPassive } from "./queries.ts";
import { DAMAGE_TO_PARTY, resolveAction } from "./effects.ts";
import { damageToPartyFor } from "../worth.ts";
import {
  familiarActors,
  familiarFoundEvents,
  retinueActors,
} from "./familiar.ts";
import {
  companionActors,
  companionFoundEvents,
  companionOwner,
} from "./companions.ts";

export function startCombat(
  encounter: {
    readonly id: string;
    readonly monsters: readonly {
      readonly monster: string;
      readonly count: number;
    }[];
    readonly battlemap?: Battlemap | undefined;
    readonly loot?: Loot | undefined;
    readonly lair?: boolean | undefined;
    readonly sunlight?: true | undefined;
  },
  context: Context,
  { canFlee, standOffWins, defeatContinues }: EncounterOptions,
): SystemResult {
  const party = Object.values(context.state.actors).filter(
    (actor) => actor.side === "party" && !isDead(actor),
  );
  const monsters: Actor[] = [];
  for (const { monster, count } of encounter.monsters) {
    const statBlock = lookup(context, MonsterSchema, monster);
    const slug = monster.slice(monster.lastIndexOf("/") + 1);
    for (let index = 1; index <= count; index += 1) {
      const id = `${encounter.id}:${slug}-${String(index)}`;
      monsters.push({
        ...freshActor({
          id,
          name:
            count > 1 ? `${statBlock.name} ${String(index)}` : statBlock.name,
          side: "enemy",
          source: { kind: "monster", statBlockId: monster },
          hp: statBlock.hp,
          inventory: [],
        }),
        // A condition it always has, as an invisible stalker's Invisibility.
        activeEffects: statBlock.passives.flatMap((passive) =>
          passive.kind === "innateCondition"
            ? [
                {
                  sourceId: `${id}:innate`,
                  casterId: id,
                  modifier: {
                    kind: "condition" as const,
                    condition: passive.condition,
                  },
                  ends: "spellDuration" as const,
                },
              ]
            : [],
        ),
      });
    }
  }

  // Familiars are found before the fight, and join it beside their owners, without counting towards its size.
  // Lasting companions too, as a Steel Defender, which then act right after their owners.
  const found = [
    ...familiarFoundEvents(party, context, "fight"),
    ...companionFoundEvents(party, context, "fight"),
  ];
  const foundState = found.reduce(applyDndEvent, context.state);
  const owners = party.flatMap((actor) => foundState.actors[actor.id] ?? []);
  const familiars = [
    ...familiarActors(owners, { ...context, state: foundState }),
    ...companionActors(owners, context),
    // and so do the creatures they keep between fights, as Animate Dead's undead
    ...retinueActors(party, context),
  ];

  // The story's word on surprise, such as from a Stealth check.
  // Alarm or a Faithful Hound readied in this scene: the party isn't caught unawares.
  const alarmed = party.some((actor) =>
    actor.activeEffects.some(
      ({ modifier }) => modifier.kind === "prepared" && modifier.alert,
    ),
  );
  const told = context.state.surprise;
  const surprised = alarmed && told === "party" ? undefined : told;
  const caught = { party: "party", enemies: "enemy" }[surprised ?? "party"];
  // Zhentarim Ruffian's Family First: Heroic Inspiration held now buys the party Advantage on Initiative.
  const rallier = party.find(
    (actor) =>
      actor.heroicInspiration &&
      hasPassive(deriveStats(actor, context), "initiativeInspiration"),
  );
  // A Weapon of Warning's Advantage on Initiative for its bearer's allies.
  const warned = party.some((actor) =>
    deriveStats(actor, context).passives.some(
      (passive) => passive.kind === "initiativeAdvantage" && passive.allies,
    ),
  );
  // Adventurer's Atlas: its dice added to the Initiative of the bearer and the allies holding its maps.
  // shortcut: every party member holds one, rather than up to 1 plus the bearer's Intelligence modifier.
  const atlas = party.flatMap((actor) =>
    deriveStats(actor, context).passives.flatMap((passive) =>
      passive.kind === "partyInitiative" ? [passive.dice] : [],
    ),
  )[0];
  // Ambush: a die of its resource added to Initiative, spent.
  // shortcut: it's spent on every Initiative while one is left, where the player would choose when.
  const dieSpent: SystemEvent[] = [];
  const initiativeDie = (
    actor: Actor,
    stats: Stats,
    allies = false,
  ): number => {
    for (const passive of stats.passives) {
      if (passive.kind !== "initiativeDie") continue;
      if ((passive.allies === true) !== allies) continue;
      if (allies && hasCondition(actor, ...INCAPACITATING)) continue;
      const left =
        (stats.resources[passive.resource] ?? 0) -
        (actor.resourcesSpent[passive.resource] ?? 0);
      if (left <= 0) continue;
      dieSpent.push(
        dndEvent(`${NS}:resourceSpent`, {
          actor: actor.id,
          resource: passive.resource,
        }),
      );
      return rollDiceNotation(
        scaledDice(
          { dice: passive.bonusDice, dieSize: passive.dieSize },
          stats.scaling,
        ) ?? passive.bonusDice,
        context.dice,
      );
    }
    return 0;
  };
  // Tandem Footwork: one bearer's die, rolled once, for the whole party.
  // shortcut: every ally gains it, as the party isn't placed yet to measure 30 feet.
  let tandem = 0;
  for (const actor of party) {
    tandem = initiativeDie(actor, deriveStats(actor, context), true);
    if (tandem > 0) break;
  }
  const rolled = [...party, ...familiars, ...monsters].map(
    (actor, position) => {
      const stats = deriveStats(actor, context);
      const edge = {
        advantage:
          ((rallier !== undefined || warned) && actor.side === "party") ||
          hasPassive(stats, "initiativeAdvantage") ||
          hasCondition(actor, "invisible"),
        disadvantage:
          (Boolean(surprised) && actor.side === caught) ||
          hasCondition(actor, ...INCAPACITATING),
        rerollOnes: stats.passives.some(({ kind }) => kind === "rerollOnes"),
      };
      const first = rollD20(context.dice, edge).natural;
      // Survivor's Hypervigilance rolls a low one again, and the new roll stands.
      const low = Math.max(
        0,
        ...stats.passives.flatMap((passive) =>
          passive.kind === "initiativeReroll" ? [passive.atMost] : [],
        ),
      );
      const natural =
        first <= low ? rollD20(context.dice, edge).natural : first;
      return {
        id: actor.id,
        position,
        total:
          natural +
          stats.initiative +
          initiativeDie(actor, stats) +
          (actor.side === "party" ? tandem : 0) +
          (atlas && actor.side === "party"
            ? rollDiceNotation(atlas, context.dice)
            : 0),
      };
    },
  );
  // Ties keep their listed order, so the result is the same on every machine.
  const sorted = rolled.sort(
    (a, b) => b.total - a.total || a.position - b.position,
  );
  const order = afterOwners(
    sorted.map((item) => item.id),
    familiars,
  );
  // Thief's Reflexes: a second turn in the first round, before the first creature whose Initiative is lower than
  // its own less ten, or at the round's end.
  const fighters = [...party, ...familiars, ...monsters];
  const secondTurns = sorted.flatMap((item) => {
    const actor = fighters.find((other) => other.id === item.id);
    const passive = actor
      ? deriveStats(actor, context).passives.find(
          (entry) => entry.kind === "secondTurn",
        )
      : undefined;
    if (passive?.kind !== "secondTurn") return [];
    const at = item.total - passive.minus;
    const before = sorted.find((other) => other.total < at)?.id ?? null;
    return [{ actor: item.id, before }];
  });
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
              [...party, ...familiars].map((actor) => actor.id),
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
        [...party, ...familiars].map((actor) => actor.id),
        monsters.map((actor) => actor.id),
      );
  const startsOf = (list: readonly Actor[]): Square[] =>
    list.flatMap((actor) => positions[actor.id] ?? []);
  const openCorners = battlemap
    ? openedCorners(walls, grid, startsOf(party), startsOf(monsters))
    : [];

  // A fight is fought in the effects the story put the party in (the environment effect), less what the party's
  // magic calms, as Control Weather a storm.
  const around = uncalmed(context.state.ambient, context.state, context);
  const environment = fightEnvironment(around, context);
  const started = {
    encounter: encounter.id,
    monsters,
    order,
    grid,
    positions,
    ...(battlemap
      ? {
          walls: [...walls],
          ...(openCorners.length > 0 ? { openCorners } : {}),
          ...(terrain ? { terrain } : {}),
          map: {
            image: battlemap.image,
            imageWidth: battlemap.imageWidth,
            imageHeight: battlemap.imageHeight,
            crop: battlemap.crop,
          },
          fog: true as const,
        }
      : {}),
    ...(canFlee ? { canFlee } : {}),
    ...(canFlee && standOffWins ? { standOffWins: true as const } : {}),
    ...(defeatContinues ? { defeatContinues } : {}),
    ...(encounter.loot ? { loot: encounter.loot } : {}),
    ...(encounter.sunlight ? { sunlight: true as const } : {}),
    ...(environment ? { environment } : {}),
    ...(surprised ? { surprised } : {}),
    ...(lair ? { lair } : {}),
    ...(secondTurns.length > 0 ? { secondTurns } : {}),
    ...(familiars.length > 0 ? { familiars } : {}),
  };
  // Weighed as the fight starts, with everyone in it the party can see, and kept: a fight's share never
  // changes once begun.
  const share = damageToPartyFor({
    ...context,
    state: applyDndEvent(foundState, dndEvent(`${NS}:combatStarted`, started)),
  });
  const lowered = share < DAMAGE_TO_PARTY[context.state.difficulty ?? "normal"];

  return {
    events: [
      { kind: "encounterStarted", encounter: encounter.id },
      ...found,
      ...(rallier
        ? [
            dndEvent(`${NS}:inspirationSpent`, { actor: rallier.id }),
            ...inspirationEchoes(rallier, context),
          ]
        : []),
      dndEvent(`${NS}:combatStarted`, {
        ...started,
        ...(lowered ? { damageToParty: share } : {}),
      }),
      ...dieSpent,
      ...rallyEvents(party, context),
      ...party.flatMap((actor) => initiativeRecharge(actor, context)),
      ...environmentConditionEvents(around, [...party, ...monsters], context),
    ],
    // Alert's Initiative Swap comes first. With nobody on 20 or more, the lair acts before anyone.
    frames: [
      ...(party.some((actor) =>
        actor.activeEffects.some(
          ({ modifier }) => modifier.kind === "prepared",
        ),
      )
        ? [frame("wardsSet", {})]
        : []),
      ...initiativeSwapFrames(party, context),
      ...initiativeMoveFrames(party, context),
      ...(lair?.at === 0
        ? lairTurns(
            {
              ...context.state,
              actors: Object.fromEntries(
                monsters.map((item) => [item.id, item]),
              ),
              combat: { encounter: encounter.id, order, index: 0, round: 1 },
            },
            "start",
            context,
          )
        : []),
    ],
  };
}

// Uses that come back when Initiative is rolled, as Second Chance's or Superior Inspiration's, in feature order. One
// that spends a once-a-rest use, as Persistent Rage or Uncanny Metabolism, is taken once half the pool or more is
// spent, so Perfect Focus after it tops up only when it wasn't.
// shortcut: the player's is taken the same way, not asked.
export function initiativeRecharge(
  actor: Actor,
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(actor, context);
  const spent = new Map(Object.entries(actor.resourcesSpent));
  const used = (id: string): number => spent.get(id) ?? 0;
  let { hp } = actor;
  const events: SystemEvent[] = [];
  for (const { id, recharge } of stats.resourceDefs) {
    const max = stats.resources[id] ?? 0;
    for (const entry of recharge) {
      if (entry.on !== "initiative" || !canUse(entry, used, stats)) continue;
      if (entry.uses !== undefined && used(id) * 2 < max) continue;
      const amount = rechargeAmount(entry, used(id), max, stats);
      if (amount <= 0) continue;
      spent.set(id, used(id) - amount);
      events.push(
        dndEvent(`${NS}:resourceRestored`, {
          actor: actor.id,
          resource: id,
          amount,
        }),
      );
      if (entry.uses !== undefined) {
        spent.set(entry.uses, used(entry.uses) + 1);
        events.push(
          dndEvent(`${NS}:resourceSpent`, {
            actor: actor.id,
            resource: entry.uses,
          }),
        );
      }
      const healed = entry.heal
        ? Math.min(
            rollAmount(entry.heal, stats, context.dice),
            stats.maxHp - hp,
          )
        : 0;
      if (healed > 0) {
        hp += healed;
        events.push(
          dndEvent(`${NS}:healed`, {
            actor: actor.id,
            amount: healed,
            max: stats.maxHp,
          }),
        );
      }
    }
  }
  return events;
}

// A lasting companion acts right after its owner, whatever it rolled.
function afterOwners(
  order: readonly string[],
  joined: readonly Actor[],
): string[] {
  const following = new Map(
    joined.flatMap((actor) => {
      const owner = companionOwner(actor);
      return owner ? [[actor.id, owner] as const] : [];
    }),
  );
  return order
    .filter((id) => !following.has(id))
    .flatMap((id) => [
      id,
      ...[...following].flatMap(([companion, owner]) =>
        owner === id ? [companion] : [],
      ),
    ]);
}

// Rallying Cry: as a fight starts, a use spent gives Heroic Inspiration to as many of the party as the bearer's
// Proficiency Bonus, the bearer and those without it first (schemas.ts initiativeRally).
function rallyEvents(party: readonly Actor[], context: Context): SystemEvent[] {
  const inspired = new Set(
    party.flatMap((actor) => (actor.heroicInspiration ? [actor.id] : [])),
  );
  return party.flatMap((actor) => {
    const stats = deriveStats(actor, context);
    const rally = stats.passives.find(
      (passive) => passive.kind === "initiativeRally",
    );
    if (
      rally?.kind !== "initiativeRally" ||
      isDown(actor) ||
      hasCondition(actor, ...INCAPACITATING) ||
      (stats.resources[rally.resource] ?? 0) -
        (actor.resourcesSpent[rally.resource] ?? 0) <=
        0
    ) {
      return [];
    }
    const chosen = [actor, ...party.filter((other) => other !== actor)]
      .filter((other) => !isDown(other) && !inspired.has(other.id))
      .slice(0, stats.proficiency);
    for (const other of chosen) inspired.add(other.id);
    return [
      dndEvent(`${NS}:resourceSpent`, {
        actor: actor.id,
        resource: rally.resource,
      }),
      ...chosen.map((other) =>
        dndEvent(`${NS}:inspirationGranted`, { actor: other.id }),
      ),
    ];
  });
}

// The wards the party readied in this scene go off as the fight starts: each `prepared` activation at the first foe in
// the Initiative order (or its bearer, for one aimed at itself), and the readied effect ends.
export const wardFrames = {
  [`${NS}:wardsSet`]: frameHandler({
    schema: z.object({}),
    run: (_payload, context: Context): SystemResult => {
      const { state } = context;
      const order = state.combat?.order ?? [];
      const foe = order
        .map((id) => state.actors[id])
        .find((item) => item !== undefined && item.side !== "party");
      const events: SystemEvent[] = [];
      const frames: Frame[] = [];
      for (const actor of Object.values(state.actors)) {
        for (const effect of actor.activeEffects) {
          const { modifier } = effect;
          if (modifier.kind !== "prepared") continue;
          events.push(
            dndEvent(`${NS}:effectEnded`, {
              actor: actor.id,
              sourceId: effect.sourceId,
              casterId: effect.casterId,
            }),
          );
          const activation = modifier.activation
            ? ActivationSchema.parse(modifier.activation)
            : undefined;
          if (!activation) continue;
          const self = "self" in activation.targeting;
          const target = self ? actor : foe;
          if (!target) continue;
          const result = resolveAction(
            {
              id: effect.sourceId,
              name: "Ward",
              activation: { ...activation, cost: [] },
              spellLevel: effect.level ?? null,
            },
            actor,
            [target],
            context,
          );
          events.push(...(result.events ?? []));
          frames.push(...(result.frames ?? []));
        }
      }
      return { events, frames };
    },
  }),
};
