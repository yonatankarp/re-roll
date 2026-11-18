import {
  damageResponses,
  deriveStats,
  evaluateFormula,
  type KnownAction,
  lookup,
  passiveModifiers,
  rollAmount,
  rollDiceNotation,
  spellSaveDc,
  type Stats,
} from "../../stats.ts";
import {
  type Actor,
  applyDndEvent,
  cannotHeal,
  dndEvent,
  type DndState,
  hasCondition,
  INCAPACITATING,
  freshActor,
  isDead,
  isDown,
  NS,
} from "../../state.ts";
import { type SystemEvent } from "#sdk";
import { halved } from "../../rules.ts";
import {
  type Ability,
  type Amount,
  type Damage,
  type DamageType,
  ItemSchema,
  MonsterSchema,
  type Passive,
} from "../../schemas.ts";
import { WARD_DOWN } from "../../trait-rules.ts";
import { distanceFeet } from "../../grid.ts";
import { teleportSquares } from "../movement.ts";
import { beforeDamage } from "../reactions.ts";
import { spendHitDice } from "../school.ts";
import { headDamageEvents } from "../heads.ts";
import { lastsFor } from "../durations.ts";
import { type Context, currentActor, hasPassive } from "../queries.ts";
import { rollSave } from "./saves.ts";
import { killEvents, transferEvents, downedEvents } from "./zero-hp.ts";

// Damage: the difficulty's scaling, what a hit sets off, holding on at 1 Hit Point, and dealing it.

// Reports the damage, and whatever follows from it, as events.
// The difficulty setting scales the damage the party takes, and only that, so the books' monsters keep
// their numbers: Story takes a third of it, Hard adds half again. A fight far beyond the party takes less
// still (worth.ts damageToPartyFor), set when it starts and only lowered after, as the party sees more of it
// through the fog (fog.ts).
export const DAMAGE_TO_PARTY = { story: 1 / 3, normal: 1, hard: 1.5 } as const;

export function damageToParty(state: DndState): number {
  return (
    state.combat?.damageToParty ?? DAMAGE_TO_PARTY[state.difficulty ?? "normal"]
  );
}

function scaledForParty(
  target: Actor,
  amount: number,
  state: DndState,
): number {
  if (target.side !== "party" || amount <= 0) return amount;
  return Math.max(1, Math.round(amount * damageToParty(state)));
}

export function damageEvents(
  target: Actor,
  rolled: number,
  type: Damage["type"],
  critical: boolean,
  context: Context,
): SystemEvent[] {
  if (rolled < 0) return absorbedEvents(target, -rolled, context);
  const amount = scaledForParty(target, rolled, context.state);
  if (amount <= 0) return [];
  const stats = deriveStats(target, context);
  return [
    ...takenEvents(target, amount, type, critical, context),
    ...afterDamageEvents(target, amount, type, stats, context),
  ];
}

// Damage absorbed heals instead.
function absorbedEvents(
  target: Actor,
  amount: number,
  context: Context,
): SystemEvent[] {
  const { maxHp } = deriveStats(target, context);
  const healed = cannotHeal(target)
    ? 0
    : Math.min(amount, maxHp - Math.max(target.hp, 0));
  return healed > 0
    ? [
        dndEvent(`${NS}:healed`, {
          actor: target.id,
          amount: healed,
          max: maxHp,
        }),
      ]
    : [];
}

// What a hit sets off on the creature it lands on: a yeti's Fear of Fire, or a troll's limb cut off.
function afterDamageEvents(
  target: Actor,
  amount: number,
  type: Damage["type"],
  stats: ReturnType<typeof deriveStats>,
  context: Context,
): SystemEvent[] {
  const events: SystemEvent[] = headDamageEvents(target, amount, type, stats);
  // A Cloak of Displacement stops working until the bearer's next turn starts.
  if (
    stats.passives.some(
      (passive) => passive.kind === "ward" && passive.suppressed === "damaged",
    ) &&
    !target.usedThisTurn.includes(WARD_DOWN)
  ) {
    events.push(
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key: WARD_DOWN }),
    );
  }
  for (const passive of stats.passives) {
    if (passive.kind === "onDamage" && passive.damage.includes(type)) {
      for (const modifier of passive.modifiers) {
        events.push(
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: `${target.id}:on-damage`,
              casterId: target.id,
              modifier,
              ends: "casterNextTurnEnd",
            },
          }),
        );
      }
    }
    const left = target.hp - amount;
    if (
      passive.kind === "severedLimbs" &&
      type === "slashing" &&
      amount >= passive.slashing &&
      left > 0 &&
      left * 2 <= stats.maxHp &&
      (target.resourcesSpent[passive.resource] ?? 0) < passive.uses
    ) {
      events.push(...severedEvents(target, passive, context));
    }
  }
  return events;
}

// shortcut: a single hit of the printed Slashing damage severs the limb at once, rather than the turn's total at its end.
function severedEvents(
  target: Actor,
  passive: Extract<Passive, { kind: "severedLimbs" }>,
  context: Context,
): SystemEvent[] {
  const monster = lookup(context, MonsterSchema, passive.monster);
  const count = target.resourcesSpent[passive.resource] ?? 0;
  return [
    dndEvent(`${NS}:resourceSpent`, {
      actor: target.id,
      resource: passive.resource,
    }),
    dndEvent(`${NS}:exhaustionChanged`, { actor: target.id, levels: 1 }),
    dndEvent(`${NS}:summoned`, {
      actor: {
        ...freshActor({
          id: `${target.id}:limb-${String(count + 1)}`,
          name: `${monster.name} ${String(count + 1)}`,
          side: target.side,
          source: { kind: "monster", statBlockId: passive.monster },
          hp: monster.hp,
          inventory: [],
        }),
        position:
          teleportSquares(target, 5, 0, context.state, context)[0] ??
          target.position,
      },
      after: target.id,
    }),
  ];
}

function takenEvents(
  target: Actor,
  amount: number,
  type: Damage["type"],
  critical: boolean,
  context: Context,
): SystemEvent[] {
  // Damage left over after reaching 0 HP kills a character if it's at least their maximum.
  const remaining = amount - target.tempHp - Math.max(0, target.hp);
  // A vampire warden that would drop turns to stone instead, with Hit Points to lose all over again.
  const stone = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "stoneRestoration",
  );
  if (
    stone?.kind === "stoneRestoration" &&
    target.hp > 0 &&
    remaining >= 0 &&
    !hasCondition(target, "petrified")
  ) {
    const { maxHp } = deriveStats(target, context);
    return [
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining,
        type,
        critical,
        massive: false,
      }),
      dndEvent(`${NS}:healed`, {
        actor: target.id,
        amount: Math.min(stone.hp, maxHp),
        max: maxHp,
      }),
      dndEvent(`${NS}:effectAdded`, {
        actor: target.id,
        effect: {
          sourceId: `${target.id}:stone`,
          casterId: target.id,
          modifier: { kind: "condition", condition: "petrified" },
          ends: "spellDuration",
        },
      }),
    ];
  }
  // Suppressed Lycanthropy: the creature that drops comes back at once as another, or as itself again.
  const reborn = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "reborn",
  );
  if (
    reborn?.kind === "reborn" &&
    target.hp > 0 &&
    remaining >= 0 &&
    target.source.kind === "monster" &&
    !target.id.endsWith(":reborn") // only once
  ) {
    const id = reborn.monster ?? target.source.statBlockId;
    const monster = lookup(context, MonsterSchema, id);
    const hp = reborn.hp === "full" ? monster.hp : Math.floor(monster.hp / 2);
    return [
      dndEvent(`${NS}:damaged`, {
        actor: target.id,
        amount: amount - remaining,
        type,
        critical,
        massive: false,
      }),
      { kind: "actorDefeated", actor: target.id },
      dndEvent(`${NS}:summoned`, {
        actor: {
          ...freshActor({
            id: `${target.id}:reborn`,
            name: reborn.monster ? monster.name : target.name,
            side: target.side,
            source: { kind: "monster", statBlockId: id },
            hp,
            inventory: [],
          }),
          position: target.position,
        },
        after: target.id,
      }),
    ];
  }
  const fortitude =
    target.hp > 0 &&
    remaining >= 0 &&
    !critical &&
    deriveStats(target, context).passives.some(
      (passive) =>
        passive.kind === "undeadFortitude" &&
        !(passive.except ?? ["radiant"]).includes(type),
    )
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
  const tried = fortitude
    ? null
    : enduredEvents(target, amount, remaining, { type, critical }, context);
  if (tried?.endured) return [...tried.rolled, ...tried.endured];
  const massive =
    target.side === "party" && remaining >= deriveStats(target, context).maxHp;
  const events: SystemEvent[] = [
    ...(fortitude?.events ?? []),
    ...(tried?.rolled ?? []),
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

// A hit that would drop the target to 0 Hit Points without killing it outright leaves it at 1 instead, or at a trait's
// `hp`, as Relentless Endurance or Relentless Rage do: the events, or null when nothing holds it. Death Ward comes
// first, then the target's own traits, then an ally's that hold for allies too, as Gift of the Protectors. `rolled`
// holds the saves tried on the way, which stand either way.
function enduredEvents(
  target: Actor,
  amount: number,
  remaining: number,
  hit: { readonly type: DamageType; readonly critical: boolean },
  context: Context,
): { rolled: SystemEvent[]; endured: SystemEvent[] | null } | null {
  if (target.hp <= 0 || remaining < 0) return null;
  const toOne = amount - remaining - 1;
  const ward = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "deathWard",
  );
  if (ward) {
    return {
      rolled: [],
      endured: [
        dndEvent(`${NS}:effectEnded`, {
          actor: target.id,
          sourceId: ward.sourceId,
        }),
        dndEvent(`${NS}:damaged`, {
          actor: target.id,
          amount: toOne,
          ...hit,
          massive: false,
        }),
      ],
    };
  }
  const stats = deriveStats(target, context);
  if (target.side === "party" && remaining >= stats.maxHp) return null;
  const bearers = [
    target,
    ...Object.values(context.state.actors).filter(
      (other) =>
        other.id !== target.id && other.side === target.side && !isDead(other),
    ),
  ];
  const rolled: SystemEvent[] = [];
  for (const bearer of bearers) {
    const own = deriveStats(bearer, context);
    for (const trait of own.passives) {
      // Soul of Artifice's Cheat Death: its Uncommon and Rare replicated items, in place of a use.
      const artifice =
        trait.kind === "dropToOne" && trait.replicated !== undefined
          ? (bearer.replicated ?? []).filter((id) => {
              const item = ItemSchema.safeParse(context.content(id)).data;
              return (
                item !== undefined &&
                "rarity" in item &&
                (item.rarity === "uncommon" || item.rarity === "rare")
              );
            })
          : [];
      if (
        trait.kind !== "dropToOne" ||
        (bearer !== target && !trait.allies) ||
        (trait.replicated !== undefined
          ? artifice.length === 0
          : (bearer.resourcesSpent[trait.resource] ?? 0) >=
            (own.resources[trait.resource] ?? 0)) ||
        trait.except?.includes(hit.type) ||
        (trait.notCritical && hit.critical) ||
        (trait.reaction && (!bearer.budget.reaction || isDown(bearer))) ||
        (trait.within !== undefined &&
          distanceFeet(bearer.position, target.position) > trait.within) ||
        (trait.while &&
          !bearer.activeEffects.some(({ sourceId }) =>
            trait.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
          ))
      ) {
        continue;
      }
      if (trait.save) {
        const save = rollSave(
          target,
          trait.save.ability,
          trait.save.dc +
            (trait.save.step ?? 0) *
              (bearer.resourcesSpent[trait.resource] ?? 0) +
            (trait.save.plusDamage ? amount : 0),
          context,
        );
        rolled.push(...save.events);
        if (!save.saved) continue;
      }
      const hp = trait.replicated
        ? Math.min(stats.maxHp, trait.replicated * artifice.length)
        : trait.hp
          ? Math.min(stats.maxHp, Math.max(1, evaluateFormula(trait.hp, own)))
          : 1;
      const endured = [
        ...(trait.replicated
          ? [
              ...artifice.map((item) =>
                dndEvent(`${NS}:itemUsed`, { actor: bearer.id, item }),
              ),
              dndEvent(`${NS}:itemReplicated`, {
                actor: bearer.id,
                vanished: artifice,
              }),
            ]
          : [
              dndEvent(`${NS}:resourceSpent`, {
                actor: bearer.id,
                resource: trait.resource,
              }),
            ]),
        ...(trait.reaction
          ? [
              dndEvent(`${NS}:budgetSpent`, {
                actor: bearer.id,
                kind: "reaction",
              }),
            ]
          : []),
        // For a reaction right after it, as Orcish Fury's attack (combat/reactions.ts).
        dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key: ENDURED }),
        ...(trait.burst
          ? burstEvents(target, target, trait.burst, context)
          : []),
        dndEvent(`${NS}:damaged`, {
          actor: target.id,
          amount: toOne,
          ...hit,
          massive: false,
        }),
        ...(hp > 1
          ? [
              dndEvent(`${NS}:healed`, {
                actor: target.id,
                amount: hp - 1,
                max: stats.maxHp,
              }),
            ]
          : []),
        ...(trait.exhaustion
          ? [
              dndEvent(`${NS}:exhaustionChanged`, {
                actor: target.id,
                levels: trait.exhaustion,
              }),
            ]
          : []),
        ...trait.effects.map((modifier) =>
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: trait.resource,
              casterId: target.id,
              modifier,
              ends: "spellDuration",
            },
          }),
        ),
      ];
      return { rolled, endured };
    }
  }
  return { rolled, endured: null };
}

export const ENDURED = "endured";

// Damage to each foe of `source` within `radius` feet of `origin`, halved by a save against the source's spell save
// DC when there is one, as Necrotic Husk's Unholy Resuscitation, and with `blind` Blinded until the origin's turn ends,
// as Searing Vengeance. shortcut: no Concentration saves or reactions follow, as for a trap's damage.
export function burstEvents(
  origin: Actor,
  source: Actor,
  burst: {
    readonly radius: number;
    readonly save?: Ability | undefined;
    readonly damage: Amount;
    readonly type: DamageType;
    readonly blind?: boolean;
  },
  context: Context,
): SystemEvent[] {
  const stats = deriveStats(source, context);
  const dc = spellSaveDc(stats);
  return Object.values(context.state.actors).flatMap((foe) => {
    if (
      foe.side === source.side ||
      isDead(foe) ||
      !foe.position ||
      distanceFeet(origin.position, foe.position) > burst.radius
    ) {
      return [];
    }
    const save = burst.save
      ? rollSave(foe, burst.save, dc, context, true)
      : { saved: false, events: [] };
    const rolled = rollAmount(burst.damage, stats, context.dice);
    return [
      ...save.events,
      ...dealEvents(
        foe,
        [{ amount: save.saved ? halved(rolled) : rolled, type: burst.type }],
        false,
        context,
      ).events,
      ...(burst.blind
        ? [
            dndEvent(`${NS}:effectAdded`, {
              actor: foe.id,
              effect: {
                sourceId: `${source.id}:burst`,
                casterId: origin.id,
                modifier: { kind: "condition", condition: "blinded" },
                ends: "casterTurnEnd",
              },
            }),
          ]
        : []),
    ];
  });
}

// A Berserker Axe's fury: another creature's damage calls for a save, failed into a fury (combat/madness.ts).
function furyEvents(target: Actor, context: Context): SystemEvent[] {
  const damager = currentActor(context.state);
  if (
    target.hp <= 0 ||
    !damager ||
    damager.id === target.id ||
    target.activeEffects.some(({ modifier }) => modifier.kind === "furious")
  ) {
    return [];
  }
  const fury = deriveStats(target, context).passives.find(
    (passive) => passive.kind === "fury",
  );
  if (fury?.kind !== "fury") return [];
  const save = rollSave(target, fury.ability, fury.dc, context, true);
  return [
    ...save.events,
    ...(save.saved
      ? []
      : [
          dndEvent(`${NS}:effectAdded`, {
            actor: target.id,
            effect: {
              sourceId: "fury",
              casterId: target.id,
              modifier: {
                kind: "furious",
                ...(fury.damager ? { at: damager.id } : {}),
              },
              ends: "spellDuration",
            },
          }),
        ]),
  ];
}

export function dealEvents(
  target: Actor,
  hits: readonly { readonly amount: number; readonly type: Damage["type"] }[],
  critical: boolean,
  context: Context,
  source?: Actor, // the creature dealing it, for a reaction aimed back at it, as Backlash's
  magical = false, // a spell's, for Magic Absorption
): { events: SystemEvent[]; dealt: number } {
  let { state } = context;
  const events: SystemEvent[] = [];
  let dealt = 0;
  for (const given of hits) {
    const current = state.actors[target.id] ?? target;
    // Elemental Bane: the first damage of its type each turn deals more.
    const baned = baneExtra(current, given, { ...context, state });
    const hit = { ...given, amount: given.amount + baned.amount };
    const reduced = reducedHit(
      current,
      hit.amount,
      hit.type,
      { ...context, state },
      magical,
    );
    // A reaction such as Vitality Ward may lessen it before it lands.
    const lessened = beforeDamage(
      current,
      reduced.amount,
      hit.type,
      { ...context, state },
      source && (state.actors[source.id] ?? source),
    );
    const { amount, type } = { ...hit, amount: lessened.amount };
    // Thought Shield: the creature that dealt it takes the same.
    const mirrored =
      source &&
      source.id !== target.id &&
      amount > 0 &&
      deriveStats(current, context).passives.some(
        (passive) => passive.kind === "mirrorDamage" && passive.damage === type,
      )
        ? damageEvents(state.actors[source.id] ?? source, amount, type, false, {
            ...context,
            state,
          })
        : [];
    // Warding Bond: its caster takes as much.
    const bonded =
      amount > 0
        ? current.activeEffects.flatMap(({ modifier, casterId }) => {
            const caster = state.actors[casterId];
            return modifier.kind === "bonded" &&
              caster &&
              caster.id !== current.id &&
              !isDown(caster)
              ? damageEvents(caster, amount, type, false, { ...context, state })
              : [];
          })
        : [];
    for (const event of [
      ...baned.events,
      ...reduced.events,
      ...lessened.events,
      ...damageEvents(current, amount, type, critical, { ...context, state }),
      ...mirrored,
      ...bonded,
    ]) {
      events.push(event);
      if (state.actors[target.id]) state = applyDndEvent(state, event);
    }
    dealt += Math.max(0, scaledForParty(target, amount, context.state));
  }
  // Dragon Fear: damage lets the target repeat the save that ends the effect.
  const hurt = state.actors[target.id];
  if (hurt && dealt > 0)
    events.push(...furyEvents(hurt, { ...context, state }));
  // Killer's Fortune: a foe dropping gives the bearer's next attack Advantage.
  if (hurt && hurt.hp <= 0 && target.hp > 0) {
    for (const bearer of Object.values(state.actors)) {
      if (
        bearer.side === target.side ||
        isDown(bearer) ||
        !hasPassive(deriveStats(bearer, context), "killAdvantage")
      ) {
        continue;
      }
      events.push(
        dndEvent(`${NS}:effectAdded`, {
          actor: bearer.id,
          effect: {
            sourceId: "killers-fortune",
            casterId: bearer.id,
            modifier: { kind: "advantage", on: "attacks", once: true },
            ends: "casterNextTurnEnd",
          },
        }),
      );
    }
    events.push(...killEvents(target, { ...context, state }));
    events.push(...transferEvents(target, { ...context, state }));
    if (!isDead(hurt))
      events.push(...downedEvents(hurt, { ...context, state }));
  }
  const resaved = new Set<string>();
  for (const effect of dealt > 0 ? (hurt?.activeEffects ?? []) : []) {
    if (!hurt || !effect.saveOnDamage) continue;
    // One save for each source, as Hideous Laughter's Prone and Incapacitated end together.
    const key = `${effect.sourceId}|${effect.casterId}`;
    if (resaved.has(key)) continue;
    resaved.add(key);
    const save = rollSave(
      hurt,
      effect.saveOnDamage.ability,
      effect.saveOnDamage.dc,
      { ...context, state },
      effect.sourceId.startsWith("spell:"),
      0,
      [],
      false,
      effect.saveOnDamage.advantage === true,
    );
    events.push(...save.events);
    if (save.saved) {
      events.push(
        dndEvent(`${NS}:effectEnded`, {
          actor: hurt.id,
          sourceId: effect.sourceId,
          casterId: effect.casterId,
        }),
      );
    }
  }
  // Cackle Fever: damage other than Psychic sets off a fit of laughter on a failed save (environment.ts).
  const fits = hurt?.activeEffects.find(
    ({ modifier }) => modifier.kind === "laughter",
  );
  if (
    hurt &&
    dealt > 0 &&
    fits?.modifier.kind === "laughter" &&
    !isDead(hurt) &&
    !hasCondition(hurt, "incapacitated") &&
    hits.some(({ type, amount }) => type !== "psychic" && amount > 0)
  ) {
    const { dc, damage } = fits.modifier;
    const save = rollSave(hurt, "con", dc, { ...context, state });
    events.push(...save.events);
    if (!save.saved) {
      const laughed = dealEvents(
        hurt,
        damage.map(({ amount, type }) => ({
          amount: amount.dice ? rollDiceNotation(amount.dice, context.dice) : 0,
          type,
        })),
        false,
        { ...context, state },
      );
      events.push(
        ...laughed.events,
        dndEvent(`${NS}:effectAdded`, {
          actor: hurt.id,
          effect: {
            sourceId: `${fits.sourceId}:laughter`,
            casterId: hurt.id,
            modifier: { kind: "condition", condition: "incapacitated" },
            ends: "spellDuration",
            repeatSave: { ability: "con", dc },
            ...lastsFor({ minutes: 1 }, hurt, hurt, state),
          },
        }),
      );
    }
  }
  return { events, dealt };
}

// Resistance (the cantrip): damage of the type picked is cut by a die, once a turn. A worn item's cuts it every time,
// as a Ring of Warmth's 2d8 off Cold damage.
function reducedHit(
  target: Actor,
  amount: number,
  type: Damage["type"],
  context: Context,
  magical = false,
): { amount: number; events: SystemEvent[] } {
  const targetStats = deriveStats(target, context);
  // Spell Resistance: a spell's damage is halved, unless the bearer resists its type already.
  if (
    magical &&
    hasPassive(targetStats, "spellDamageResistance") &&
    !damageResponses(target, context).resistances.includes(type)
  ) {
    amount = Math.floor(amount / 2);
  }
  const { combat } = context.state;
  const turnKey = (id: string) =>
    `${id}@${String(combat?.round ?? 0)}:${String(combat?.index ?? 0)}`;
  const worn = passiveModifiers(targetStats.passives).find(
    (modifier) =>
      modifier.kind === "damageReduction" &&
      (modifier.damage === undefined || modifier.damage === type) &&
      (!modifier.magical || magical) &&
      (!modifier.oncePerTurn ||
        !target.usedThisTurn.includes(turnKey("damage-reduction"))) &&
      (!modifier.able || !hasCondition(target, ...INCAPACITATING)),
  );
  const wornEvents: SystemEvent[] = [];
  if (worn?.kind === "damageReduction" && amount > 0) {
    // Burning Life Force: Hit Point Dice spent for more.
    const burned = worn.hitDice
      ? spendHitDice(
          target,
          Math.max(1, evaluateFormula(worn.hitDice, targetStats)),
          context,
        )
      : null;
    if (burned) wornEvents.push(...burned.events);
    amount = Math.max(
      0,
      amount -
        rollAmount(worn.amount, targetStats, context.dice) -
        (burned?.total ?? 0),
    );
    if (worn.oncePerTurn) {
      wornEvents.push(
        dndEvent(`${NS}:oncePerTurnUsed`, {
          actor: target.id,
          key: turnKey("damage-reduction"),
        }),
      );
    }
  }
  // Bastion of Law: as many of the ward's dice as the damage needs, on average, spent and rolled.
  // shortcut: a hit of two damage types reads the ward as it was before the hit for each.
  const ward = target.activeEffects.find(
    ({ modifier }) => modifier.kind === "wardDice",
  );
  if (ward?.modifier.kind === "wardDice" && amount > 0) {
    const { count, die } = ward.modifier;
    const spend = Math.min(count, Math.ceil(amount / ((die + 1) / 2)));
    let cut = 0;
    for (let left = spend; left > 0; left--) cut += context.dice.roll(die);
    amount = Math.max(0, amount - cut);
    wornEvents.push(
      dndEvent(`${NS}:effectEnded`, {
        actor: target.id,
        sourceId: ward.sourceId,
        casterId: ward.casterId,
      }),
      ...(count > spend
        ? [
            dndEvent(`${NS}:effectAdded`, {
              actor: target.id,
              effect: {
                ...ward,
                modifier: { ...ward.modifier, count: count - spend },
              },
            }),
          ]
        : []),
    );
  }
  const effect = target.activeEffects.find(
    ({ modifier }) =>
      modifier.kind === "damageReduction" && modifier.damage === type,
  );
  if (effect?.modifier.kind !== "damageReduction" || amount <= 0) {
    return { amount, events: wornEvents };
  }
  // usedThisTurn clears only as the bearer's own turn starts, so the key names the turn.
  const key = turnKey(effect.sourceId);
  if (target.usedThisTurn.includes(key)) {
    return { amount, events: wornEvents };
  }
  const cut = rollAmount(
    effect.modifier.amount,
    deriveStats(target, context),
    context.dice,
  );
  return {
    amount: Math.max(0, amount - cut),
    events: [
      ...wornEvents,
      dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key }),
    ],
  };
}

// Half the damage an action deals comes back to its user as Hit Points, as Vampiric Touch's.
export function siphoned(
  action: KnownAction,
  user: Actor,
  dealt: number,
  stats: Stats,
): SystemEvent[] {
  if (!action.activation.siphon || dealt <= 0 || isDead(user)) return [];
  const missing = stats.maxHp - Math.max(user.hp, 0);
  const amount = Math.min(Math.floor(dealt / 2), missing);
  return amount > 0
    ? [dndEvent(`${NS}:healed`, { actor: user.id, amount, max: stats.maxHp })]
    : [];
}

// Elemental Bane's extra damage on the first hit of its type on a turn, from its caster's numbers.
function baneExtra(
  target: Actor,
  hit: { readonly amount: number; readonly type: Damage["type"] },
  context: Context,
): { amount: number; events: SystemEvent[] } {
  const { combat } = context.state;
  const turn = `@${String(combat?.round ?? 0)}:${String(combat?.index ?? 0)}`;
  let amount = 0;
  const events: SystemEvent[] = [];
  for (const { modifier, sourceId, casterId } of target.activeEffects) {
    const key = `bane:${sourceId}${turn}`;
    if (
      modifier.kind !== "bane" ||
      modifier.damage !== hit.type ||
      hit.amount <= 0 ||
      target.usedThisTurn.includes(key)
    ) {
      continue;
    }
    const caster = context.state.actors[casterId] ?? target;
    amount += rollAmount(
      modifier.amount,
      deriveStats(caster, context),
      context.dice,
    );
    events.push(dndEvent(`${NS}:oncePerTurnUsed`, { actor: target.id, key }));
  }
  return { amount, events };
}
