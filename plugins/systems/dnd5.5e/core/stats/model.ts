// The derived stats of a creature and the actions it knows.
import type {
  Ability,
  AbilityScores,
  Activation,
  Feature,
  Modifier,
  Passive,
  Skill,
  Spell,
} from "../schemas.ts";

export interface KnownAction {
  readonly id: string;
  readonly name: string;
  readonly activation: Activation;
  readonly spellLevel: number | null;
  readonly upcast?: Spell["upcast"];
  readonly hitType?: true; // its damage takes the type of the hit it adds to, as a maneuver's die does
  readonly rolled?: true; // taken only when a randomAction picks it, as one eye ray
  readonly concentrates?: true; // casting it starts Concentration even with no lasting effect, as Flame Blade
  readonly ammunition?: string; // the magic ammunition it fires, which a hit spends (combat/attack.ts landHit)
  readonly stored?: string; // the item it's cast from, which no longer holds it once cast (storedCasts)
  // A check made as it's taken, which on a failure wastes it, as reading a Spell Scroll above the reader's level
  // (combat/actions.ts castAction).
  readonly castCheck?: {
    readonly ability: Ability;
    readonly skill?: Skill;
    readonly dc: number;
    readonly keep?: string; // a resource a failure doesn't spend
    readonly chance?: number; // in place of the check, the percent chance it fails, as a Wind Fan's tearing
    readonly breaks?: string; // the item a failure destroys
    readonly table?: string; // the content whose table a failure rolls on, as a Hat of Many Spells
  };
  readonly onceKeys?: readonly string[]; // once-a-turn uses its cast spends, as a `spellDamage` bonus (combat/actions.ts)
  readonly saveDice?: string; // dice taken off each target's first save, as Modify Magic's Tenacious Spell (cast-options.ts)
}

export interface Stats {
  readonly abilities: AbilityScores;
  readonly proficiency: number;
  readonly level: number;
  readonly classLevels: Readonly<Record<string, number>>;
  readonly maxHp: number;
  readonly ac: number;
  readonly speed: number;
  readonly savingThrows: readonly Ability[];
  readonly skills: readonly Skill[];
  readonly expertise: readonly Skill[]; // skills whose Proficiency Bonus is doubled
  readonly spellAbility: Ability | null;
  readonly slots: readonly number[];
  readonly resources: Readonly<Record<string, number>>;
  readonly passives: readonly Passive[];
  readonly actions: readonly KnownAction[];
  readonly multiattack: number;
  // For a monster with a printed Multiattack: the attacks each chosen action makes.
  readonly routines: Readonly<Record<string, readonly string[]>> | null;
  readonly creatureType: string | undefined; // lowercase
  readonly initiative: number;
  readonly scaling: Readonly<Record<string, number>>;
  readonly features: readonly string[];
  readonly resourceDefs: Feature["resources"];
  readonly pactMagic: boolean; // slots come back on a Short Rest
  // Wearing armor without training: Disadvantage on Strength and Dexterity rolls, and no spellcasting.
  readonly untrainedArmor: boolean;
  readonly exhaustion: number; // each level takes 2 from every d20 test and 5 feet from speed
  readonly ordeal: number; // taken from every d20 test after coming back from the dead, as Raise Dead's
  // A stat block's Speeds besides walking. Others come from effects (core/movement-modes.ts).
  readonly speeds: Readonly<
    Partial<Record<"fly" | "climb" | "burrow" | "swim", number>>
  >;
  // From magic items worn, and attuned where they need it.
  readonly itemBonuses: Readonly<
    Record<
      "attack" | "spellAttack" | "spellDc" | "savingThrows" | "checks",
      number
    >
  >;
  // A character's familiar, from a spell it knows that gives one (combat/familiar.ts), with the ability it casts
  // that spell with.
  readonly familiar?: { readonly form: string; readonly ability: Ability };
}

export function passiveModifiers(
  passives: readonly Passive[],
): readonly Modifier[] {
  return passives.flatMap((passive) =>
    passive.kind === "modifier" ? [passive.modifier] : [],
  );
}
