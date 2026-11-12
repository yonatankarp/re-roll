import type { Activation, Amount, Formula, Passive } from "./schemas.ts";
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
function cantripFor(
  actions: readonly KnownAction[],
  rider: CantripRider,
): KnownAction | undefined {
  const worth = (action: KnownAction): number =>
    action.activation.resolution.damage.reduce(
      (sum, item) => sum + averageOf(item.amount),
      0,
    ) * (action.activation.projectiles ?? 1);
  return actions
    .filter(
      (action) =>
        action.spellLevel === 0 &&
        action.id.startsWith("spell:") &&
        action.activation.resolution.damage.length > 0 &&
        (!rider.attackOnly || action.activation.resolution.kind === "attack"),
    )
    .sort((a, b) => worth(b) - worth(a))[0];
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
  return {
    ...activation,
    targeting:
      range && "range" in targeting && typeof targeting.range === "number"
        ? {
            ...targeting,
            range:
              targeting.range + range.feet * (classLevels[range.class] ?? 0),
          }
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
      targeting.range === 5;
    return pacts.length > 0 && melee
      ? {
          ...action,
          activation: pactWeapon(action.activation, pacts, scores.cha, scores),
        }
      : action;
  });
  for (const rider of riders) {
    const cantrip = cantripFor(shaped, rider);
    if (!cantrip) continue;
    shaped = shaped.map((action) =>
      action === cantrip
        ? {
            ...action,
            activation: ridden(action.activation, rider, classLevels),
          }
        : action,
    );
  }
  return shaped;
}
