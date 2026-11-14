import { z } from "zod";
import { PLUGIN_ID_PATTERN } from "../kernel/manifest.ts";

// A store is a GitHub repo whose "store" release holds store.json and one zip per package.
// `npm run store:pack` writes both from the repo's store.yaml, and the desktop app's Store reads them.

export const STORE_TAG = "store";
export const STORE_INDEX = "store.json";
export const STORE_MANIFEST = "store.yaml";

const Id = z.string().regex(PLUGIN_ID_PATTERN);
// "<folder>/<name>", such as rules/phb or library/glossary.json.
const Part = z
  .string()
  .regex(/^(adventures|rules|assets|library)\/[a-z0-9][a-z0-9.-]*$/);

// What the publisher writes: each package's id, title and the content folders it installs.
export const StoreManifestSchema = z.strictObject({
  packages: z
    .array(
      z.strictObject({
        id: Id,
        title: z.string().min(1),
        parts: z.array(Part).min(1),
      }),
    )
    .min(1),
});

export const StoreIndexSchema = z.strictObject({
  format: z.literal(1),
  packages: z.array(
    z.strictObject({
      id: Id,
      title: z.string().min(1),
      file: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.zip$/),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      parts: z.array(Part),
      // The plugins it installs, with what each needs, so the Store can fetch those too.
      plugins: z.array(
        z.strictObject({
          id: Id,
          kind: z.enum(["adventure", "rules"]),
          version: z.string(),
          distribution: z.enum(["shipped", "private"]),
          requires: z.array(Id),
        }),
      ),
    }),
  ),
});

export type StoreIndex = z.infer<typeof StoreIndexSchema>;
export type StorePackage = StoreIndex["packages"][number];
