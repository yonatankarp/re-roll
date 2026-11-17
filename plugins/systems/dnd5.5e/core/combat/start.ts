import { initiativeSwapFrames, inspirationEchoes } from "./reactions.ts";
import { type Battlemap, type Loot, MonsterSchema } from "../schemas.ts";
import {
  type EncounterOptions,
  type SystemEvent,
  type SystemResult,
} from "#sdk";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  freshActor,
  isDead,
  NS,
} from "../state.ts";
import { deriveStats, lookup, rollAmount } from "../stats.ts";
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
import { DAMAGE_TO_PARTY } from "./effects.ts";
import { damageToPartyFor } from "../worth.ts";
import { familiarActors, familiarFoundEvents } from "./familiar.ts";

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
    readonly sunlight?: true | undefined;
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
  const found = familiarFoundEvents(party, context, "fight");
  const foundState = found.reduce(applyDndEvent, context.state);
  const familiars = familiarActors(
    party.flatMap((actor) => foundState.actors[actor.id] ?? []),
    { ...context, state: foundState },
  );

  // The story's word on surprise, such as from a Stealth check, beats the encounter's own.
  const surprised = context.state.surprise ?? encounter.surprise;
  const caught = { party: "party", enemies: "enemy" }[surprised ?? "party"];
  // Zhentarim Ruffian's Family First: Heroic Inspiration held now buys the party Advantage on Initiative.
  const rallier = party.find(
    (actor) =>
      actor.heroicInspiration &&
      hasPassive(deriveStats(actor, context), "initiativeInspiration"),
  );
  const rolled = [...party, ...familiars, ...monsters].map(
    (actor, position) => {
      const stats = deriveStats(actor, context);
      const edge = {
        advantage:
          (rallier !== undefined && actor.side === "party") ||
          hasPassive(stats, "initiativeAdvantage"),
        disadvantage: Boolean(surprised) && actor.side === caught,
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
      return { id: actor.id, position, total: natural + stats.initiative };
    },
  );
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
    ...(defeatContinues ? { defeatContinues } : {}),
    ...(encounter.loot ? { loot: encounter.loot } : {}),
    ...(encounter.sunlight ? { sunlight: true as const } : {}),
    ...(surprised ? { surprised } : {}),
    ...(lair ? { lair } : {}),
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
      ...party.flatMap((actor) => initiativeRecharge(actor, context)),
    ],
    // Alert's Initiative Swap comes first. With nobody on 20 or more, the lair acts before anyone.
    frames: [
      ...initiativeSwapFrames(party, context),
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
