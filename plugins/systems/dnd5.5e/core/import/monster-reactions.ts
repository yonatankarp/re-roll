import type {
  Ability,
  Activation,
  Amount,
  DamageType,
  LeafEffect,
  Resolution,
} from "../schemas.ts";

// A stat block's Reactions entry, "Trigger: … Response: …", read into an activation whose trigger the engine
// answers (combat/reactions.ts). What it leaves out is said in `left`, and null means it reads none of it.

type Trigger = NonNullable<Activation["trigger"]>;
type Save = (
  text: string,
  left: string[],
) => { readonly targeting: unknown; readonly resolution: Resolution } | null;

export interface ReadReaction {
  readonly trigger: Trigger;
  readonly targeting: Activation["targeting"];
  readonly resolution: Resolution;
  readonly left: readonly string[];
}

const ABILITIES: Readonly<Record<string, Ability>> = {
  Strength: "str",
  Dexterity: "dex",
  Constitution: "con",
  Intelligence: "int",
  Wisdom: "wis",
  Charisma: "cha",
};
const TYPES =
  "acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder";

function typesIn(text: string): DamageType[] {
  return [
    ...text.toLowerCase().matchAll(new RegExp(`\\b(${TYPES})\\b`, "g")),
  ].map((match) => match[1] as DamageType);
}

// "11 (2d6 + 4)" or "5 (1d10)" as an amount.
function amountOf(text: string): Amount | null {
  const match = /\((\d+d\d+)(?:\s*\+\s*(\d+))?\)/.exec(text);
  if (!match?.[1]) return null;
  return {
    dice: match[1],
    ...(match[2] ? { bonus: { base: Number(match[2]), add: [] } } : {}),
  };
}

// When the reaction is taken, and whether it lands before the hit's damage (so it can turn the hit aside).
function triggerOf(text: string): {
  readonly trigger: Trigger;
  readonly before: boolean;
  readonly left?: string;
} | null {
  const t = text.trim().replace(/\.$/, "");
  const within = (match: RegExpExecArray | null, index = 1) =>
    match?.[index] ? { within: Number(match[index]) } : {};
  let m: RegExpExecArray | null;
  if (/makes an attack roll against (?:it|him|her|them)$/.test(t)) {
    return { trigger: { attacked: true }, before: true };
  }
  if (
    (m =
      /^(?:The [^.]*?|An attack roll hits (?:the )?[^.]*?) or a creature (?:it|he|she|they) can see within (\d+) feet$/.exec(
        t,
      ))
  ) {
    return {
      trigger: { hitByAttack: true, allyHit: true, within: Number(m[1]) },
      before: true,
    };
  }
  if (/^The [^.]*? or an ally it can see is hit with an attack roll$/.test(t)) {
    return {
      trigger: { hitByAttack: true, allyHit: true, within: 120 },
      before: true,
    };
  }
  if (
    (m =
      /^An attack roll hits the wearer of [^.]*? while the wearer is within (\d+) feet of [^.]*$/.exec(
        t,
      ))
  ) {
    return { trigger: { allyHit: true, within: Number(m[1]) }, before: true };
  }
  if (
    (m =
      /^A creature the [^.]*? can see hits an ally within (\d+) feet of the [^.]*? with an attack roll, or an ally within \d+ feet of the [^.]*? fails a saving throw against a spell or other magical effect$/.exec(
        t,
      ))
  ) {
    return {
      trigger: {
        rolled: { rolls: ["attack", "save"], by: "any", when: "any" },
        within: Number(m[1]),
      },
      before: true,
      left: "telling the rolls it answers apart",
    };
  }
  if (
    /^The [^.]*? fails a saving throw against a spell or another magical effect created by a creature$/.test(
      t,
    )
  ) {
    return { trigger: { ownSave: "failed" }, before: false };
  }
  if (
    /^The [^.]*? succeeds on a saving throw against a spell, or a spell's attack roll misses it$/.test(
      t,
    )
  ) {
    return {
      trigger: { ownSave: "succeeded", missed: true, bySpell: true },
      before: false,
    };
  }
  if (/^The [^.]*? or an ally it can see makes a D20 Test$/.test(t)) {
    return {
      trigger: {
        rolled: {
          rolls: ["attack", "save", "check"],
          by: "selfOrAlly",
          when: "any",
        },
      },
      before: true,
    };
  }
  if (
    (m =
      /^The [^.]*? or another creature within (\d+) feet makes an ability check or a saving throw$/.exec(
        t,
      ))
  ) {
    return {
      trigger: {
        rolled: { rolls: ["check", "save"], by: "any", when: "any" },
        within: Number(m[1]),
      },
      before: true,
    };
  }
  // "is hit by a melee attack roll while holding a weapon", "hits it with an attack roll", "An attack roll hits the
  // rust monster", "is hit by a ranged attack roll and takes Bludgeoning, Piercing, or Slashing damage from it".
  if (
    (m = new RegExp(
      `^(?:The [^.]*? is hit by an? (melee |ranged )?attack roll|A creature (?:the [^.]*? can see )?hits (?:it|him|her|them|the [^.]*?) with an? (melee |ranged )?attack roll|An attack roll hits the [^.]*?)(.*)$`,
    ).exec(t))
  ) {
    const kind = (m[1] ?? m[2] ?? "").trim();
    const rest = m[3] ?? "";
    const typed = /damage/i.test(rest) ? typesIn(rest) : [];
    return {
      trigger: {
        hitByAttack: true,
        ...(kind === "melee" ? { melee: true } : {}),
        ...(kind === "ranged" ? { ranged: true } : {}),
        ...(typed.length > 0 ? { damagedBy: typed } : {}),
      },
      before: true,
    };
  }
  if (
    /^A creature misses the [^.]*? with a melee attack roll(?: using a weapon)?$/.test(
      t,
    )
  ) {
    return { trigger: { missed: true, melee: true }, before: false };
  }
  if (
    (m =
      /^A Bloodied creature the [^.]*? can see within (\d+) feet takes damage$/.exec(
        t,
      ))
  ) {
    return {
      trigger: { otherDamaged: "bloodied", within: Number(m[1]) },
      before: false,
    };
  }
  if (
    (m =
      /^(?:The [^.]*? takes damage from a creature within (\d+) feet|A creature within (\d+) feet of the [^.]*? deals damage to (?:it|him|her|them))$/.exec(
        t,
      ))
  ) {
    return {
      trigger: { damaged: true, within: Number(m[1] ?? m[2]) },
      before: false,
    };
  }
  if ((m = /^The [^.]*? takes damage from a melee attack$/.exec(t))) {
    return { trigger: { damaged: true, melee: true }, before: false };
  }
  if (
    (m = new RegExp(
      `^The [^.]*? (?:takes|is subjected to) ((?:(?:${TYPES}),? (?:or )?)+)damage$`,
      "i",
    ).exec(t))
  ) {
    return {
      trigger: { damaged: true, damagedBy: typesIn(m[1] ?? "") },
      before: false,
    };
  }
  if (/^The [^.]*? takes damage$/.test(t)) {
    return { trigger: { damaged: true }, before: false };
  }
  if (
    (m =
      /^An enemy the [^.]*? can see enters a space within (\d+) feet of the [^.]*$/.exec(
        t,
      ))
  ) {
    return {
      trigger: { entersReach: true, ...within(m) },
      before: false,
    };
  }
  if (
    (m =
      /^Another creature the [^.]*? can see ends its move within (\d+) feet of the [^.]*$/.exec(
        t,
      ))
  ) {
    return { trigger: { endsMove: true, ...within(m) }, before: false };
  }
  if (
    (m =
      /^A creature the [^.]*? can see starts its turn within (\d+) feet of the [^.]*? and can see the [^.]*$/.exec(
        t,
      ))
  ) {
    return { trigger: { turnStart: true, ...within(m) }, before: false };
  }
  if (
    (m =
      /^A creature the [^.]*? can see within (\d+) feet of itself takes the Study action or makes a Constitution saving throw to maintain Concentration$/.exec(
        t,
      ))
  ) {
    return {
      trigger: { concentrationSave: true, ...within(m) },
      before: false,
    };
  }
  return null;
}

const SELF = { self: true } as const;

const rangeOf = (range: number | "self" | "touch"): number =>
  typeof range === "number" ? range : 5;

function automatic(effects: LeafEffect[]): Resolution {
  return { kind: "automatic", damage: [], effects };
}

// What the bearer does, read from the response's sentences. Each sentence it can't read goes to `left`.
function responseOf(
  response: string,
  trigger: Trigger,
  before: boolean,
  parseSave: Save,
  left: string[],
): {
  readonly targeting: Activation["targeting"];
  readonly resolution: Resolution;
} | null {
  // A save in the response, as "Response—Constitution Saving Throw: DC 16, each creature … Failure: …".
  const saveAt = response.search(
    /\b(?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) Saving Throw: DC \d+/,
  );
  if (saveAt > 0) {
    // "reduces the damage … Dexterity Saving Throw: …": the lead is what matters; what comes after it, as Deflect
    // Missile's redirected force or Toxic Escape's poison where it lands, is left out.
    const lead = responseOf(
      response.slice(0, saveAt),
      trigger,
      before,
      parseSave,
      [],
    );
    if (lead) {
      left.push("the save that follows it");
      return lead;
    }
  }
  if (/Saving Throw: DC \d+/.test(response)) {
    // "Failure: The attack roll misses …": the save turns the hit aside, as Jinx's or Warding Charm's does.
    const misses =
      /Failure:\s*The attack(?: roll)? misses(?: the [^,.]+)?(?: instead)?(?:\.|, and)\s*(.*)$/s.exec(
        response,
      );
    if (!misses) {
      // Sticky Shield: a weapon stuck to the shield holds its wielder as a grapple does.
      const stuck =
        /has the Grappled condition while the weapon is stuck \(escape DC (\d+)\)/.exec(
          response,
        );
      const text = stuck
        ? `${response.slice(0, response.indexOf("Failure:"))}Failure: The target has the Grappled condition (escape DC ${stuck[1] ?? ""}).`
        : response;
      if (stuck) left.push("the stuck weapon");
      const parsed = parseSave(text, left);
      return parsed?.resolution.kind === "save"
        ? {
            targeting: parsed.targeting as Activation["targeting"],
            resolution: ridersOf(response, parsed.resolution, left),
          }
        : null;
    }
    const head = /(\w+) Saving Throw: DC (\d+)/.exec(response);
    const ability = ABILITIES[head?.[1] ?? ""];
    if (!ability || !head?.[2]) return null;
    const rest = (misses[1] ?? "").trim();
    const extra = rest
      ? parseSave(
          `${response.slice(0, misses.index)}Failure: ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`,
          left,
        )
      : null;
    return {
      targeting: { creatures: 1, range: 120, side: "enemy" },
      resolution: {
        kind: "save",
        ability,
        dc: { base: Number(head[2]), add: [] },
        damage: [],
        onSuccessDamage: "none",
        onFail: [
          { kind: "negateHit" },
          ...(extra?.resolution.kind === "save" ? extra.resolution.onFail : []),
        ],
        onSuccess: [],
      },
    };
  }
  const effects: LeafEffect[] = [];
  let targeting: Activation["targeting"] = SELF;
  const sentences = response
    .split(/(?<=\.)\s+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const sentence of sentences) {
    const clauses = sentence
      .replace(/\.$/, "")
      .split(/,? and (?=(?:it|he|she|the|its)\b)/);
    for (const clause of clauses) {
      let m: RegExpExecArray | null;
      if (
        clause.includes("chooses a Small or Medium ally within 5 feet of") ||
        /chooses a Small or Medium creature within 5 feet of [^.]*? that has the Charmed condition/.test(
          clause,
        ) ||
        clause.includes(
          "swap places, and the ally becomes the target of the attack instead",
        ) ||
        /^[^.]*? and that (?:ally|creature) swap places$/.test(clause)
      ) {
        if (!effects.some((effect) => effect.kind === "redirect")) {
          effects.push({
            kind: "redirect",
            charmed: clause.includes("Charmed condition"),
          });
        }
      } else if (
        clause.endsWith("imposes Disadvantage on the roll") ||
        /^the [^.]*? imposes Disadvantage on the roll$/i.test(clause)
      ) {
        // Lucky's trigger already gives the roll Disadvantage.
      } else if (
        /gains Advantage on attack rolls against the target until the end of [^.]*? next turn$/.test(
          clause,
        )
      ) {
        effects.push({
          kind: "modifier",
          modifier: { kind: "advantage", on: "attacks" },
          duration: { until: "yourNextTurnEnd" },
        });
      } else if (
        /halves the (?:attack's )?damage(?: \(round down\))?(?: (?:it|he|she|they) takes? from (?:that|the) attack| to itself)?(?: \(round down\))?$/.test(
          clause,
        )
      ) {
        effects.push({ kind: "reduceDamage", halve: true });
      } else if (
        /^the podling takes the other half of the damage$/.test(clause)
      ) {
        left.push("the podling taking the other half");
      } else if (
        /^the (?:ally|creature) becomes the target of the attack instead$/.test(
          clause,
        )
      ) {
        // Part of the swap read above.
      } else if (
        /(?:reduces the damage (?:it|he|she) takes from the attack|damage is reduced) by \d+ \(/.test(
          clause,
        )
      ) {
        const amount = amountOf(clause);
        if (!amount) return null;
        effects.push({ kind: "reduceDamage", halve: false, amount });
      } else if (
        (m =
          /adds (\d+) to (?:its|his|her|their)(?: or the ally's)? AC against (?:that|the) attack, (?:possibly|potentially) causing (?:it|the attack) to miss/.exec(
            clause,
          ))
      ) {
        effects.push({ kind: "acAgainstHit", bonus: Number(m[1]) });
      } else if (
        (m =
          /gains a \+(\d+) bonus to AC, including against the triggering attack[^.]*?, until the start of [^.]*? next turn$/.exec(
            clause,
          ))
      ) {
        effects.push({
          kind: "modifier",
          modifier: {
            kind: "bonus",
            to: "ac",
            amount: { bonus: { base: Number(m[1]), add: [] } },
          },
          duration: { until: "yourNextTurnStart" },
        });
      } else if (
        (m =
          /teleports up to (\d+) feet to an unoccupied space (?:it|he|she) can see$/.exec(
            clause,
          )) ||
        (m =
          /teleports to an unoccupied space (?:it|he|she) can see within (\d+) feet of (?:itself|himself|herself)$/.exec(
            clause,
          ))
      ) {
        effects.push({ kind: "teleport", feet: Number(m[1]), movement: 0 });
      } else if (
        (m =
          /moves up to its Speed(?: without provoking Opportunity Attacks)? and (?:can )?makes? (?:a|one) ([A-Z][\w' -]*?) attack(?: (with Advantage))?(?: against the triggering creature)?$/.exec(
            clause,
          ))
      ) {
        effects.push({
          kind: "strike",
          action: m[1] ?? "",
          advantage: Boolean(m[2]),
          approach: true,
        });
        targeting = {
          creatures: 1,
          range: trigger.within ?? 120,
          side: "enemy",
        };
      } else if (
        (m =
          /^(?:On a miss, )?the [^.]*? (?:makes|can make) one ([A-Z][\w' -]*?)(?: or [A-Z][\w' -]*?)? attack(?:,)? (?:against|targeting) (?:the triggering creature|the attacker)(?: if within range)?$/i.exec(
            clause,
          ))
      ) {
        effects.push({
          kind: "strike",
          action: m[1] ?? "",
          advantage: false,
          approach: false,
        });
        targeting = { creatures: 1, range: 120, side: "enemy" };
      } else if (
        (m = /^The [^.]*? uses ([A-Z][\w' -]*?)(, but [^.]*)?$/.exec(clause))
      ) {
        effects.push({
          kind: "strike",
          action: m[1] ?? "",
          advantage: false,
          approach: false,
        });
        if (m[2]) left.push("where it lands");
        targeting = { creatures: 1, range: 120, side: "enemy" };
      } else if (
        clause.includes(
          "rolls 1d20 and chooses whether to use that roll in place of the d20 rolled",
        )
      ) {
        effects.push({ kind: "replaceRoll" });
      } else if (
        (m =
          /^The triggering creature takes \d+ (\([^)]+\)) (\w+) damage$/i.exec(
            clause,
          ))
      ) {
        const amount = amountOf(m[1] ?? "");
        const type = typesIn(m[2] ?? "")[0];
        if (!amount || !type) return null;
        return {
          targeting: { creatures: 1, range: 120, side: "enemy" },
          resolution: {
            kind: "automatic",
            damage: [{ amount, type }],
            effects,
          },
        };
      } else if ((m = /adds (\d+) to the roll$/.exec(clause))) {
        effects.push({
          kind: "rollBonus",
          amount: { bonus: { base: Number(m[1]), add: [] } },
          either: false,
        });
      } else if (
        (m =
          /gives itself Resistance to that instance of damage and gains (\d+) Temporary Hit Points$/.exec(
            clause,
          ))
      ) {
        effects.push(
          { kind: "resistTrigger" },
          {
            kind: "tempHp",
            amount: { bonus: { base: Number(m[1]), add: [] } },
          },
        );
      } else {
        left.push("what follows it");
      }
    }
  }
  return effects.length > 0
    ? { targeting, resolution: automatic(effects) }
    : null;
}

// What the save reader leaves unsaid: a push, a Frightened that ends with the target's turn, a curse, immunity.
function ridersOf(
  text: string,
  resolution: Extract<Resolution, { kind: "save" }>,
  left: string[],
): Resolution {
  const push = /pushed up to (\d+) feet straight away from/.exec(text);
  const onFail = resolution.onFail.map((effect) =>
    effect.kind === "applyCondition" &&
    text.includes("condition until the end of its turn") &&
    typeof effect.duration === "object" &&
    "minutes" in effect.duration
      ? { ...effect, duration: { until: "yourNextTurnStart" as const } }
      : effect,
  );
  if (push?.[1] && !onFail.some((effect) => effect.kind === "forcedMove")) {
    onFail.push({
      kind: "forcedMove",
      feet: Number(push[1]),
      direction: "away",
    });
  }
  if (/\bis cursed\b/.test(text)) left.push("the curse");
  if (text.includes("Success: The target is immune"))
    left.push("immunity after a success");
  return { ...resolution, onFail };
}

// Older stat blocks: Split, Mirrored Damage and Far Realm Step, in prose instead of Trigger and Response.
function olderOf(
  text: string,
  parseSave: Save,
  left: string[],
): ReadReaction | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if (
    (m =
      /^When an? (?:\w+ )?[^.]*? that has at least (\d+) hit points remaining takes ([^.]*?) damage(?: from any source)?, it splits into two/i.exec(
        t,
      ))
  ) {
    left.push("the smaller size");
    return {
      trigger: { damaged: true, damagedBy: typesIn(m[2] ?? "") },
      targeting: SELF,
      resolution: automatic([{ kind: "split", minHp: Number(m[1]), times: 1 }]),
      left,
    };
  }
  if (
    (m =
      /^In response to being damaged by a creature it can see within (\d+) feet of itself, the [^.]*? forces that creature to make (.*)$/s.exec(
        t,
      ))
  ) {
    const save =
      /^a DC (\d+) (\w+) saving throw\. On a failed save, the creature takes \d+ (\([^)]+\)) (\w+) damage\. On a successful save, the creature takes half as much damage\.?$/i.exec(
        m[2] ?? "",
      );
    const ability = ABILITIES[save?.[2] ?? ""];
    const amount = amountOf(save?.[3] ?? "");
    const type = typesIn(save?.[4] ?? "")[0];
    if (!save?.[1] || !ability || !amount || !type) return null;
    return {
      trigger: { damaged: true, within: Number(m[1]) },
      targeting: { creatures: 1, range: Number(m[1]), side: "enemy" },
      resolution: {
        kind: "save",
        ability,
        dc: { base: Number(save[1]), add: [] },
        damage: [{ amount, type }],
        onSuccessDamage: "half",
        onFail: [],
        onSuccess: [],
      },
      left,
    };
  }
  if (
    (m =
      /^Immediately after taking damage, the [^.]*? teleports up to (\d+) feet to an unoccupied space it can see\.?$/.exec(
        t,
      ))
  ) {
    return {
      trigger: { damaged: true },
      targeting: SELF,
      resolution: automatic([
        { kind: "teleport", feet: Number(m[1]), movement: 0 },
      ]),
      left,
    };
  }
  return null;
}

export function reactionOf(
  input: string,
  parseSave: Save,
): ReadReaction | null {
  const left: string[] = [];
  const text = input.replace(/’/g, "'").replace(/\s+/g, " ");
  const parts =
    /^Trigger:\s*(.*?)\s*Response\s*(?:—|-|–|:)\s*(?:—\s*)?(.*)$/s.exec(
      text.trim(),
    );
  if (!parts) return olderOf(text, parseSave, left);
  // A black pudding's Split: "While … is Large or Medium and has 10+ Hit Points, it becomes Bloodied or is
  // subjected to Lightning or Slashing damage."
  const split =
    /^While the [^.]*? is (Large or Medium|Large) and has (\d+)\+ Hit Points, it becomes Bloodied or is subjected to ([^.]*?) damage\.?$/.exec(
      (parts[1] ?? "").trim(),
    );
  if (split && (parts[2] ?? "").includes("splits into two new")) {
    left.push("the smaller size");
    return {
      trigger: {
        damaged: true,
        damagedBy: typesIn(split[3] ?? ""),
        bloodied: true,
      },
      targeting: SELF,
      resolution: automatic([
        {
          kind: "split",
          minHp: Number(split[2]),
          times: split[1] === "Large" ? 1 : 2,
        },
      ]),
      left,
    };
  }
  const read = triggerOf(parts[1] ?? "");
  if (!read) return null;
  if (read.left) left.push(read.left);
  // "Response—Wisdom Saving Throw: …" reads as a save; "Response: The goblin …" as sentences.
  const response = (parts[2] ?? "").trim();
  const done = responseOf(response, read.trigger, read.before, parseSave, left);
  if (!done) return null;
  // A response that only answers after the hit, as Counterattack, is taken once the hit lands.
  const after =
    read.trigger.hitByAttack &&
    !read.trigger.allyHit &&
    !(done.resolution.kind === "automatic"
      ? done.resolution.effects.some((effect) =>
          ["reduceDamage", "acAgainstHit", "teleport"].includes(effect.kind),
        )
      : done.resolution.kind === "save" &&
        done.resolution.onFail.some((effect) => effect.kind === "negateHit"));
  const trigger: Trigger = after
    ? {
        struck: true,
        ...(read.trigger.melee ? { melee: true } : {}),
        ...(read.trigger.ranged ? { ranged: true } : {}),
        ...(read.trigger.damagedBy
          ? { damagedBy: read.trigger.damagedBy }
          : {}),
      }
    : // Elemental Absorption's resistance has to come before the damage lands.
      done.resolution.kind === "automatic" &&
        done.resolution.effects.some(
          (effect) => effect.kind === "resistTrigger",
        )
      ? { ...read.trigger, before: true }
      : read.trigger;
  // A save aimed back at the creature that set it off reaches it wherever the trigger allows.
  const { targeting } = done;
  const aimed =
    "creatures" in targeting
      ? {
          ...targeting,
          range: Math.max(rangeOf(targeting.range), trigger.within ?? 120),
        }
      : targeting;
  return { trigger, targeting: aimed, resolution: done.resolution, left };
}
