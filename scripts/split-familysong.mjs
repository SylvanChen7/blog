import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    python: {
      type: "string",
      default: process.env.FONTTOOLS_PYTHON ?? "python3",
    },
    "chunk-kib": { type: "string", default: "70" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  process.stdout.write(`Usage: pnpm run fonts:split [options]
  --input DIR       Directory containing the four FmlSong-*.ttf files
  --output DIR      New output directory (default: src/assets/familysong)
  --python PATH     Python with FontTools and Brotli installed
  --chunk-kib N     Target shard size in KiB (default: 70; not a hard limit)

See scripts/README.md for setup and independent verification.
`);
  process.exit(0);
}

const input = path.resolve(
  values.input ??
    path.join(
      root,
      "../Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song"
    )
);
const output = path.resolve(
  values.output ?? path.join(root, "src/assets/familysong")
);
const chunkSize = Number(values["chunk-kib"]) * 1024;
if (!Number.isSafeInteger(chunkSize) || chunkSize < 1024) {
  throw new Error("--chunk-kib must specify at least 1 KiB in whole bytes.");
}
if (existsSync(output)) {
  throw new Error(
    `Output already exists; choose a new --output directory: ${output}`
  );
}

function python(args) {
  const result = spawnSync(values.python, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`FontTools step failed (${result.status}).`);
}

python([
  "-c",
  "from fontTools.ttLib import TTFont; from fontTools import subset; import brotli",
]);
const variants = [
  {
    id: "regular",
    filename: "FmlSong-Regular.ttf",
    weight: 400,
    style: "normal",
  },
  {
    id: "italic",
    filename: "FmlSong-Italic.ttf",
    weight: 400,
    style: "italic",
  },
  { id: "black", filename: "FmlSong-Black.ttf", weight: 900, style: "normal" },
  {
    id: "black-italic",
    filename: "FmlSong-BlackItalic.ttf",
    weight: 900,
    style: "italic",
  },
];
for (const variant of variants) {
  if (!existsSync(path.join(input, variant.filename))) {
    throw new Error(`Missing source: ${path.join(input, variant.filename)}`);
  }
}

// The npm wrapper and native core have independent versions. Pin both.
const require = createRequire(import.meta.url);
const packagePath = require.resolve("cn-font-split/package.json");
const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
const coreVersions = await readFile(
  path.join(path.dirname(packagePath), "dist/version"),
  "utf8"
);
if (
  packageInfo.version !== "7.4.3" ||
  !coreVersions
    .trim()
    .split("\n")
    .every(line => line.endsWith("@7.6.8"))
) {
  throw new Error(
    "Expected cn-font-split wrapper 7.4.3 / core 7.6.8. See scripts/README.md."
  );
}
if (process.env.CN_FONT_SPLIT_BIN) {
  throw new Error(
    "Unset CN_FONT_SPLIT_BIN so the recorded, pinned core is used."
  );
}
const { fontSplit } = await import("cn-font-split");
await mkdir(path.dirname(output), { recursive: true });
const staging = await mkdtemp(`${output}.staging-`);
const config = {
  chunkSize,
  autoSubset: true,
  subsetRemainChars: true,
  fontFeature: true,
  reduceMins: false,
  renameOutputFont: "[hash:16].[ext]",
  testHtml: false,
  reporter: false,
  silent: true,
};
const manifests = [];
const stylesheets = [];

try {
  for (const variant of variants) {
    process.stdout.write(`Splitting ${variant.filename}…\n`);
    const source = path.join(input, variant.filename);
    const directory = path.join(staging, variant.id);
    await fontSplit({
      ...config,
      input: source,
      outDir: directory,
      css: {
        fontFamily: "Family Song",
        fontWeight: String(variant.weight),
        fontStyle: variant.style,
        fontDisplay: "swap",
      },
    });
    python([
      path.join(root, "scripts/familysong-fonttools.py"),
      "finalize",
      "--source",
      source,
      "--directory",
      directory,
      "--weight",
      String(variant.weight),
      "--style",
      variant.style,
    ]);
    const manifest = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8")
    );
    manifests.push({ id: variant.id, ...manifest });
    const css = await readFile(path.join(directory, "font.css"), "utf8");
    stylesheets.push(css.replaceAll('url("./', `url("./${variant.id}/`));
  }
  await writeFile(path.join(staging, "index.css"), stylesheets.join("\n"));
  const css = await readFile(path.join(staging, "index.css"));
  const manifest = {
    family: "Family Song",
    generator: {
      wrapper: packageInfo.version,
      core: coreVersions.trim(),
      config,
    },
    indexCssSha256: createHash("sha256").update(css).digest("hex"),
    variants: manifests,
  };
  await writeFile(
    path.join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await chmod(staging, 0o755);
  await rename(staging, output);
  process.stdout.write(`Complete: ${output}\n`);
} catch (error) {
  process.stderr.write(
    `Incomplete output retained for diagnosis: ${staging}\n`
  );
  throw error;
}
