import { ContentIdSchema } from "#sdk";
import { z } from "zod";
import { ConditionSchema, DamageTypeSchema } from "./basics.ts";
import { DamageSchema, DiceSchema } from "./dice.ts";
import {
  AlliesRiderSchema,
  AreaEffectSchema,
  CostSchema,
  HitKindSchema,
  LeafEffectSchema,
  ResolutionSchema,
  TargetingSchema,
} from "./effects.ts";

// A table rolled on (combat/reactions.ts tableRoll), as Mythal Ward's or the Wild Magic Surge table. The row the die
// lands on is resolved at the bearer (`self`), the creature that set it off (`source`), the creature the roll is aimed
// at (`target`), and with `within` each creature that near the bearer. `perSpellLevel` multiplies its damage dice by
// the level of the spell that set it off; `negate` makes that spell do nothing to the bearer. A row's `spell` is cast
// at its targets with `dc`, `attack` and `level` (the bearer's own numbers when left out), and a row's `table` is
// rolled on in turn, as a surge's d10 of spells. `harmful` rows are the ones a pick of two avoids (tactics.ts).
// shortcut: an area spell from a row hits only the row's targets.
const TableRowSchema = z.strictObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1),
  targets: z.array(z.enum(["self", "source", "target"])).default([]),
  within: z.number().int().min(5).optional(),
  perSpellLevel: z.literal(true).optional(),
  negate: z.literal(true).optional(),
  harmful: z.literal(true).optional(),
  resolution: ResolutionSchema.optional(),
  spell: ContentIdSchema.optional(),
  dc: z.number().int().min(1).optional(),
  attack: z.number().int().optional(),
  level: z.number().int().min(0).max(9).optional(),
});
const InnerTableSchema = z.strictObject({
  die: z.number().int().min(2),
  rows: z.array(TableRowSchema).min(1),
});
export const TableSchema = z.strictObject({
  die: z.number().int().min(2),
  rows: z
    .array(TableRowSchema.extend({ table: InnerTableSchema.optional() }))
    .min(1),
});
export type Table = z.infer<typeof TableSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;

export const ActivationSchema = z.strictObject({
  cost: z.array(CostSchema),
  trigger: z
    .strictObject({
      hitByAttack: z.literal(true).optional(),
      melee: z.literal(true).optional(), // only a melee attack's hit triggers it, as with Parry
      // Taken when this spell of a foe's is aimed at the bearer, which it then passes by, as Shield against Magic
      // Missile; or with `spellTargets` any spell that targets it or catches it in its area, before it lands on it, as
      // Spell Thief (combat/reactions.ts spellAimedAt).
      targetedBySpell: z.string().optional(),
      spellTargets: z.literal(true).optional(),
      // Taken when a foe it can see within the activation's range casts a spell, as with Counterspell.
      spellCast: z.literal(true).optional(),
      teleports: z.literal(true).optional(), // with `spellCast`, a teleport too, as Magic-User's Nemesis
      // Taken right after hitting with a weapon, as with the smite spells. An area it targets is centred on the
      // creature hit, as Hail of Thorns' is.
      afterHit: HitKindSchema.optional(),
      // With `afterHit`, a strike option chosen before the damage is rolled, giving up this many of the hit's Sneak
      // Attack dice, as Cunning Strike's Poison (combat/strikes.ts). It's offered only when Sneak Attack lands.
      forgo: z.number().int().min(1).optional(),
      // With `afterHit`, also offered when the bearer's lasting companion hits, the bearer paying for it, as Arcane
      // Jolt on a Steel Defender's hit (combat/attack.ts companionSmite).
      alsoCompanion: z.literal(true).optional(),
      // With `afterHit`, a strike option chosen before an attack roll that has Advantage, which then has none, as
      // Brutal Strike's (combat/strikes.ts).
      forgoAdvantage: z.literal(true).optional(),
      // With `afterHit`, a strike option chosen before an attack roll without Advantage, which then has it, as a
      // Martialist's Quarterstaff's Trip (combat/strikes.ts). shortcut: its cost is paid only on a hit.
      gainsAdvantage: z.literal(true).optional(),
      // With `afterHit`, an option chosen before an attack roll without Advantage whose d20 then shows this, unrolled,
      // as a Clockwork Amulet's 10. Its cost is paid as it's picked.
      fixedRoll: z.number().int().min(1).max(20).optional(),
      // With `afterHit`, only once the hit has dealt Sneak Attack damage, as Wails from the Grave.
      sneakAttack: z.literal(true).optional(),
      // With `afterHit`, offered only right after an `afterHit` activation of this feature or spell lands on the same
      // hit, as Stalker's Flurry's effects after Dreadful Strike or Elemental Smite's after Divine Smite.
      following: z.array(ContentIdSchema).min(1).optional(),
      // With `afterHit`, only on the bearer's own turn, as Shield Bash or Charge Attack.
      ownTurn: z.literal(true).optional(),
      // With `afterHit`, only right after a walk of at least this many feet in a straight line toward the target, as
      // Charge Attack.
      charge: z.number().int().min(5).optional(),
      // With `afterHit`, only a hit that can deal this damage type, as Burst of Sunlight's Radiant.
      dealing: DamageTypeSchema.optional(),
      // With `afterHit`, only a hit with this feature's own attacks, as Rend Mind's Psychic Blades.
      withFeature: ContentIdSchema.optional(),
      // With `afterHit`, aimed at another creature within this many feet of the one hit (of the targeting's side,
      // within its range), as Sweeping Attack, and with `sameRoll` only one the hit's attack roll would also hit.
      near: z.number().int().min(5).optional(),
      sameRoll: z.literal(true).optional(),
      // With `afterHit`, only a hit on a creature under an effect of the bearer's from one of these, as Superior
      // Hunter's Prey's Hunter's Mark.
      marked: z.array(ContentIdSchema).min(1).optional(),
      // With `afterHit`, taken as the attack hits or misses, in place of what it does: the target takes this, or
      // half on a miss, and an area is round the target without it, as Lightning Arrow.
      // An empty list deals nothing to the target itself, as Piercing Arrow's line or Seeking Arrow's save.
      replacesHit: z.array(DamageSchema).optional(),
      hitOnly: z.literal(true).optional(), // with `replacesHit`, offered only on a hit, as an Energy Bow's Arrow of Restraint
      // With `afterHit`, a strike option picked before the damage that makes the hit a Critical Hit, as a Namer's
      // Needle's Named Target (combat/strikes.ts).
      critical: z.literal(true).optional(),
      // With `afterHit`, offered only on a Critical Hit, as Savage Attacks' extra weapon die.
      onCritical: z.literal(true).optional(),
      // Taken for another creature within 5 feet that a creature the bearer can see attacks, before the roll, or hits,
      // as with Protection and Interception. It's taken as soon as it can be.
      allyAttacked: z.literal(true).optional(),
      allyHit: z.literal(true).optional(),
      // what the bearer must hold to take it; "polearm" is a Quarterstaff, a Spear or a Heavy weapon with Reach,
      // and "finesse" a Finesse weapon, as Defensive Duelist's
      holding: z
        .enum(["shield", "shieldOrWeapon", "polearm", "finesse"])
        .optional(),
      // Taken by the bearer when a creature attacks it, before the roll, giving that roll Disadvantage, as with
      // Lucky. It's taken on its own once the bearer is at half its Hit Points or fewer, or the attacker has
      // Advantage.
      attacked: z.literal(true).optional(),
      noAdvantage: z.literal(true).optional(), // with `attacked`, only a roll without Advantage, as XGE's Shadowy Dodge
      // Taken right after a creature's attack damages the bearer, against that creature, as with Storm's Thunder.
      damaged: z.literal(true).optional(),
      damagedBy: z.array(DamageTypeSchema).min(1).optional(), // only damage of these types, as with Delicious Pain
      // With `damaged`, taken before the damage applies, so it can lessen it, as with Vitality Ward. With `ownSave`,
      // taken before a failed save's effect lands, as with Mythal Ward.
      before: z.literal(true).optional(),
      // With `damaged` and `damagedBy`, damage of any type that leaves the bearer Bloodied also counts, as with a
      // black pudding's Split.
      bloodied: z.literal(true).optional(),
      // Only a ranged attack's hit triggers it, as with Deflect Missile.
      ranged: z.literal(true).optional(),
      // How near the creature that sets it off must be, in feet: the attacker for `damaged` or `struck`, the
      // roller for `rolled`, the ally for `allyAttacked` and `allyHit` (5 when unset), the walker for
      // `entersReach`, `endsMove` and `turnStart`.
      within: z.number().int().min(5).optional(),
      // Taken after a d20 roll and before its result applies, as with Bountiful Luck or Portent (combat/reactions.ts).
      // `by` is whose roll, from the bearer's side; `when` what it must show: a natural 1, a hit on the bearer or
      // its ally (`hit`), a failure, or anything; `magical` only a save against a spell or magic. `hitOrFailed` is
      // a foe's hit on an ally or an ally's failed save, as Defensive Divination answers.
      rolled: z
        .strictObject({
          rolls: z.array(z.enum(["attack", "save", "check"])).min(1),
          // "others" is anyone but the bearer, as Bend Luck's
          by: z.enum(["self", "ally", "selfOrAlly", "foe", "any", "others"]),
          // "succeeded" only a roll that succeeds, as a Crystal Ball of Ominous Portent's turning it into a 1
          when: z
            // "hitOrFailedOwn" is the bearer's own failed roll or a foe's hit on it, as Moment of Prescience
            .enum([
              "natural1",
              "hit",
              "failed",
              "hitOrFailed",
              "hitOrFailedOwn",
              "succeeded",
              "any",
            ])
            .default("any"),
          magical: z.literal(true).optional(),
          // only a save to avoid or end one of these conditions, as Countercharm's Charmed or Frightened
          conditions: z.array(ConditionSchema).min(1).optional(),
          // only a roll with Advantage or Disadvantage, as Restore Balance
          edged: z.literal(true).optional(),
        })
        .optional(),
      // Taken right after an attack hits the bearer (`struck`) or misses it (`missed`), as with Counterattack or
      // Sticky Shield; or after a foe within `within` hits someone else, as with Sentinel's Guardian.
      struck: z.literal(true).optional(),
      missed: z.literal(true).optional(),
      foeHitsOther: z.literal(true).optional(),
      // Taken when another creature this Bloodied takes damage within `within`, as with Bloodthirsty Slash.
      otherDamaged: z.literal("bloodied").optional(),
      // Taken when an enemy walks into the bearer's reach, or within `within`, as with Polearm Master's Reactive
      // Strike; when one ends its move within `within`, as with Pursuit; or when one starts its turn there and can
      // see the bearer, as with Unnerving Gaze.
      entersReach: z.literal(true).optional(),
      endsMove: z.literal(true).optional(),
      turnStart: z.literal(true).optional(),
      // With `turnStart`, only a Frightened creature sets it off, as Boon of Terror's Flee, Fools!
      frightened: z.literal(true).optional(),
      // Taken after the bearer's own save against a creature's effect fails or succeeds, as with Mind Corrosion, or
      // an ally's within `within`, as with Beguiling Twist; with `conditions`, only a save against one of these.
      ownSave: z.enum(["failed", "succeeded"]).optional(),
      allySave: z.enum(["failed", "succeeded"]).optional(),
      conditions: z.array(ConditionSchema).min(1).optional(),
      // With `damaged`, only right after a trait such as Relentless Endurance leaves the bearer at 1 Hit Point instead
      // of 0, as Orcish Fury's attack.
      endured: z.literal(true).optional(),
      // Taken when a creature under the bearer's Compelled Duel-like mark (a `duel` effect it put there) damages
      // anyone but the bearer, as Unwavering Mark.
      dueledDamages: z.literal(true).optional(),
      // Taken when an enemy ends its turn within `within`, as with Skirmisher.
      turnEnds: z.literal(true).optional(),
      // Taken right after a foe within `within` hits or misses anyone with an attack roll; with `marked`, only one
      // under an effect of the bearer's from one of those, as Soul of Vengeance's foe under Vow of Enmity.
      foeAttacks: z.literal(true).optional(),
      // With `ownSave`, `missed` or `struck`, only a spell sets it off, as with Spell Reflection.
      bySpell: z.literal(true).optional(),
      // Taken when a creature within `within` makes a save to keep Concentration, or takes the Study action, as
      // with Warp Mind.
      concentrationSave: z.literal(true).optional(),
      studied: z.literal(true).optional(),
      // Taken when the bearer or a creature it can see within `within` (60 feet unless set) falls, as with Feather
      // Fall.
      falls: z.literal(true).optional(),
      // Taken when an ally within `within` spends Heroic Inspiration, as with Tireless Reveler.
      inspirationSpent: z.literal(true).optional(),
      // Taken when a creature the bearer can see within `within` hits a target with an attack roll, before its
      // damage, as with a Brooch of the Elements. It's taken only when it changes that damage for the bearer's side.
      hitDamages: z.literal(true).optional(),
      // Taken right after Initiative is rolled, as with Alert's Initiative Swap.
      initiative: z.literal(true).optional(),
      // Taken only when its owner's `commandFamiliar` effect calls for it, never on its own.
      commanded: z.literal(true).optional(),
    })
    .optional(),
  carrying: ContentIdSchema.optional(), // an item the bearer must carry to use it, as Battle Medic's Healer's Kit
  // A `slot` cost spends one of at least this level, as a level 2+ slot restoring Illusory Self's use.
  minSlot: z.number().int().min(1).max(9).optional(),
  // only in Dim Light or Darkness ("shadows"), as Merge with Shadows, or in sunlight, as Light Bringer's Sun's Healing
  whileIn: z.enum(["shadows", "sunlight"]).optional(),
  // only once the bearer has taken its action, as Sudden Strike after the Attack action ("attack") or Blink Steps after
  // the Attack or the Magic action ("attackOrMagic")
  afterAction: z
    .union([z.literal(true), z.enum(["attack", "attackOrMagic"])])
    .optional(),
  beforeAction: z.literal(true).optional(), // only before it takes its action, as Reckless Attack's first attack roll
  afterBonusAction: z.literal(true).optional(), // only once it has taken its Bonus Action, as Fleet Step
  // only after casting a spell with a casting time of an action this turn, as Battle Magic; "slot" one cast with a
  // spell slot too, as Spell Subterfuge; "leveled" any spell of level 1 or higher, as Tempestuous Magic
  afterCast: z.union([z.literal(true), z.enum(["slot", "leveled"])]).optional(),
  unmoved: z.literal(true).optional(), // only if the bearer hasn't moved this turn, as Steady Aim
  bloodied: z.literal(true).optional(), // only while the bearer has under half its Hit Points, as Unearthly Recovery
  // Once a turn for all its feature's activations, as Stunning Strike, or with a name, for all activations of that
  // name, as Brutal Strike's and Improved Brutal Strike's options (queries.ts gatesOpen).
  oncePerTurn: z.union([z.literal(true), z.string().min(1)]).optional(),
  withShield: z.literal(true).optional(), // only while the bearer holds a Shield, as Shield Bash
  // Its damage is one of the hit weapon's damage dice, of the weapon's type, as Orcish Fury's.
  weaponDie: z.literal(true).optional(),
  // A spell attack that's one of the Attack action's attacks all the same, so Extra Attack repeats it, as Radiant Sun
  // Bolt.
  withExtraAttack: z.literal(true).optional(),
  // Its resolution deals the damage of the weapon whose shot it takes the place of too, as Piercing Arrow's.
  weaponDamage: z.literal(true).optional(),
  // Its first damage entry's dice while the bearer holds no weapon or Shield, as Unarmed Fighting's d8.
  emptyHanded: DiceSchema.optional(),
  // Only as the bearer takes the Attack action: while its action is unspent or Attack-action attacks are left, as
  // Vow of Enmity or Sacred Weapon.
  withAttack: z.literal(true).optional(),
  // With targeting's `afflicted`, it ends that action's effects on the target, as Quivering Palm's end does the
  // vibrations.
  endsAffliction: z.literal(true).optional(),
  // Its effects stay on one creature at a time: using it again ends them on the one before, as Quivering Palm's
  // vibrations or Vow of Enmity.
  oneTarget: z.literal(true).optional(),
  // When a creature under its effects drops to 0 Hit Points, they move to the foe nearest the bearer within this many
  // feet of it, as Vow of Enmity's or Master of Hexes' curse.
  transfers: z.number().int().min(5).optional(),
  // A strike option that keeps its bearer hidden after an attack from hiding, while it ends the turn behind
  // Three-Quarters or Total Cover from every foe, as Supreme Sneak's Stealth Attack.
  keepsHidden: z.literal(true).optional(),
  // What the bearer gets as an `afterHit` activation is taken, as Cunning Strike's Withdraw move.
  selfEffects: z.array(LeafEffectSchema).min(1).optional(),
  // Effects on the bearer too, whatever its targets, as the Dash and Disengage of Heightened Focus's Step of the Wind
  // carrying an ally.
  alsoSelf: z.array(LeafEffectSchema).min(1).optional(),
  alsoAllies: z.array(AlliesRiderSchema).min(1).optional(), // as an `activationRider`'s `allies` give it
  // Taking it ends the spell that granted it, as Holy Weapon's burst of radiance.
  dismisses: z.literal(true).optional(),
  // Once its attacks are made, the bearer teleports to a square within this many feet of the first creature it aimed
  // at, as Steel Wind Strike. shortcut: the first such creature, not the one the player picks.
  teleportAfter: z.number().int().min(5).optional(),
  // What its user gets every time it's taken, whatever it does to its targets, as a Robe of Scintillating Colors'
  // Disadvantage on attacks against its wearer or a Horn of Blasting's chance to explode (combat/actions.ts).
  userEffects: z.array(LeafEffectSchema).min(1).optional(),
  // only while an effect of one of these features' activations is on the bearer, as Travel along the Tree in a Rage,
  // or while it concentrates on one of these spells, as Telekinetic Master's attack
  while: z.array(ContentIdSchema).min(1).optional(),
  whileAspect: z.string().min(1).optional(), // only while the bearer has this `aspect`, as Starry Form's Archer's arrows
  // Only between fights, from the character sheet (camp.ts), as a spell that takes an hour to cast, as Raise Dead,
  // which needs a scene with time to rest, or "scene" for one in any scene, as Knock on a scene's lock (explore.ts).
  outOfCombat: z.union([z.literal(true), z.literal("scene")]).optional(),
  label: z.string().min(1).optional(), // added to its feature's name, to tell two of a feature's activations apart
  projectiles: z.number().int().min(1).optional(), // separate darts, rays or beams, each aimed on its own
  distinct: z.literal(true).optional(), // with `projectiles`, each at a different creature, as Intoxicated Frenzy's
  // Only from this level in the class, as Searing Arc Strike's spell raised by more Focus Points, up to half the Monk
  // level.
  minLevel: z
    .strictObject({ class: ContentIdSchema, level: z.number().int().min(1) })
    .optional(),
  // Only once the bearer has attacked this many different creatures this turn, and only at one it hasn't, as Distant
  // Strike's third attack (combat/actions.ts actionKindMarks).
  afterTargets: z.number().int().min(1).optional(),
  // Only once this turn its bearer has used the activation of this feature with this label, as Hand of Healing's heal
  // in place of a Flurry of Blows strike (combat/actions.ts actionKindMarks).
  afterUse: z
    .strictObject({ feature: ContentIdSchema, label: z.string().optional() })
    .optional(),
  // It's done from an object the spell keeps on the map, as Spiritual Weapon's force: the object moves up to `moves`
  // feet (placed that far from the caster as the spell is cast) to within `reach` feet of the first target, and the
  // targeting's range counts from it (combat/anchor.ts). Its zone leaves are that object.
  anchor: z
    .strictObject({
      moves: z.number().int().min(0),
      reach: z.number().int().min(5).default(5),
    })
    .optional(),
  // These dice more to its damage for each round since its spell's zone was placed, as Delayed Blast
  // Fireball's bead growing at each of its caster's turn ends (stats.ts).
  growsBy: DiceSchema.optional(),
  // Its user regains Hit Points equal to half the damage it deals, as Vampiric Touch's (combat/effects.ts siphoned).
  siphon: z.literal(true).optional(),
  // A spell's `lasting` action only while no creature but its caster bears what the spell put on it, so its mark
  // moves to a new creature once the old one drops, as Hunter's Mark's (stats.ts).
  remark: z.literal(true).optional(),
  targeting: TargetingSchema,
  resolution: ResolutionSchema,
  area: AreaEffectSchema.optional(), // what the zone its resolution leaves does later
  // what its zones with a `part` do instead, by index, so one spell leaves areas that act differently, as Hunger of
  // Hadar's cold at turn start and acid at turn end
  areas: z.array(AreaEffectSchema).min(1).optional(),
  // Shapes the caster picks between as it casts, as Forcecage's cage or box (combat/actions.ts): the first is the
  // resolution as written, and another's `effects` take the place of an automatic resolution's effects.
  shapes: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        effects: z.array(LeafEffectSchema).optional(),
        // or a whole resolution of its own in place of the one written, as Pyrotechnics' Smoke
        resolution: ResolutionSchema.optional(),
        self: z.literal(true).optional(), // with `resolution`, aimed at the caster alone, as a globe held to throw
      }),
    )
    .min(2)
    .optional(),
  // Rolled on as the reaction is taken, as Mythal Ward's table (combat/reactions.ts rollOnTable).
  table: TableSchema.optional(),
});
export type Activation = z.infer<typeof ActivationSchema>;
