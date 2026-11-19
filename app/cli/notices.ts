// Writes THIRD_PARTY_NOTICES.md: every npm package and Rust crate the desktop app is built from, with their licence texts.
// The bundle ships the file (tauri.conf.json's resources), and CI fails when it is stale.
//   npm run notices            rewrite it
//   npm run notices -- --check fail if it would change
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const target = join(root, "THIRD_PARTY_NOTICES.md");

interface Entry {
  name: string;
  version: string;
  licence: string;
  source: string;
  texts: string[];
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

function licenceTexts(dir: string, extra?: string): string[] {
  const files = readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name))
    .map((name) => join(dir, name));
  if (extra !== undefined) files.push(extra);
  return [...new Set(files)]
    .filter((file) => statSync(file).isFile())
    .sort()
    .map((file) =>
      readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trimEnd(),
    );
}

function repoUrl(repository: unknown): string | undefined {
  const raw =
    typeof repository === "string"
      ? repository
      : (repository as { url?: string } | undefined)?.url;
  if (raw === undefined) return undefined;
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/\.git$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

// The production tree from the lockfile, plus the Tauri packages the UI bundles though they are devDependencies.
// Optional packages and those tied to one OS or CPU are sharp's native and WASM builds for Node, which never reach
// the webview; whether they are installed depends on the machine, so listing them would make the file differ by it.
function npmEntries(): Entry[] {
  const lock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      {
        name?: string;
        version: string;
        dev?: boolean;
        optional?: boolean;
        os?: string[];
        cpu?: string[];
        license?: string;
      }
    >;
  };
  const bundledDev = new Set([
    "node_modules/@tauri-apps/api",
    "node_modules/@tauri-apps/plugin-fs",
  ]);
  return Object.entries(lock.packages)
    .filter(
      ([path, pkg]) =>
        path !== "" &&
        (pkg.dev !== true || bundledDev.has(path)) &&
        pkg.optional !== true &&
        pkg.os === undefined &&
        pkg.cpu === undefined,
    )
    .map(([path, pkg]) => {
      const dir = join(root, path);
      const manifest = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { repository?: unknown; homepage?: string };
      const name =
        pkg.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
      return {
        name,
        version: pkg.version,
        licence: pkg.license ?? "",
        source:
          repoUrl(manifest.repository) ??
          manifest.homepage ??
          `https://www.npmjs.com/package/${name}`,
        texts: licenceTexts(dir),
      };
    });
}

// Every crate in Cargo.lock for every target, so the list is the same whichever OS writes it.
function crateEntries(): Entry[] {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--manifest-path",
        join(root, "app/desktop/src-tauri/Cargo.toml"),
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  ) as {
    packages: {
      name: string;
      version: string;
      license: string | null;
      license_file: string | null;
      repository: string | null;
      manifest_path: string;
      source: string | null;
    }[];
  };
  return metadata.packages
    .filter((pkg) => pkg.name !== "re-roll")
    .map((pkg) => {
      const dir = dirname(pkg.manifest_path);
      return {
        name: pkg.name,
        version: pkg.version,
        licence: pkg.license ?? (pkg.license_file === null ? "" : "see text"),
        source: pkg.repository ?? `https://crates.io/crates/${pkg.name}`,
        texts: licenceTexts(
          dir,
          pkg.license_file === null ? undefined : join(dir, pkg.license_file),
        ),
      };
    });
}

const byName = (a: Entry, b: Entry): number =>
  a.name.localeCompare(b.name, "en") ||
  a.version.localeCompare(b.version, "en");

const cell = (text: string): string => text.replace(/\|/g, "\\|");

function table(heading: string, entries: Entry[]): string {
  const rows = entries.map(
    (e) =>
      `| ${cell(e.name)} | ${e.version} | ${cell(e.licence)} | ${cell(e.source)} |`,
  );
  return [
    `| ${heading} | Version | Licence | Source |`,
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

const npm = npmEntries().sort(byName);
const crates = crateEntries().sort(byName);
const fonts: Entry = {
  name: "Solbera's D&D 5e fonts",
  version: "",
  licence: "CC-BY-SA-4.0",
  source: "https://github.com/jonathonf/solbera-dnd-fonts",
  texts: licenceTexts(join(root, "app/desktop/fonts")),
};

// Bundled media list their files in a credits.json beside them: title, author, source and licence (SPDX).
interface Credit {
  file: string;
  title: string;
  author: string;
  source: string;
  licence: string;
  changes?: string;
}
const creditFiles = ["engine", "plugins", "app/desktop"].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter(
      (file) =>
        file.endsWith("credits.json") &&
        !file.includes("node_modules") &&
        !file.includes("target"),
    )
    .map((file) => join(dir, file).replace(/\\/g, "/"))
    .sort(),
);
const media = creditFiles.flatMap((file) =>
  (JSON.parse(readFileSync(join(root, file), "utf8")) as Credit[]).map(
    (credit) => ({ ...credit, file: `${dirname(file)}/${credit.file}` }),
  ),
);
const mediaTable = [
  "| File | Title | Author | Licence | Source | Changes |",
  "| --- | --- | --- | --- | --- | --- |",
  ...media.map(
    (c) =>
      `| ${cell(c.file)} | ${cell(c.title)} | ${cell(c.author)} | ${c.licence} | ${cell(c.source)} | ${cell(c.changes ?? "")} |`,
  ),
].join("\n");

const unlicensed = [...npm, ...crates].filter((e) => e.licence === "");
if (unlicensed.length > 0) {
  for (const e of unlicensed)
    console.error(`notices: ${e.name} ${e.version} names no licence`);
  process.exit(1);
}

// Identical texts are printed once, with every package that carries them.
const users = new Map<string, string[]>();
for (const e of [fonts, ...npm, ...crates]) {
  const own =
    e.texts.length > 0
      ? e.texts
      : [
          `Ships no licence file. Licensed ${e.licence}; the standard text is at https://spdx.org/licenses/.`,
        ];
  for (const text of own) {
    const label = e.version === "" ? e.name : `${e.name} ${e.version}`;
    users.set(text, [...(users.get(text) ?? []), label]);
  }
}
const fence = (text: string): string => {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const ticks = "`".repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
};
const texts = [...users]
  .map(([text, names]) => `Used by: ${names.join(", ")}\n\n${fence(text)}`)
  .join("\n\n");

const notices = `# Third-party notices

<!-- Written by \`npm run notices\`; edit app/cli/notices.ts, not this file. -->

Re-roll is licensed under the GNU General Public License, version 3 or later (see \`LICENSE\`). It includes or depends on the following third-party work.

## Bundled or required at runtime

- **eSpeak NG** (GPL-3.0-or-later), compiled into the narration worker through the \`phonemizer\` package, to turn text into phonemes for the narrator. Source: https://github.com/espeak-ng/espeak-ng
- **Kokoro-82M** voice model and voices (Apache-2.0), downloaded on first use and verified by hash. Source: https://huggingface.co/hexgrad/Kokoro-82M
- **Solbera's D&D 5e fonts** (CC BY-SA 4.0): Bookinsanity, Mr Eaves Small Caps, Nodesto Caps Condensed, Scaly Sans and Scaly Sans Caps, unchanged from ${fonts.source}. Their licence is below.
- **Music and sounds**: Kevin MacLeod's music from incompetech.com (CC BY 4.0) and Kenney's audio packs from kenney.nl (CC0 1.0), trimmed and re-encoded. Each file is listed under Music, sounds and art below, and the game's About credits them.
- **System Reference Document 5.2** (CC BY 4.0) by Wizards of the Coast, the basis of \`plugins/rules/srd52\` and the shipped adventures' rules. See the attribution in that plugin.
- **glib 0.18.5** (MIT) in \`app/desktop/src-tauri/patches/glib-0.18.5\`, with the GHSA-wrw7-89jp-8q8g fix from glib 0.20 backported, because Tauri's Linux GTK stack still pins glib 0.18.

## Music, sounds and art

Each file's credit, from the \`credits.json\` beside it (${creditFiles.map((file) => `\`${file}\``).join(", ")}). CC0 1.0 is at https://creativecommons.org/publicdomain/zero/1.0/, CC BY 3.0 at https://creativecommons.org/licenses/by/3.0/ and CC BY 4.0 at https://creativecommons.org/licenses/by/4.0/.

${mediaTable}

## npm packages

The production dependencies in \`package-lock.json\`, and the Tauri packages the UI bundles. Native Node binaries for one OS are left out, since none reaches the app.

${table("Package", npm)}

## Rust crates

Every crate in \`app/desktop/src-tauri/Cargo.lock\`, for all three OSes.

${table("Crate", crates)}

## Licence texts

${texts}
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  if (current !== notices) {
    console.error(
      "notices: THIRD_PARTY_NOTICES.md is stale. Run `npm run notices` and commit it.",
    );
    process.exit(1);
  }
  console.log("notices: THIRD_PARTY_NOTICES.md is current");
} else {
  writeFileSync(target, notices);
  console.log(
    `notices: ${String(npm.length)} npm packages, ${String(crates.length)} crates, ${String(users.size)} licence texts`,
  );
}
