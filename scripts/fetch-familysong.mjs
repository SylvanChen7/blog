import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { list, extract } from "tar";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultOutput = path.join(projectRoot, "src/assets/familysong");
const maxBytes = 512 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/i;
const variants = new Map([
  ["regular", [400, "normal"]],
  ["italic", [400, "italic"]],
  ["black", [900, "normal"]],
  ["black-italic", [900, "italic"]],
]);
const digest = data => createHash("sha256").update(data).digest("hex");

async function statIfExists(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Reject links and special files before copying or installing a bundle.
async function checkTree(directory, budget = { bytes: 0, entries: 0 }) {
  const stat = await lstat(directory);
  if (!stat.isDirectory()) throw new Error("Font bundle must be a directory.");
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    const entry = await lstat(file);
    budget.entries++;
    budget.bytes += entry.isFile() ? entry.size : 0;
    if (budget.entries > 10000 || budget.bytes > maxBytes) {
      throw new Error("Font bundle exceeds the 10,000-entry / 512 MiB limit.");
    }
    if (entry.isDirectory()) await checkTree(file, budget);
    else if (!entry.isFile())
      throw new Error(`Unsupported bundle entry: ${name}`);
  }
}

export async function verifyBundle(directory) {
  await checkTree(directory);
  const manifestBytes = await readFile(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.family !== "Family Song" ||
    !Array.isArray(manifest.variants) ||
    manifest.variants.length !== variants.size
  ) {
    throw new Error("Expected a Family Song manifest with all four variants.");
  }
  const css = await readFile(path.join(directory, "index.css"));
  if (digest(css) !== manifest.indexCssSha256) {
    throw new Error("index.css SHA-256 mismatch.");
  }
  const seen = new Set();
  let count = 0;
  for (const variant of manifest.variants) {
    const expected = variants.get(variant.id);
    if (
      !expected ||
      seen.has(variant.id) ||
      variant.weight !== expected[0] ||
      variant.style !== expected[1] ||
      !Array.isArray(variant.shards) ||
      !variant.shards.length
    ) {
      throw new Error("Invalid or duplicate Family Song variant.");
    }
    seen.add(variant.id);
    const files = new Set();
    for (const shard of variant.shards) {
      if (
        !/^[a-f0-9]{16}\.woff2$/.test(shard.file) ||
        files.has(shard.file) ||
        !hashPattern.test(shard.sha256) ||
        !Number.isSafeInteger(shard.bytes) ||
        shard.bytes <= 0 ||
        typeof shard.unicodeRange !== "string" ||
        !/^U\+[A-Fa-f0-9?]+(?:-[A-Fa-f0-9]+)?(?:,\s*U\+[A-Fa-f0-9?]+(?:-[A-Fa-f0-9]+)?)*$/.test(
          shard.unicodeRange
        )
      ) {
        throw new Error("Invalid or duplicate font shard in manifest.");
      }
      files.add(shard.file);
      const data = await readFile(path.join(directory, variant.id, shard.file));
      if (
        data.length !== shard.bytes ||
        digest(data) !== shard.sha256 ||
        shard.file !== `${shard.sha256.slice(0, 16)}.woff2` ||
        data.toString("ascii", 0, 4) !== "wOF2"
      ) {
        throw new Error(
          `Font shard integrity check failed: ${variant.id}/${shard.file}`
        );
      }
      count++;
    }
  }
  return { count, manifestSha256: digest(manifestBytes) };
}

export function resolveSource(source) {
  if (source.startsWith("github:")) {
    const match = /^github:([\w.-]+)\/([\w.-]+)@([^/]+)\/([^/]+)$/.exec(source);
    if (!match)
      throw new Error(
        "Use github:owner/repo@tag/asset.tar.gz (URL-encode slashes in tags)."
      );
    const [, owner, repo, tag, asset] = match;
    return new URL(
      `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(decodeURIComponent(tag))}/${encodeURIComponent(decodeURIComponent(asset))}`
    );
  }
  if (/^https?:\/\//i.test(source)) return new URL(source);
  if (source.startsWith("file:")) return fileURLToPath(source);
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !path.isAbsolute(source)) {
    throw new Error(
      "Supported sources: github:, HTTP(S), file: URLs, or local paths."
    );
  }
  return path.resolve(source);
}

async function download(url, destination, fetchImpl) {
  // Never send credentials; public URLs and presigned object-storage URLs work.
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Font download failed (HTTP ${response.status}).`);
  }
  let bytes = 0;
  await pipeline(
    response.body,
    new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > maxBytes ? new Error("Font download exceeds 512 MiB.") : null,
          chunk
        );
      },
    }),
    createWriteStream(destination, { flags: "wx" })
  );
}

async function archiveHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function extractArchive(file, cwd) {
  let bytes = 0;
  let entries = 0;
  // Inspect the entire archive before extraction. The file lives in our staging directory.
  list({
    file,
    sync: true,
    strict: true,
    onReadEntry(entry) {
      entries++;
      bytes += entry.size;
      if (
        entry.path.startsWith("/") ||
        entry.path.includes("\\") ||
        entry.path.includes(":") ||
        entry.path.split("/").includes("..") ||
        !["File", "Directory"].includes(entry.type)
      ) {
        throw new Error(`Unsafe archive entry: ${entry.path}`);
      }
      if (entries > 10000 || bytes > maxBytes) {
        throw new Error("Archive exceeds the 10,000-entry / 512 MiB limit.");
      }
    },
  });
  extract({ file, cwd, sync: true, strict: true, preservePaths: false });
}

async function findBundle(directory) {
  if (await statIfExists(path.join(directory, "manifest.json")))
    return directory;
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(directory, entries[0].name);
    if (await statIfExists(path.join(nested, "manifest.json"))) return nested;
  }
  throw new Error(
    "Archive must contain manifest.json at its root or inside a single enclosing directory."
  );
}

export async function fetchFonts({
  source,
  sha256,
  output = defaultOutput,
  fetchImpl = fetch,
}) {
  output = path.resolve(output);
  if (sha256 && !hashPattern.test(sha256))
    throw new Error("--sha256 must be a 64-digit SHA-256 hash.");
  if (!source) {
    if (sha256) throw new Error("--sha256 requires --source.");
    try {
      return { status: "verified", output, ...(await verifyBundle(output)) };
    } catch (error) {
      throw new Error(
        `No valid installed fonts. Set --source or FAMILYSONG_SOURCE. ${error.message}`
      );
    }
  }
  const resolved = resolveSource(source);
  if (resolved instanceof URL && !sha256) {
    throw new Error("Remote archives require --sha256 or FAMILYSONG_SHA256.");
  }
  // Only replace recognizable font bundles, never unrelated directories or symlinks.
  if (await statIfExists(output)) {
    const stat = await lstat(output);
    if (!stat.isDirectory())
      throw new Error("Output must be a directory, not a link or file.");
    const manifest = JSON.parse(
      await readFile(path.join(output, "manifest.json"))
    );
    if (manifest.family !== "Family Song")
      throw new Error("Refusing to replace a non-Family Song directory.");
  }
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(
    path.join(path.dirname(output), ".familysong-fetch-")
  );
  let keepStaging = false;
  try {
    const payload = path.join(staging, "payload");
    let bundle;
    if (typeof resolved === "string" && (await lstat(resolved)).isDirectory()) {
      if (sha256)
        throw new Error(
          "--sha256 applies to archives; directories use manifest checksums."
        );
      // Avoid copying the output/staging directory recursively into itself.
      const relative = path.relative(resolved, staging);
      if (
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      ) {
        throw new Error("Output cannot be inside the source directory.");
      }
      await verifyBundle(resolved);
      await cp(resolved, payload, { recursive: true });
      bundle = payload;
    } else {
      const archive = path.join(staging, "bundle.tar.gz");
      if (resolved instanceof URL) await download(resolved, archive, fetchImpl);
      else {
        const stat = await lstat(resolved);
        if (!stat.isFile() || stat.size > maxBytes)
          throw new Error(
            "Expected a regular archive file of at most 512 MiB."
          );
        await cp(resolved, archive);
      }
      if (sha256 && (await archiveHash(archive)) !== sha256.toLowerCase()) {
        throw new Error(
          "Archive SHA-256 mismatch; existing fonts were preserved."
        );
      }
      await mkdir(payload);
      extractArchive(archive, payload);
      bundle = await findBundle(payload);
    }
    const verified = await verifyBundle(bundle);
    const backup = path.join(staging, "previous");
    const exists = Boolean(await statIfExists(output));
    if (exists) await rename(output, backup);
    try {
      await rename(bundle, output);
    } catch (error) {
      if (exists) {
        try {
          await rename(backup, output);
        } catch {
          keepStaging = true;
          throw new Error(
            `Install and rollback failed; previous fonts are preserved at ${backup}.`,
            { cause: error }
          );
        }
      }
      throw error;
    }
    return { status: "installed", output, ...verified };
  } finally {
    if (!keepStaging) await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      sha256: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`Usage: pnpm run fonts:fetch [options]

--source  Local directory, .tar/.tar.gz/.tgz file, HTTP(S) URL,
          or github:owner/repo@tag/asset.tar.gz
          Default: FAMILYSONG_SOURCE; otherwise verify installed fonts only.
--sha256  Archive SHA-256 (required for remote sources).
          Default: FAMILYSONG_SHA256.
--output  Destination directory (default: src/assets/familysong).
--help    Show this help.

Local paths resolve from the current working directory. Public GitHub releases
and presigned HTTP(S) URLs are supported. ZIP and private GitHub authentication
are not supported. Explicit sources are fetched and verified on every run.
`);
    return;
  }
  const result = await fetchFonts({
    source: values.source ?? process.env.FAMILYSONG_SOURCE,
    sha256: values.sha256 ?? process.env.FAMILYSONG_SHA256,
    output: values.output,
  });
  process.stdout.write(
    `Family Song: ${result.status} ${result.count} shards in ${result.output}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(error => {
    process.stderr.write(`fonts:fetch: ${error.message}\n`);
    process.exitCode = 1;
  });
}
