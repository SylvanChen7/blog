import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { create } from "tar";
import {
  fetchFonts,
  resolveSource,
  verifyBundle,
} from "./fetch-familysong.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");

async function fixture(t, revision = "original") {
  const root = await mkdtemp(path.join(tmpdir(), "familysong-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const output = path.join(root, "installed");
  await mkdir(source);
  const css = `/* ${revision} */`;
  const manifest = {
    family: "Family Song",
    indexCssSha256: hash(css),
    variants: [],
  };
  for (const [id, weight, style] of [
    ["regular", 400, "normal"],
    ["italic", 400, "italic"],
    ["black", 900, "normal"],
    ["black-italic", 900, "italic"],
  ]) {
    // Small byte fixtures test transport/integrity, not font rendering.
    const bytes = Buffer.from(`wOF2 ${id} ${revision}`);
    const sha256 = hash(bytes);
    const file = `${sha256.slice(0, 16)}.woff2`;
    await mkdir(path.join(source, id));
    await writeFile(path.join(source, id, file), bytes);
    manifest.variants.push({
      id,
      weight,
      style,
      shards: [
        { file, bytes: bytes.length, sha256, unicodeRange: "U+4E00-4E01" },
      ],
    });
  }
  await writeFile(path.join(source, "index.css"), css);
  await writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  return { root, source, output, manifest };
}

async function archiveFixture(f, wrapped = true) {
  const archive = path.join(f.root, "bundle.tar.gz");
  await create(
    {
      file: archive,
      gzip: true,
      portable: true,
      cwd: wrapped ? f.root : f.source,
    },
    [wrapped ? "source" : "."]
  );
  const bytes = await readFile(archive);
  return { archive, bytes, sha256: hash(bytes) };
}

test("installs local directories and verifies existing fonts without a source", async t => {
  const f = await fixture(t);
  assert.equal((await fetchFonts(f)).status, "installed");
  assert.equal((await fetchFonts({ output: f.output })).count, 4);
  assert.deepEqual(await verifyBundle(f.output), await verifyBundle(f.source));
  assert.deepEqual((await readdir(f.root)).sort(), ["installed", "source"]);
});

test("accepts archives with flat or single-directory layouts, including file URLs", async t => {
  for (const wrapped of [true, false]) {
    const f = await fixture(t);
    const { archive, sha256 } = await archiveFixture(f, wrapped);
    const result = await fetchFonts({
      source: pathToFileURL(archive).href,
      sha256,
      output: f.output,
    });
    assert.equal(result.count, 4);
  }
});

test("HTTP and GitHub sources share checksum verification and installation", async t => {
  const f = await fixture(t);
  const { bytes, sha256 } = await archiveFixture(f);
  for (const source of [
    "https://cdn.example.test/fonts?v=1",
    "github:owner/repo@fonts-v1/familysong.tar.gz",
  ]) {
    let requested;
    const result = await fetchFonts({
      source,
      sha256,
      output: f.output,
      fetchImpl: async url => {
        requested = String(url);
        return new Response(bytes);
      },
    });
    assert.equal(result.count, 4);
    assert.equal(
      requested,
      source.startsWith("github:")
        ? "https://github.com/owner/repo/releases/download/fonts-v1/familysong.tar.gz"
        : source
    );
  }
  assert.equal(
    String(resolveSource("github:owner/repo@fonts%2Fv1/font.tar.gz")),
    "https://github.com/owner/repo/releases/download/fonts%2Fv1/font.tar.gz"
  );
});

test("remote errors and checksum mismatches leave existing fonts untouched", async t => {
  const f = await fixture(t);
  await fetchFonts(f);
  const before = await verifyBundle(f.output);
  const { bytes, sha256 } = await archiveFixture(f);
  const base = {
    source: "https://cdn.example.test/fonts.tar.gz",
    output: f.output,
  };
  await assert.rejects(
    fetchFonts({ ...base, fetchImpl: () => assert.fail("must not download") }),
    /require --sha256/
  );
  await assert.rejects(
    fetchFonts({
      ...base,
      sha256,
      fetchImpl: async () => new Response(null, { status: 404 }),
    }),
    /HTTP 404/
  );
  await assert.rejects(
    fetchFonts({
      ...base,
      sha256: "0".repeat(64),
      fetchImpl: async () => new Response(bytes),
    }),
    /SHA-256 mismatch/
  );
  await assert.rejects(
    fetchFonts({
      ...base,
      sha256,
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    }),
    /network unavailable/
  );
  assert.deepEqual(await verifyBundle(f.output), before);
  assert.ok(
    !(await readdir(f.root)).some(name => name.startsWith(".familysong-fetch-"))
  );
});

test("detects missing or corrupt shards even when the archive checksum matches", async t => {
  const f = await fixture(t);
  await fetchFonts(f);
  const before = await verifyBundle(f.output);
  const file = path.join(
    f.source,
    "regular",
    f.manifest.variants[0].shards[0].file
  );
  await writeFile(file, "corrupt");
  const { archive, sha256 } = await archiveFixture(f);
  await assert.rejects(
    fetchFonts({ source: archive, sha256, output: f.output }),
    /integrity check failed/
  );
  assert.deepEqual(await verifyBundle(f.output), before);
  await rm(file);
  await assert.rejects(fetchFonts(f), /ENOENT/);
});

test("updates installed fonts and can repair a corrupt shard", async t => {
  const old = await fixture(t);
  const next = await fixture(t, "updated");
  await fetchFonts(old);
  await writeFile(
    path.join(old.output, "regular", old.manifest.variants[0].shards[0].file),
    "broken"
  );
  await fetchFonts({ source: next.source, output: old.output });
  assert.deepEqual(
    await verifyBundle(old.output),
    await verifyBundle(next.source)
  );
});

test("rejects links in source directories and archives", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside.txt");
  await writeFile(outside, "untouched");
  await symlink(outside, path.join(f.source, "link"));
  await assert.rejects(fetchFonts(f), /Unsupported bundle entry/);
  const { archive } = await archiveFixture(f);
  await assert.rejects(
    fetchFonts({ source: archive, output: f.output }),
    /Unsafe archive entry/
  );
  assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("rejects archive path traversal before extraction", async t => {
  const f = await fixture(t);
  const archive = path.join(f.root, "traversal.tar.gz");
  await create(
    { file: archive, gzip: true, cwd: f.source, prefix: "../escaped" },
    ["index.css"]
  );
  await assert.rejects(
    fetchFonts({ source: archive, output: f.output }),
    /Unsafe archive entry/
  );
  await assert.rejects(
    readFile(path.join(f.root, "escaped", "index.css")),
    /ENOENT/
  );
});

test("does not replace unrelated directories or a symlink destination", async t => {
  const f = await fixture(t);
  await mkdir(f.output);
  await writeFile(path.join(f.output, "keep.txt"), "untouched");
  await assert.rejects(fetchFonts(f), /ENOENT/);
  assert.equal(
    await readFile(path.join(f.output, "keep.txt"), "utf8"),
    "untouched"
  );
  const link = path.join(f.root, "output-link");
  await symlink(f.source, link);
  await assert.rejects(
    fetchFonts({ source: f.source, output: link }),
    /not a link or file/
  );
});

test("rejects malformed manifests, missing fonts, and recursive output paths", async t => {
  const f = await fixture(t);
  await assert.rejects(fetchFonts({ output: f.output }), /Set --source/);
  await assert.rejects(
    fetchFonts({ source: f.source, output: path.join(f.source, "nested") }),
    /inside the source/
  );
  f.manifest.variants[0].shards[0].file = "../../outside.woff2";
  await writeFile(
    path.join(f.source, "manifest.json"),
    JSON.stringify(f.manifest)
  );
  await assert.rejects(fetchFonts(f), /Invalid or duplicate font shard/);
});
