// A book section's kind from fifth edition stat block wording, for the import library.
export function libraryKindOf(body: string): string | null {
  if (
    /\b(Armor Class|AC)\s*\d+/.test(body) &&
    /\b(Hit Points|HP)\s*\d+/.test(body)
  ) {
    return "monster";
  }
  if (/\bCasting Time\b/.test(body) && /\bDuration\b/.test(body)) {
    return "spell";
  }
  if (
    /^\W*(Wondrous Item|Weapon|Armor|Potion|Ring|Rod|Staff|Wand|Scroll)\b[^\n]{0,80}\b(Common|Uncommon|Rare|Very Rare|Legendary|Artifact)\b/im.test(
      body.slice(0, 600),
    )
  ) {
    return "item";
  }
  return null;
}
