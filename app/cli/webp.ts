// Converts the books' pictures to WebP and crops battle maps to the part their fights use: node app/cli/webp.ts [books folder]
import { resolve } from "node:path";
import { convertBooks } from "../../engine/tools/webp.ts";

const root = resolve(
  process.argv[2] ?? resolve(import.meta.dirname, "../../books"),
);
const report = await convertBooks(root, (line) => {
  console.log(line);
});
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`;
console.log(
  `\nConverted ${String(report.converted)} pictures, cropped ${String(report.cropped.length)} battle maps.`,
);
console.log(
  `Pictures: ${gb(report.bytesBefore)} before, ${gb(report.bytesAfter)} after.`,
);
for (const path of report.cropped) console.log(`cropped: ${path}`);
for (const path of report.uncropped)
  console.log(`uncropped (a scene shows it whole): ${path}`);
for (const line of report.skipped) console.log(`skipped: ${line}`);
for (const line of report.missing)
  console.log(`missing (not in the books in any format): ${line}`);
