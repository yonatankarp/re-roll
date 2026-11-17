import type { ContentAccess } from "#sdk";
import {
  type Activation,
  type Amount,
  type Formula,
  type Passive,
  SpellSchema,
} from "./schemas.ts";
import type { KnownAction } from "./stats.ts";

// Eldritch Invocations that change a character's own attacks: the pact weapon's (Pact of the Blade, Lifedrinker)
// and a damaging cantrip's (Agonizing Blast, Repelling Blast, Eldritch Spear). Applied as Stats are derived.

type PactWeapon = Extract<Passive, { kind: "pactWeapon" }>;
type CantripRider = Extract<Passive, { kind: "cantripRider" }>;

const modifier = (score: number): number => Math.floor((score - 10) / 2);

function averageOf(amount: Amount): number {
  const [count = "0", sides = "0"] = (amount.dice ?? "").split("d");
  return (Number(count) * (Number(sides) + 1)) / 2;
}

// shortcut: a rider goes to the known cantrip dealing the most damage rather than one the player names, and the
// cantrip may be from any class's list.
function cantripsFor(
  actions: readonly KnownAction[],
  rider: CantripRider,
  access: ContentAccess,
): readonly KnownAction[] {
  const worth = (action: KnownAction): number =>
    action.activation.resolution.damage.reduce(
      (sum, item) => sum + averageOf(item.amount),
      0,
    ) * (action.activation.projectiles ?? 1);
  const { list } = rider;
  const listed = (action: KnownAction): boolean =>
    list === undefined ||
    (SpellSchema.safeParse(
      access.content(action.id.slice("spell:".length)),
    ).data?.classes.some(
      (id) => id.split(":class/")[1] === list.split(":class/")[1],
    ) ??
      false);
  const fit = actions.filter(
    (action) =>
      action.spellLevel === 0 &&
      action.id.startsWith("spell:") &&
      action.activation.resolution.damage.length > 0 &&
      (!rider.attackOnly || action.activation.resolution.kind === "attack") &&
      listed(action),
  );
  if (list !== undefined) return fit;
  const best = fit.sort((a, b) => worth(b) - worth(a))[0];
  return best ? [best] : [];
}

function addedTo(bonus: Formula | undefined, more: Formula): Formula {
  return {
    base: (bonus?.base ?? 0) + more.base,
    add: [...(bonus?.add ?? []), ...more.add],
  };
}

function ridden(
  activation: Activation,
  rider: CantripRider,
  classLevels: Readonly<Record<string, number>>,
): Activation {
  const { resolution, targeting } = activation;
  const extra = rider.damage;
  const [first, ...rest] = resolution.damage;
  const damage =
    extra && first
      ? [
          {
            ...first,
            amount: {
              ...first.amount,
              bonus: addedTo(first.amount.bonus, extra),
            },
          },
          ...rest,
        ]
      : resolution.damage;
  const range = rider.rangePerLevel;
  const reach =
    "range" in targeting && typeof targeting.range === "number"
      ? targeting.range
      : 0;
  const added =
    (range ? range.feet * (classLevels[range.class] ?? 0) : 0) +
    (rider.range !== undefined && reach >= 10 ? rider.range : 0);
  return {
    ...activation,
    ...(rider.selfEffects
      ? {
          selfEffects: [
            ...(activation.selfEffects ?? []),
            ...rider.selfEffects,
          ],
        }
      : {}),
    targeting:
      added > 0 && "range" in targeting && typeof targeting.range === "number"
        ? { ...targeting, range: targeting.range + added }
        : targeting,
    resolution:
      resolution.kind === "attack"
        ? {
            ...resolution,
            damage,
            onHit: [...resolution.onHit, ...rider.onHit],
          }
        : { ...resolution, damage },
  };
}

function pactWeapon(
  activation: Activation,
  pacts: readonly PactWeapon[],
  charisma: number,
  scores: Readonly<Record<"str" | "dex", number>>,
): Activation {
  const { resolution } = activation;
  if (resolution.kind !== "attack" || resolution.attack.type !== "weapon") {
    return activation;
  }
  // A pact weapon is one the warlock is trained with, so `proficient: false` goes.
  const { ability = "str", ...attack } = resolution.attack;
  delete attack.proficient;
  const used =
    ability === "str" || ability === "dex" ? modifier(scores[ability]) : 0;
  const best = modifier(charisma) > used ? "cha" : ability;
  const damage = resolution.damage.map((item) => ({
    ...item,
    amount: {
      ...item.amount,
      ...(item.amount.bonus
        ? {
            bonus: {
              ...item.amount.bonus,
              add: item.amount.bonus.add.map((term) =>
                term.kind === "abilityMod" && term.ability === ability
                  ? { ...term, ability: best }
                  : term,
              ),
            },
          }
        : {}),
    },
  }));
  return {
    ...activation,
    resolution: {
      ...resolution,
      attack: { ...attack, ability: best },
      damage: [...damage, ...pacts.flatMap((item) => item.damage)],
    },
  };
}

// shortcut: every melee weapon carried counts as the pact weapon, and Lifedrinker's damage comes on every hit, not
// once a turn.
export function withInvocations(
  actions: readonly KnownAction[],
  passives: readonly Passive[],
  scores: Readonly<Record<"str" | "dex" | "cha", number>>,
  classLevels: Readonly<Record<string, number>>,
  access: ContentAccess,
): KnownAction[] {
  const pacts = passives.filter(
    (item): item is PactWeapon => item.kind === "pactWeapon",
  );
  const riders = passives.filter(
    (item): item is CantripRider => item.kind === "cantripRider",
  );
  let shaped = actions.map((action) => {
    const { targeting } = action.activation;
    const melee =
      action.id.startsWith("weapon:") &&
      "range" in targeting &&
      (targeting.range === 5 || ("reach" in targeting && targeting.reach));
    return pacts.length > 0 && melee
      ? {
          ...action,
          activation: pactWeapon(action.activation, pacts, scores.cha, scores),
        }
      : action;
  });
  for (const rider of riders) {
    const cantrips = cantripsFor(shaped, rider, access);
    if (cantrips.length === 0) continue;
    shaped = shaped.map((action) =>
      cantrips.includes(action)
        ? {
            ...action,
            activation: ridden(action.activation, rider, classLevels),
          }
        : action,
    );
  }
  return shaped;
}
