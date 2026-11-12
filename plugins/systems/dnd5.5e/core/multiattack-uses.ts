import type { Monster } from "./schemas.ts";

const escaped = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "The monster makes one Bite attack and uses Squeeze": the routine's non-attack actions, as the ids combat gives a
// monster's actions ("monster:<index>"), in the order printed. multiattackRoutines in stats.ts covers the attacks;
// combat's attack case takes these after them. Of "uses Hiss or Squeeze", the first it has is taken, and
// "can replace one attack with …" is a swap, not an addition, so it's left out. Given the attack chosen, only
// the routine naming it counts; a routine naming no attack ("makes two attacks and uses …") fits any.
export function multiattackUses(
  monster: Monster,
  attack?: string,
): readonly string[] {
  const sentence = monster.text
    ?.replace(/\s+/g, " ")
    .match(/Multiattack(?: \([^)]*\))?\.? (.*?\.)(?: |$)/)?.[1];
  if (!sentence) return [];
  // "…, or uses Spellcasting" is another routine to choose instead.
  const routines = sentence.split(/,? or (?:it )?(?:makes|uses)\b/i);
  const names = (text: string, name: string): boolean =>
    new RegExp(`\\b${escaped(name)}\\b`, "i").test(text);
  const attacks = monster.actions.flatMap(({ name, activation }) =>
    activation.resolution.kind === "attack" ? [name] : [],
  );
  const chosen = attack?.replace(/ \(ranged\)$/, "");
  const routine =
    chosen === undefined
      ? routines[0]
      : (routines.find((text) => names(text, chosen)) ??
        (routines.some((text) => attacks.some((name) => names(text, name)))
          ? undefined
          : routines[0]));
  if (routine === undefined) return [];
  const others = monster.actions.flatMap(({ name, activation }, index) =>
    activation.resolution.kind === "attack"
      ? []
      : [{ id: `monster:${String(index)}`, name }],
  );
  const used: string[] = [];
  for (const phrase of routine.matchAll(
    /\b(?:uses|can use) (?:its )?(?:either )?(.+?)(?=,|\.|\band\b|$)/gi,
  )) {
    // "Spellcasting to cast Charm Monster" names the spell, which is its own action.
    const named = (phrase[1] ?? "").replace(/^Spellcasting to cast /i, "");
    const twice = /\btwice\b/i.test(named);
    for (const choice of named.replace(/\s*\btwice\b/i, "").split(/\s+or\s+/)) {
      const action = others.find(({ name }) =>
        new RegExp(`^${escaped(name)}\\b`, "i").test(choice.trim()),
      );
      if (!action) continue;
      used.push(...Array<string>(twice ? 2 : 1).fill(action.id));
      break;
    }
  }
  return used;
}
