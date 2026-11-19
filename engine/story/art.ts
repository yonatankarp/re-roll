import { z } from "zod";

// The pictures a book's or a plugin's assets/index.json describes: covers, chapter plates, portraits and tokens.

export const FaceSchema = z.object({
  x: z.number(), // the face's centre, as a share of the picture's width
  y: z.number(), // and of its height
  size: z.number(), // the face's width, as a share of the picture's width
});

export const ArtIndexSchema = z.array(
  z.object({
    file: z.string(),
    monster: z.string().optional(),
    subjects: z.array(z.string()).optional(), // other names it can stand for, such as "dwarf cleric"
    face: FaceSchema.optional(),
    cover: z.array(z.string()).optional(), // ids of the plugins (adventures or books) this picture is the cover of
    chapter: z.array(z.string()).optional(), // "<adventure>:<scene>" for each chapter it opens
    items: z.array(z.string()).optional(), // ids of the items it shows
    treasure: z.array(z.string()).optional(), // kinds of treasure it shows, such as "coins"
  }),
);

export const ART_INDEX = "assets/index.json";
export const CREDITS = "assets/credits.json";

// The only licences a shipped plugin's media may carry: they allow redistribution with, at most, credit.
export const LICENCES = ["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "PD"] as const;

// Where each bundled file came from, as its licence asks. Shown in the app's About section.
export const CreditsSchema = z.array(
  z.strictObject({
    file: z.string().regex(/^[^/\\]+$/, "must be a bare file name"),
    title: z.string().min(1),
    author: z.string().min(1),
    source: z.url(),
    licence: z.enum(LICENCES),
    changes: z.string().min(1).optional(), // what was done to it, which CC BY asks to be said
  }),
);
export type Credit = z.infer<typeof CreditsSchema>[number];

export function creditLine(credit: Credit): string {
  const { title, author, licence, source, changes } = credit;
  const terms = licence === "PD" ? "public domain" : licence;
  return `“${title}” by ${author} (${terms}), ${source}${changes ? `; ${changes}` : ""}`;
}
