import {
  awaitDecision,
  type Frame,
  frameHandler,
  type SystemEvent,
} from "#sdk";
import { z } from "zod";
import {
  ClassSchema,
  type Passive,
  SpellSchema,
  type Table,
} from "../schemas.ts";
import { type Actor, dndEvent, frame, isDown, NS } from "../state.ts";
import { distanceFeet } from "../grid.ts";
import {
  deriveStats,
  evaluateFormula,
  type KnownAction,
  lookup,
  onClassList,
  spellModifier,
  spellSaveDc,
  type Stats,
} from "../stats.ts";
import { HIT_DICE, spellOfSource } from "./ids.ts";
import { hitDieRoll } from "../trait-rules.ts";
import { channelEvents, leafEvents, rollSave } from "./effects.ts";
import { tableOf, tableRoll } from "./reactions.ts";
import { teleportFrame } from "./movement.ts";
import type { Context } from "./queries.ts";

// The Arcana Unleashed adepts' riders on casting a spell of their school (passive `schoolCast`).

type Rider = Extract<Passive, { kind: "schoolCast" }>["rider"];
const FUELED = "fueled"; // usedThisTurn: Fueled Evocation's once a turn

// The school of the spell behind an action or a Concentration source (ids.ts spellOfSource).
export function schoolOf(
  sourceId: string | null,
  context: Pick<Context, "content">,
): string | null {
  const id = sourceId === null ? null : spellOfSource(sourceId);
  if (!id) return null;
  return SpellSchema.safeParse(context.content(id)).data?.school ?? null;
}

function riding(stats: Stats, school: string | null, rider: Rider): boolean {
  return stats.passives.some(
    (passive) =>
      passive.kind === "schoolCast" &&
      passive.school === school &&
      passive.rider === rider,
  );
}

// Up to this many of the actor's unspent Hit Point Dice, rolled and spent.
function spendHitDice(
  actor: Actor,
  count: number,
  context: Context,
): { readonly total: number; readonly events: SystemEvent[] } {
  const build = actor.source.kind === "character" ? actor.source.build : null;
  const spent = actor.resourcesSpent[HIT_DICE] ?? 0;
  const entries = build?.levels.slice(spent, spent + count) ?? [];
  let total = 0;
  for (const entry of entries) {
    total += hitDieRoll(
      lookup(context, ClassSchema, entry.classId).hitDie,
      deriveStats(actor, context),
      context.dice,
    );
  }
  return {
    total,
    events: entries.map(() =>
      dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource: HIT_DICE }),
    ),
  };
}

// Casting a spell of the school with a slot: Protective Ward's Temporary Hit Points, Life Manipulation's healing and
// Magical Augmentation's Speed.
// shortcut: the ward always goes to the caster, and Hit Point Dice are spent only while it's hurt.
export function schoolCastEvents(
  actor: Actor,
  action: KnownAction,
  slotLevel: number | undefined,
  context: Context,
): SystemEvent[] {
  if (slotLevel === undefined || action.spellLevel === null) return [];
  const stats = deriveStats(actor, context);
  const school = schoolOf(action.id, context);
  const events: SystemEvent[] = [];
  if (riding(stats, school, "ward")) {
    events.push(
      dndEvent(`${NS}:tempHpGained`, {
        actor: actor.id,
        amount: 2 * slotLevel,
      }),
    );
  }
  if (riding(stats, school, "life") && actor.hp < stats.maxHp) {
    const { total, events: spent } = spendHitDice(actor, 2, context);
    if (spent.length > 0) {
      events.push(
        ...spent,
        dndEvent(`${NS}:healed`, {
          actor: actor.id,
          amount: Math.min(
            total + slotLevel,
            stats.maxHp - Math.max(actor.hp, 0),
          ),
          max: stats.maxHp,
        }),
      );
    }
  }
  if (riding(stats, school, "augment") && context.state.combat) {
    events.push(
      dndEvent(`${NS}:effectAdded`, {
        actor: actor.id,
        effect: {
          sourceId: `schoolCast:${action.id}`,
          casterId: actor.id,
          modifier: {
            kind: "bonus",
            to: "speed",
            amount: { bonus: { base: 5 * slotLevel, add: [] } },
          },
          ends: "casterTurnEnd",
        },
      }),
    );
  }
  // Expert Divination: the highest spent slot below the one cast with, up to level 5.
  if (riding(stats, school, "refund") && slotLevel >= 2) {
    for (let level = Math.min(slotLevel - 1, 5); level >= 1; level -= 1) {
      const resource = `slot:${String(level)}`;
      if ((actor.resourcesSpent[resource] ?? 0) === 0) continue;
      events.push(
        dndEvent(`${NS}:resourceRestored`, {
          actor: actor.id,
          resource,
          amount: 1,
        }),
      );
      break;
    }
  }
  return events;
}

// Fueled Evocation: once a turn, up to two Hit Point Dice added to an Evocation spell's damage.
// shortcut: only a save or automatic spell's damage, since a spell attack's is rolled in attack.ts.
export function fueledDamage(
  actor: Actor,
  action: KnownAction,
  context: Context,
): { readonly bonus: number; readonly events: SystemEvent[] } {
  const stats = deriveStats(actor, context);
  if (
    action.spellLevel === null ||
    actor.usedThisTurn.includes(FUELED) ||
    !riding(stats, schoolOf(action.id, context), "fueled")
  ) {
    return { bonus: 0, events: [] };
  }
  const { total, events } = spendHitDice(actor, 2, context);
  if (events.length === 0) return { bonus: 0, events: [] };
  return {
    bonus: total,
    events: [
      ...events,
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: FUELED }),
    ],
  };
}

// Flames of Phlegethos: casting a spell that deals the type puts the rider's effects on the caster. Bewitching
// Magic: casting one of the school with an action and a slot does, its teleport landing where the caster picks.
export function castRiders(
  actor: Actor,
  action: KnownAction,
  slotLevel: number | undefined,
  context: Context,
  targets: readonly Actor[] = [],
): { readonly events: SystemEvent[]; readonly frames: Frame[] } {
  if (action.spellLevel === null) return { events: [], frames: [] };
  const { resolution, cost } = action.activation;
  const types = new Set([
    ...resolution.damage.map(({ type }) => type),
    ...(resolution.kind === "attack" && resolution.onHitSave
      ? resolution.onHitSave.damage.map(({ type }) => type)
      : []),
  ]);
  const school = schoolOf(action.id, context);
  const stats = deriveStats(actor, context);
  const surged: SystemEvent[] = [];
  const rides = stats.passives.flatMap((passive) => {
    if (passive.kind !== "castRider") return [];
    if (
      passive.resource &&
      (actor.resourcesSpent[passive.resource] ?? 0) >=
        (stats.resources[passive.resource] ?? 0)
    ) {
      return [];
    }
    if (passive.refills && (actor.resourcesSpent[passive.refills] ?? 0) === 0) {
      return [];
    }
    // Wild Magic Surge: a spell of the class's list cast with a slot, once a turn behind its die.
    if (passive.classes) {
      const spellId = spellOfSource(action.id);
      const spell = spellId
        ? SpellSchema.safeParse(context.content(spellId)).data
        : undefined;
      if (
        slotLevel === undefined ||
        !spell ||
        !onClassList(spell, passive.classes) ||
        (passive.chance && actor.usedThisTurn.includes(SURGE))
      ) {
        return [];
      }
      if (passive.chance) {
        surged.push(
          dndEvent(`${NS}:oncePerTurnUsed`, { actor: actor.id, key: SURGE }),
        );
        const die = context.dice.roll(passive.chance.die);
        surged.push(
          dndEvent(`${NS}:dieRolled`, {
            actor: actor.id,
            die: passive.chance.die,
            rolled: die,
            label: "Wild Magic Surge",
          }),
        );
        if (die < passive.chance.at) return [];
      }
      return [passive];
    }
    const fits = passive.uses
      ? passive.uses.some(
          (id) =>
            action.id === `spell:${id}` || action.id.startsWith(`spell:${id}:`),
        )
      : passive.school
        ? slotLevel !== undefined &&
          (cost.includes("action") || passive.slotted === true) &&
          passive.school.some((item) => item === school)
        : passive.damage !== undefined && types.has(passive.damage);
    return fits ? [passive] : [];
  });
  // Simbul's Synostodweomer: a slot spell rolls as many Hit Point Dice as the slot's level.
  const mended =
    slotLevel === undefined
      ? []
      : actor.activeEffects.flatMap(({ modifier, casterId, sourceId }) => {
          if (modifier.kind !== "castHitDice") return [];
          const by = context.state.actors[casterId] ?? actor;
          return leafEvents(
            [
              {
                kind: "hitDieHeal",
                dice: slotLevel,
                bonus: {
                  base: evaluateFormula(
                    modifier.bonus,
                    deriveStats(by, context),
                  ),
                  add: [],
                },
              },
            ],
            sourceId,
            by,
            actor,
            context,
          );
        });
  // A surge's table, rolled at the spell's first target, as the Wild Magic Surge table; picked from all its rows but
  // the last with Tamed Surge, or from two rolls with Controlled Chaos.
  const aimed = targets.find((target) => target.id !== actor.id);
  const level = slotLevel ?? action.spellLevel;
  const tables = rides.flatMap(({ rollTable, pick, resource }) => {
    const table = rollTable ? tableOf(rollTable, context) : undefined;
    if (!rollTable || !table) return [];
    const twice = stats.passives.some(
      (passive) => passive.kind === "tableTwice" && passive.from === rollTable,
    );
    if (!pick && !twice) {
      return [
        tableRoll(table, action, actor, undefined, aimed, level, context),
      ];
    }
    const events: SystemEvent[] = [];
    const faces = pick
      ? table.rows.slice(0, -1).map((row) => row.min)
      : [1, 2].map(() => {
          const face = context.dice.roll(table.die);
          events.push(
            dndEvent(`${NS}:dieRolled`, {
              actor: actor.id,
              die: table.die,
              rolled: face,
              label: action.name,
            }),
          );
          return face;
        });
    return [
      {
        events,
        frames: [
          tablePickFrame(actor, rollTable, table, faces, pick === true, {
            actionId: action.id,
            name: action.name,
            spellLevel: level,
            ...(aimed ? { target: aimed.id } : {}),
            ...(pick && resource ? { resource } : {}),
          }),
        ],
        negate: false,
      },
    ];
  });
  return {
    events: [
      ...surged,
      ...mended,
      ...tables.flatMap((rolled) => rolled.events),
      ...rides.flatMap(
        ({ effects, onTargets, resource, toAlly, pick, refills }) => [
          // A pick's use is spent once a row is picked (tablePickFrames).
          ...(resource && !pick
            ? [dndEvent(`${NS}:resourceSpent`, { actor: actor.id, resource })]
            : []),
          ...(refills
            ? [
                dndEvent(`${NS}:resourceRestored`, {
                  actor: actor.id,
                  resource: refills,
                  amount: 1,
                }),
              ]
            : []),
          ...leafEvents(
            effects,
            `castRider:${action.id}`,
            actor,
            toAlly ? (hurtAlly(actor, toAlly, context) ?? actor) : actor,
            context,
            undefined,
            slotLevel,
          ),
          // On the spell's targets too, ending with it, as Hunter's Rime's hold on the marked.
          ...(onTargets
            ? targets.flatMap((target) =>
                target.id === actor.id
                  ? []
                  : leafEvents(onTargets, action.id, actor, target, context),
              )
            : []),
        ],
      ),
    ],
    frames: [
      ...tables.flatMap((rolled) => rolled.frames),
      ...rides.flatMap(({ effects, choices }) => [
        ...(choices ? riderChoiceFrame(actor, choices, action, context) : []),
        ...effects.flatMap((effect) =>
          effect.kind === "teleport"
            ? [
                teleportFrame(
                  actor,
                  effect.feet,
                  effect.movement,
                  context,
                  effect.provokes,
                ),
              ]
            : [],
        ),
      ]),
    ],
  };
}

const SURGE = "wild-magic-surge";

// A row of a table picked rather than rolled, as Tamed Surge's or Controlled Chaos's: rows not `harmful` are listed
// first, so tactics take the first (policy.ts); a pick made by choice may also be none.
function tablePickFrame(
  actor: Actor,
  from: string,
  table: Table,
  faces: readonly number[],
  optional: boolean,
  roll: z.infer<typeof TablePickSchema>["roll"],
): Frame {
  const rowOf = (face: number) =>
    table.rows.find((row) => row.min <= face && face <= row.max);
  const options = [...new Set(faces)]
    .map((face) => {
      const row = rowOf(face);
      return {
        id: String(face),
        label:
          optional && row
            ? `${roll.name}: ${String(row.min)}–${String(row.max)}`
            : `${roll.name}: ${String(face)}`,
        harmful: row?.harmful === true,
      };
    })
    .sort((a, b) => Number(a.harmful) - Number(b.harmful))
    .map(({ id, label }) => ({ id, label }));
  return awaitDecision({
    id: `${NS}:tablePick:${actor.id}:${from}`,
    actor: actor.id,
    prompt: `${roll.name}: which result?`,
    options: [...options, ...(optional ? [{ id: NONE, label: "None" }] : [])],
    resume: frame("tablePick", { actor: actor.id, from, roll }),
  });
}

// Controlled Channeling: a face picked, no higher than the die allows, and kept as channeled.
export function channelPickFrame(
  actor: Actor,
  from: string,
  table: Table,
  sides: number,
  target: Actor,
): Frame {
  const faces = table.rows
    .map((row) => row.min)
    .filter((face) => face <= sides);
  return tablePickFrame(actor, from, table, faces, false, {
    actionId: from,
    name: "Channel",
    spellLevel: 0,
    target: target.id,
    channel: true,
  });
}

const TablePickSchema = z.object({
  actor: z.string(),
  from: z.string(),
  roll: z.object({
    actionId: z.string(),
    name: z.string(),
    spellLevel: z.number().int(),
    target: z.string().optional(),
    resource: z.string().optional(), // spent once a row is picked
    channel: z.literal(true).optional(), // the face is kept as channeled, not resolved now
  }),
  answer: z.string(),
});

export const tablePickFrames = {
  [`${NS}:tablePick`]: frameHandler({
    schema: TablePickSchema,
    run: ({ actor: actorId, from, roll, answer }, context: Context) => {
      const actor = context.state.actors[actorId];
      const table = tableOf(from, context);
      if (!actor || !table || answer === NONE) return {};
      const action: KnownAction = {
        id: roll.actionId,
        name: roll.name,
        activation: {
          cost: [],
          targeting: { self: true },
          resolution: { kind: "automatic", damage: [], effects: [] },
        },
        spellLevel: roll.spellLevel,
      };
      const target = roll.target
        ? context.state.actors[roll.target]
        : undefined;
      if (roll.channel) {
        return {
          events: channelEvents(from, Number(answer), actor, target ?? actor),
        };
      }
      const spent = roll.resource
        ? [
            dndEvent(`${NS}:resourceSpent`, {
              actor: actor.id,
              resource: roll.resource,
            }),
          ]
        : [];
      const rolled = tableRoll(
        table,
        action,
        actor,
        undefined,
        target,
        roll.spellLevel,
        context,
        Number(answer),
      );
      return { events: [...spent, ...rolled.events], frames: rolled.frames };
    },
  }),
};

type Choice = NonNullable<
  Extract<Passive, { kind: "castRider" }>["choices"]
>[number];

const NONE = "none";

// Steps of the Fey: once the spell is done the caster picks one of its rider's choices, or none: effects on itself or
// an ally near it, or a save for each foe near where it cast the spell.
function riderChoiceFrame(
  actor: Actor,
  choices: readonly Choice[],
  action: KnownAction,
  context: Context,
): Frame[] {
  const options = choices.flatMap((choice, index) => {
    if (choice.foes) {
      return [{ id: String(index), label: choice.name }];
    }
    const near = Object.values(context.state.actors).filter(
      (item) =>
        item.side === actor.side &&
        !isDown(item) &&
        (item.id === actor.id ||
          (choice.within !== undefined &&
            distanceFeet(item.position, actor.position) <= choice.within)),
    );
    return near.map((item) => ({
      id: `${String(index)}|${item.id}`,
      label:
        item.id === actor.id ? choice.name : `${choice.name}: ${item.name}`,
    }));
  });
  if (options.length === 0) return [];
  return [
    awaitDecision({
      id: `${NS}:riderChoice:${actor.id}:${action.id}`,
      actor: actor.id,
      prompt: `${action.name}: which of its extra effects?`,
      options: [...options, { id: NONE, label: "None" }],
      resume: frame("riderChoice", {
        actor: actor.id,
        sourceId: action.id,
        choices,
        ...(actor.position ? { from: actor.position } : {}),
      }),
    }),
  ];
}

const RiderChoiceSchema = z.object({
  actor: z.string(),
  sourceId: z.string(),
  choices: z.array(z.unknown()),
  from: z.object({ x: z.number(), y: z.number() }).optional(),
  answer: z.string(),
});

export const riderChoiceFrames = {
  [`${NS}:riderChoice`]: frameHandler({
    schema: RiderChoiceSchema,
    run: (payload, context: Context) => {
      const caster = context.state.actors[payload.actor];
      if (!caster || payload.answer === NONE) return {};
      const [index = "", targetId] = payload.answer.split("|");
      const choice = payload.choices[Number(index)] as Choice | undefined;
      if (!choice) throw new Error(`${payload.answer} isn't offered`);
      if (!choice.foes) {
        const target = context.state.actors[targetId ?? caster.id] ?? caster;
        return {
          events: leafEvents(
            choice.effects,
            payload.sourceId,
            caster,
            target,
            context,
          ),
        };
      }
      const { save, effects } = choice.foes;
      const dc = spellSaveDc(deriveStats(caster, context));
      const from = payload.from ?? caster.position;
      const events = Object.values(context.state.actors).flatMap((foe) => {
        if (
          foe.side === caster.side ||
          isDown(foe) ||
          distanceFeet(foe.position, from ?? null) > (choice.within ?? 5)
        ) {
          return [];
        }
        const rolled = save
          ? rollSave(foe, save, dc, context, true)
          : { saved: false, events: [] };
        return [
          ...rolled.events,
          ...(rolled.saved
            ? []
            : leafEvents(effects, payload.sourceId, caster, foe, context)),
        ];
      });
      return { events };
    },
  }),
};

// Undead Vitality: the most hurt of the caster's allies of these types near it, if one is hurt at all.
function hurtAlly(
  caster: Actor,
  near: { readonly creatureTypes: readonly string[]; readonly within: number },
  context: Context,
): Actor | null {
  const hurt = Object.values(context.state.actors)
    .filter(
      (item) =>
        item.side === caster.side &&
        item.hp > 0 &&
        distanceFeet(item.position, caster.position) <= near.within &&
        near.creatureTypes.includes(
          (deriveStats(item, context).creatureType ?? "").toLowerCase(),
        ),
    )
    .map((item) => ({
      item,
      missing: deriveStats(item, context).maxHp - item.hp,
    }))
    .sort((a, b) => b.missing - a.missing)[0];
  return hurt && hurt.missing > 0 ? hurt.item : null;
}

// Persistent Conjuration: the bonus to the save to keep Concentration on a Conjuration spell.
// shortcut: the spellcasting modifier, rather than the one the feat raised, which it usually is.
export function concentrationBonus(actor: Actor, context: Context): number {
  const stats = deriveStats(actor, context);
  // Bladesong's Focus: a bonus only to these saves.
  const focus = actor.activeEffects.reduce(
    (sum, { modifier }) =>
      modifier.kind === "bonus" &&
      modifier.to === "saves" &&
      modifier.concentration
        ? sum +
          evaluateFormula(modifier.amount.bonus ?? { base: 0, add: [] }, stats)
        : sum,
    0,
  );
  return (
    focus +
    (riding(stats, schoolOf(actor.concentratingOn, context), "persistent")
      ? Math.max(0, spellModifier(stats))
      : 0)
  );
}
