import { z } from "zod";
import { CARET_RANGE_PATTERN, VERSION_PATTERN } from "./semver.ts";

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

const PluginIdSchema = z.string().regex(PLUGIN_ID_PATTERN);
const CaretRangeSchema = z
  .string()
  .regex(CARET_RANGE_PATTERN, "must be a caret range such as ^1");

export const SystemRequirementSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]*@\^\d+(\.\d+){0,2}$/,
    "must look like system-id@^1",
  )
  .transform((text) => {
    const at = text.lastIndexOf("@");
    return { id: text.slice(0, at), range: text.slice(at + 1) };
  });

const shared = {
  id: PluginIdSchema,
  version: z.string().regex(VERSION_PATTERN, "must be x.y.z"),
  sdk: CaretRangeSchema,
  requires: z
    .array(
      z.strictObject({ plugin: PluginIdSchema, version: CaretRangeSchema }),
    )
    .default([]),
  distribution: z.enum(["shipped", "private"]),
  // The edition of its system the plugin follows. Each system ranks editions, and says what an unset one means.
  edition: z.string().optional(),
  attribution: z.string().optional(),
};

// A world plugin holds lore (#206): engine-owned world kinds that any system can load, so it names no system.
export const PluginManifestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...shared,
    kind: z.enum(["rules", "adventure"]),
    system: SystemRequirementSchema,
    // Adventures only: plugins whose entries win over others of the same name in this adventure's runs, highest first.
    precedence: z.array(PluginIdSchema).optional(),
  }),
  z.strictObject({ ...shared, kind: z.literal("world") }),
]);

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
