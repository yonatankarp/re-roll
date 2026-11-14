import { type Battlemap, type Loot, MonsterSchema } from "../schemas.ts";
import { type EncounterOptions, type SystemResult } from "#sdk";
import {
  type Actor,
  applyDndEvent,
  dndEvent,
  freshActor,
  isDead,
  NS,
} from "../state.ts";
import { deriveStats, lookup } from "../stats.ts";
import { rollD20 } from "../rules.ts";
import { placeOnMap, placeSides, type Square, wallKeys } from "../grid.ts";
import { terrainOf } from "../sight.ts";
import { lairTurns } from "../legendary.ts";
import { type Context, hasPassive } from "./queries.ts";
import { DAMAGE_TO_PARTY } from "./effects.ts";
import { damageToPartyFor } from "../worth.ts";

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
  // Zhentarim Ruffian's Family First: Heroic Inspiration held now buys the party Advantage on Initiative.
  const rallier = party.find(
    (actor) =>
      actor.heroicInspiration &&
      hasPassive(deriveStats(actor, context), "initiativeInspiration"),
  );
  const rolled = [...party, ...monsters].map((actor, position) => {
    const stats = deriveStats(actor, context);
    const edge = {
      advantage: rallier !== undefined && actor.side === "party",
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
    const natural = first <= low ? rollD20(context.dice, edge).natural : first;
    return { id: actor.id, position, total: natural + stats.initiative };
  });
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

  const started = {
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
          fog: true as const,
        }
      : {}),
    ...(canFlee ? { canFlee } : {}),
    ...(defeatContinues ? { defeatContinues } : {}),
    ...(encounter.loot ? { loot: encounter.loot } : {}),
    ...(surprised ? { surprised } : {}),
    ...(lair ? { lair } : {}),
  };
  // Weighed as the fight starts, with everyone in it the party can see, and kept: a fight's share never
  // changes once begun.
  const share = damageToPartyFor({
    ...context,
    state: applyDndEvent(
      context.state,
      dndEvent(`${NS}:combatStarted`, started),
    ),
  });
  const lowered = share < DAMAGE_TO_PARTY[context.state.difficulty ?? "normal"];

  return {
    events: [
      { kind: "encounterStarted", encounter: encounter.id },
      ...(rallier
        ? [dndEvent(`${NS}:inspirationSpent`, { actor: rallier.id })]
        : []),
      dndEvent(`${NS}:combatStarted`, {
        ...started,
        ...(lowered ? { damageToParty: share } : {}),
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
