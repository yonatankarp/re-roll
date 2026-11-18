// What features change about the spells a creature casts.
import type { ContentAccess } from "#sdk";
import type { Actor } from "../state.ts";
import {
  type Ability,
  type Activation,
  type DamageType,
  type LeafEffect,
  type Passive,
  SpellSchema,
} from "../schemas.ts";
import { keepsHidden } from "../metamagic.ts";
import { spellOfSource } from "../combat/ids.ts";
import { maybeLookup, lookup } from "./content.ts";
import type { KnownAction, Stats } from "./model.ts";
import { onList } from "./spell-lists.ts";

// The activation with `bonus` added to each save DC worked out from its caster's spellcasting, as a Rod of the Pact
// Keeper's for a Warlock spell.
export function withDcBonus(activation: Activation, bonus: number): Activation {
  return JSON.parse(JSON.stringify(activation), (_key, value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    "add" in value &&
    Array.isArray(value.add) &&
    value.add.some(
      (term: unknown) =>
        typeof term === "object" &&
        term !== null &&
        "kind" in term &&
        term.kind === "spellSaveDc",
    )
      ? {
          ...value,
          base:
            ("base" in value && typeof value.base === "number"
              ? value.base
              : 0) + bonus,
        }
      : value,
  ) as Activation;
}

// A feature's changes to a spell: its hit damage's die (Foe Slayer) and effects it adds (Eldritch Hex).
export function spellChanged(
  activation: Activation,
  dice: string | undefined,
  adds: readonly LeafEffect[] | undefined,
): Activation {
  const { resolution } = activation;
  if (resolution.kind !== "automatic" || (!dice && !adds)) return activation;
  const effects = resolution.effects.map((effect): LeafEffect =>
    dice &&
    effect.kind === "modifier" &&
    effect.modifier.kind === "hitDamage" &&
    effect.modifier.damage.amount.dice
      ? {
          ...effect,
          modifier: {
            ...effect.modifier,
            damage: {
              ...effect.modifier.damage,
              amount: { ...effect.modifier.damage.amount, dice },
            },
          },
        }
      : effect,
  );
  return {
    ...activation,
    resolution: { ...resolution, effects: [...effects, ...(adds ?? [])] },
  };
}

// Cold Fire Magic: a spell's damage takes another type.
export function retyped(activation: Activation, type: DamageType): Activation {
  const { resolution } = activation;
  const swap = <T extends { readonly type: DamageType }>(list: readonly T[]) =>
    list.map((item) => ({ ...item, type }));
  return {
    ...activation,
    resolution:
      resolution.kind === "attack" && resolution.onHitSave
        ? {
            ...resolution,
            damage: swap(resolution.damage),
            onHitSave: {
              ...resolution.onHitSave,
              damage: swap(resolution.onHitSave.damage),
            },
          }
        : { ...resolution, damage: swap(resolution.damage) },
  };
}

// A feat's spell cast with its own ability: its save DC, spell attack and spellcasting modifier.
export function castWith(activation: Activation, ability: Ability): Activation {
  const mapped = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((item) => mapped(item));
    if (value === null || typeof value !== "object") return value;
    const copy: Record<string, unknown> = Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, mapped(item, name)]),
    );
    const spellTerm = copy.kind === "spellMod" || copy.kind === "spellSaveDc";
    const spellAttack = key === "attack" && copy.type === "spell";
    return (spellTerm || spellAttack) && copy.ability === undefined
      ? { ...copy, ability }
      : copy;
  };
  return mapped(activation) as Activation;
}

// Potent Cantrip: a damaging cantrip's miss or successful save still deals half its damage.
export function withPotentCantrips(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  if (!passives.some((passive) => passive.kind === "potentCantrip")) {
    return [...actions];
  }
  return actions.map((action) => {
    const { resolution } = action.activation;
    if (
      action.spellLevel !== 0 ||
      spellOfSource(action.id) === null ||
      resolution.damage.length === 0
    ) {
      return action;
    }
    const potent =
      resolution.kind === "save" && resolution.onSuccessDamage === "none"
        ? { ...resolution, onSuccessDamage: "half" as const }
        : resolution.kind === "attack" && !resolution.missDamage
          ? { ...resolution, missDamage: "half" as const }
          : resolution;
    return potent === resolution
      ? action
      : { ...action, activation: { ...action.activation, resolution: potent } };
  });
}

// Whether this cast needs no components (`silentCasting`, or Subtle Spell waiting on it), so nobody sees it cast.
export function castsSilently(
  actor: Actor,
  action: KnownAction,
  stats: Pick<Stats, "passives">,
  access: ContentAccess,
): boolean {
  if (keepsHidden(actor, action.id)) return true;
  const spellId = spellOfSource(action.id);
  if (spellId === null) return false;
  const spell = maybeLookup(access, SpellSchema, spellId);
  return stats.passives.some(
    (passive) =>
      passive.kind === "silentCasting" &&
      (!passive.schools || (spell && passive.schools.includes(spell.school))) &&
      (!passive.list || onList(spellId, spell, passive.list, access)) &&
      (!passive.spells || passive.spells.includes(spellId)) &&
      (!passive.slot || action.activation.cost.includes("slot")) &&
      (!passive.via ||
        (/:free(:|$)/.test(action.id) &&
          action.activation.cost.some(
            (cost) =>
              typeof cost === "object" &&
              "resource" in cost &&
              cost.resource === passive.via,
          ))),
  );
}

// Spells whose damage may take other types (`spellTypes`), the least resisted dealt.
export function withSpellTypes(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
  access: ContentAccess,
  usesLeft: (resource: string) => boolean,
): KnownAction[] {
  const changes = passives.flatMap((passive, index) =>
    passive.kind === "spellTypes" &&
    !(
      passive.oncePerTurn &&
      actor.usedThisTurn.includes(`spellTypes:${String(index)}`)
    ) &&
    !(passive.resource && !usesLeft(passive.resource))
      ? [{ passive, key: `spellTypes:${String(index)}` }]
      : [],
  );
  if (changes.length === 0) return [...actions];
  return actions.map((action) => {
    const spellId = spellOfSource(action.id);
    const { resolution } = action.activation;
    if (spellId === null || resolution.damage.length === 0) return action;
    const spell = maybeLookup(access, SpellSchema, spellId);
    const fitting = changes.filter(
      ({ passive }) =>
        !passive.list || onList(spellId, spell, passive.list, access),
    );
    if (fitting.length === 0) return action;
    const add = fitting.flatMap(({ passive }) => passive.add);
    const damage = resolution.damage.map((item) => ({
      ...item,
      types: [...new Set([...(item.types ?? [item.type]), ...add])],
    }));
    const keys = fitting.flatMap(({ passive, key }) =>
      passive.oncePerTurn ? [key] : [],
    );
    const spends = fitting.flatMap(({ passive }) =>
      passive.resource ? [{ resource: passive.resource }] : [],
    );
    return {
      ...action,
      activation: {
        ...action.activation,
        cost: [...action.activation.cost, ...spends],
        resolution: { ...resolution, damage },
      },
      ...(keys.length > 0
        ? { onceKeys: [...(action.onceKeys ?? []), ...keys] }
        : {}),
    };
  });
}

// Spells cast with a Bonus Action in place of an action (`castsAs`), and attack spells reaching farther
// (`spellRange`).
export function withCastsAs(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  const farther = passives.reduce(
    (sum, passive) =>
      passive.kind === "spellRange" ? sum + passive.feet : sum,
    0,
  );
  const reached =
    farther === 0
      ? actions
      : actions.map((action) => {
          const { targeting, resolution } = action.activation;
          return spellOfSource(action.id) !== null &&
            resolution.kind === "attack" &&
            "range" in targeting &&
            typeof targeting.range === "number" &&
            targeting.range >= 10
            ? {
                ...action,
                activation: {
                  ...action.activation,
                  targeting: { ...targeting, range: targeting.range + farther },
                },
              }
            : action;
        });
  return castsAs(reached, passives);
}

function castsAs(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  const quick = passives.flatMap((passive) =>
    passive.kind === "castsAs" ? (passive.spells ?? ["*"]) : [],
  );
  if (quick.length === 0) return [...actions];
  // With no spells named, every spell, as Elder Champion's Swift Spells.
  return actions.map((action) => {
    const spell = spellOfSource(action.id);
    return spell !== null && (quick.includes(spell) || quick.includes("*"))
      ? {
          ...action,
          activation: {
            ...action.activation,
            cost: action.activation.cost.map((cost) =>
              cost === "action" ? "bonusAction" : cost,
            ),
          },
        }
      : action;
  });
}

// Spells that reach more creatures (`extraTarget`).
export function withExtraTargets(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
): KnownAction[] {
  const extra = passives.filter((passive) => passive.kind === "extraTarget");
  if (extra.length === 0) return [...actions];
  return actions.map((action) => {
    const spell = spellOfSource(action.id);
    const { targeting } = action.activation;
    const more = extra.reduce(
      (sum, item) =>
        spell !== null && item.spells.includes(spell)
          ? sum + item.creatures
          : sum,
      0,
    );
    return more > 0 && "creatures" in targeting
      ? {
          ...action,
          activation: {
            ...action.activation,
            targeting: { ...targeting, creatures: targeting.creatures + more },
          },
        }
      : action;
  });
}

// Spells with a `spellDamage` bonus added to their damage, while its once-a-turn use (and its resource) is left.
export function withSpellDamage(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
  access: ContentAccess,
  usesLeft: (resource: string) => boolean,
): KnownAction[] {
  const bonuses = passives.flatMap((passive, index) =>
    passive.kind === "spellDamage" &&
    !(
      passive.oncePerTurn &&
      actor.usedThisTurn.includes(`spellDamage:${String(index)}`)
    ) &&
    !(passive.resource && !usesLeft(passive.resource))
      ? [{ passive, key: `spellDamage:${String(index)}` }]
      : [],
  );
  if (bonuses.length === 0) return [...actions];
  return actions.map((action) => {
    const spellId = spellOfSource(action.id);
    if (action.spellLevel === null || spellId === null) return action;
    const spell = maybeLookup(access, SpellSchema, spellId);
    let { resolution, cost } = action.activation;
    const keys: string[] = [];
    for (const { passive, key } of bonuses) {
      if (passive.spells && !passive.spells.includes(spellId)) continue;
      if (passive.schools && !(spell && passive.schools.includes(spell.school)))
        continue;
      if (passive.list && !onList(spellId, spell, passive.list, access))
        continue;
      if (passive.slot && !cost.includes("slot")) continue;
      const at = resolution.damage.findIndex(
        (item) => !passive.types || passive.types.includes(item.type),
      );
      const entry = resolution.damage[at];
      if (!entry) continue;
      const { bonus, dice } = passive;
      // Damage of its own, with dice or in its own `type`, as Alchemical Eruption's 2d8 Force or Power Surge's Force.
      const apart = dice !== undefined || passive.type !== undefined;
      const raised = resolution.damage.map((item, index) =>
        index === at && bonus && !apart
          ? {
              ...item,
              amount: {
                ...item.amount,
                bonus: {
                  base: (item.amount.bonus?.base ?? 0) + bonus.base,
                  add: [...(item.amount.bonus?.add ?? []), ...bonus.add],
                  ...(bonus.min === undefined ? {} : { min: bonus.min }),
                },
              },
            }
          : item,
      );
      const damage = apart
        ? [
            ...raised,
            {
              amount: {
                ...(dice ? { dice } : {}),
                ...(bonus ? { bonus } : {}),
              },
              type: passive.type ?? entry.type,
            },
          ]
        : raised;
      resolution = { ...resolution, damage };
      if (passive.resource) cost = [...cost, { resource: passive.resource }];
      if (passive.oncePerTurn) keys.push(key);
    }
    return keys.length === 0 && resolution === action.activation.resolution
      ? action
      : {
          ...action,
          activation: { ...action.activation, resolution, cost },
          ...(keys.length > 0
            ? { onceKeys: [...(action.onceKeys ?? []), ...keys] }
            : {}),
        };
  });
}

// A feature's activations with the effects other features ride on them, as Tactical Shift's move on Second Wind.
// Improved Mystic Fighting Style: a spell of the levels and class list named, that takes an action, can also be cast
// with the passive's costs, as part of the Bonus Action of Flurry of Blows.
export function castWithVariants(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  access: ContentAccess,
): readonly KnownAction[] {
  const ways = passives.flatMap((passive) =>
    passive.kind === "castWith" ? [passive] : [],
  );
  if (ways.length === 0) return actions;
  const extra = actions.flatMap((action) => {
    const [, spellId] = /^spell:([^:]+:[^:]+)$/.exec(action.id) ?? [];
    if (!spellId || action.spellLevel === null) return [];
    if (!action.activation.cost.includes("action")) return [];
    const spell = lookup(access, SpellSchema, spellId);
    return ways.flatMap((way) =>
      way.levels.includes(action.spellLevel ?? -1) &&
      spell.classes.includes(way.list)
        ? [
            {
              ...action,
              id: `${action.id}:with`,
              name: `${action.name} (${way.label})`,
              activation: {
                ...action.activation,
                cost: [
                  ...action.activation.cost.filter((cost) => cost !== "action"),
                  ...way.cost,
                ],
              },
            },
          ]
        : [],
    );
  });
  return extra.length === 0 ? actions : [...actions, ...extra];
}

export function withRiders(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  actor: Actor,
): KnownAction[] {
  return actions.map((given) => {
    let action = given;
    const { resolution } = action.activation;
    const riders = passives.flatMap((passive) =>
      passive.kind === "activationRider" &&
      action.id.startsWith(`feature:${passive.feature}:`) &&
      (passive.label === undefined ||
        action.activation.label === passive.label) &&
      (!passive.while ||
        actor.activeEffects.some(({ sourceId }) =>
          passive.while?.some((id) => sourceId.startsWith(`feature:${id}:`)),
        ))
        ? [passive]
        : [],
    );
    const extra = riders.flatMap(({ effects }) => effects);
    const damage = riders.flatMap(({ damage: more }) => more ?? []);
    const own = riders.flatMap(({ self }) => self ?? []);
    const allies = riders.flatMap(({ allies: rider }) =>
      rider ? [rider] : [],
    );
    if (allies.length > 0) {
      action = {
        ...action,
        activation: {
          ...action.activation,
          alsoAllies: [...(action.activation.alsoAllies ?? []), ...allies],
        },
      };
    }
    if (own.length > 0) {
      action = {
        ...action,
        activation: {
          ...action.activation,
          alsoSelf: [...(action.activation.alsoSelf ?? []), ...own],
        },
      };
    }
    // On a save, whether it succeeds or fails, as Focused Strike's with Stunning Strike.
    if (resolution.kind === "save" && (damage.length > 0 || extra.length > 0)) {
      return {
        ...action,
        activation: {
          ...action.activation,
          resolution: {
            ...resolution,
            damage: [...resolution.damage, ...damage],
            onFail: [...resolution.onFail, ...extra],
            onSuccess: [...resolution.onSuccess, ...extra],
          },
        },
      };
    }
    return extra.length === 0 || resolution.kind !== "automatic"
      ? action
      : {
          ...action,
          activation: {
            ...action.activation,
            resolution: {
              ...resolution,
              effects: [...resolution.effects, ...extra],
            },
          },
        };
  });
}
