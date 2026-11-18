// A record's own value for a key from content or a save, so "constructor" or "toString" finds nothing
// rather than something from Object.prototype.
export function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined;
}
