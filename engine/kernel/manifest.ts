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

export const PluginManifestSchema = z.strictObject({
  id: PluginIdSchema,
  kind: z.enum(["rules", "adventure"]),
  version: z.string().regex(VERSION_PATTERN, "must be x.y.z"),
  sdk: CaretRangeSchema,
  system: SystemRequirementSchema,
  requires: z
    .array(
      z.strictObject({ plugin: PluginIdSchema, version: CaretRangeSchema }),
    )
    .default([]),
  distribution: z.enum(["shipped", "private"]),
  attribution: z.string().optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
