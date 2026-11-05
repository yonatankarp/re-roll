export interface StorageEntry {
  readonly path: string;
  readonly symlink: boolean;
}

// Paths are relative to the storage root and always use forward slashes.
export interface Storage {
  read(path: string): Promise<string | null>;
  replaceAtomically(path: string, contents: string): Promise<void>;
  list(prefix: string): Promise<readonly StorageEntry[]>;
}
