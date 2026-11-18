import { ContentEntrySchema } from "#sdk";
import { z } from "zod";
import { PassiveSchema } from "./passives.ts";

// A random table from a book. Each row covers the die results min to max, and its cells line up with `columns`.
export const RollTableSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  die: z.string().regex(/^\d*d\d+$/), // such as d100 or 2d6
  columns: z.array(z.string()).min(1), // the headings of the columns after the die roll
  rows: z
    .array(
      z.strictObject({
        min: z.number().int().min(1),
        max: z.number().int().min(1),
        cells: z.array(z.string()),
        // what the row gives an item it's rolled for, while the item works, as an artifact's random property
        // (MagicItemSchema `properties`)
        passives: z.array(PassiveSchema).min(1).optional(),
      }),
    )
    .min(1),
  source: z.string().min(1),
})
  .strict()
  .superRefine((table, context) => {
    for (const [index, row] of table.rows.entries()) {
      if (row.min > row.max || row.cells.length !== table.columns.length) {
        context.addIssue({
          code: "custom",
          message: `row ${String(index + 1)} doesn't fit the table`,
        });
      }
    }
  });

// A table looked up by a printed key, such as a Challenge Rating band or a theme, rather than rolled on.
export const LookupTableSchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  keyedBy: z.string().min(1), // the heading of the key column
  columns: z.array(z.string()).min(1), // the headings of the columns after the key
  rows: z
    .array(
      z.strictObject({ key: z.string().min(1), cells: z.array(z.string()) }),
    )
    .min(1),
  source: z.string().min(1),
}).strict();

// A Bastion's special facility or event, for reading. Nothing runs Bastion turns yet.
export const BastionEntrySchema = ContentEntrySchema.extend({
  name: z.string().min(1),
  type: z.enum(["facility", "event"]),
  level: z.number().int().min(1).optional(), // the level a facility becomes available at
  prerequisite: z.string().optional(),
  order: z.string().optional(), // the order a facility's hirelings can carry out
  text: z.string().min(1),
}).strict();
