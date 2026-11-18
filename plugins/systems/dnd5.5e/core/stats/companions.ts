// Familiars and other companions a character's spells and features bring.
import type { ContentAccess } from "#sdk";
import { type Ability, type Passive, SpellSchema } from "../schemas.ts";
import { lookup } from "./content.ts";
import type { Stats } from "./model.ts";

// shortcut: as with a familiar, knowing the spell is enough, with no slot or casting time spent between fights.
export function spellCompanions(
  knownSpells: ReadonlySet<string>,
  access: ContentAccess,
): Passive[] {
  return [...knownSpells].flatMap((spellId) => {
    // Only a spell that names a companion is parsed, and through the cache: this runs on every deriveStats.
    const raw = access.content(spellId);
    if (!raw || !("companion" in raw)) {
      return [];
    }
    const spell = lookup(access, SpellSchema, spellId);
    return spell.companion
      ? [
          {
            kind: "lastingCompanion" as const,
            ...spell.companion,
            free: true as const,
            level: spell.level,
          },
        ]
      : [];
  });
}

const chosenForm = (passive: Passive | undefined): string | undefined =>
  passive?.kind === "familiarForm" ? passive.form : undefined;

export function familiarFrom(
  knownSpells: ReadonlySet<string>,
  castingAbility: ReadonlyMap<string, Ability>,
  access: ContentAccess,
  spellAbility: Ability | null,
  passives: readonly Passive[],
): Pick<Stats, "familiar"> {
  // Pact of the Chain's special forms, or another form a feature's variant picks.
  const chosen = passives.findLast(
    (passive) => passive.kind === "familiarForm",
  );
  for (const spellId of knownSpells) {
    const { familiar } = lookup(access, SpellSchema, spellId);
    // shortcut: with the form's book not loaded, as the SRD's own owl isn't, there's no familiar.
    if (
      !familiar ||
      access.content(chosenForm(chosen) ?? familiar.form) === undefined
    ) {
      continue;
    }
    return {
      familiar: {
        form: chosen?.kind === "familiarForm" ? chosen.form : familiar.form,
        ability: castingAbility.get(spellId) ?? spellAbility ?? "int",
      },
    };
  }
  return {};
}
