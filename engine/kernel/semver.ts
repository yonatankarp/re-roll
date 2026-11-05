export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const CARET_RANGE_PATTERN = /^\^\d+(\.\d+){0,2}$/;

function numbers(text: string): number[] {
  return text.split(".").map(Number);
}

// shortcut: only exact x.y.z versions and caret ranges, upgrade to semver if plugins need more.
export function satisfiesCaret(version: string, range: string): boolean {
  if (!VERSION_PATTERN.test(version) || !CARET_RANGE_PATTERN.test(range))
    return false;
  const [major = 0, minor = 0, patch = 0] = numbers(version);
  const parts = numbers(range.slice(1));
  const [wantMajor = 0, wantMinor = 0, wantPatch = 0] = parts;

  if (major !== wantMajor) return false;
  if (major === 0 && parts.length > 1 && minor !== wantMinor) return false;
  if (minor !== wantMinor) return minor > wantMinor;
  return patch >= wantPatch;
}
