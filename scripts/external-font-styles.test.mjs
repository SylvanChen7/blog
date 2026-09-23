import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import externalFontStyles from "../src/integrations/external-font-styles.mjs";

const song =
  '@font-face{font-family:"Song";src:url("/_astro/fonts/song.woff2");font-weight:400;unicode-range:U+4E00-9FFF;font-display:swap}:root{--font-song:"Song",serif}';
const latin =
  '@font-face{font-family:"Latin";src:url("https://cdn.example.com/latin.woff2");font-style:italic}@font-face{font-family:"Latin fallback";src:local("Arial");size-adjust:105%}:root{--font-latin:"Latin","Latin fallback"}';
const preload =
  '<link rel="preload" href="/_astro/fonts/song.woff2" as="font" type="font/woff2" crossorigin>';
const before =
  "<!doctype html><html><head><style>@font-face{font-family:KaTeX;src:url(/katex.woff2)}</style>";
const after =
  '<style>body{color:red}</style><script>const example = "<style>leave this alone</style>";</script></head><body>字体 &amp; text</body></html>';
const marked = (css = song) =>
  `<!-- astro-fonts:start --><style>${css}</style>${preload}<style>${latin}</style><!-- astro-fonts:end -->`;
const page = (css = song) => before + marked(css) + after;

async function fixture(t, pages, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "blog-font-css-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, html] of Object.entries(pages)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  const integration = externalFontStyles();
  integration.hooks["astro:config:done"]({
    config: { base: "/", build: { assets: "_astro" }, ...options },
  });
  return {
    root,
    read: name => readFile(path.join(root, name), "utf8"),
    run: () =>
      integration.hooks["astro:build:done"]({
        dir: pathToFileURL(`${root}/`),
        logger: { info() {} },
      }),
  };
}

test("the build hook shares exact CSS across pages and preserves other HTML", async t => {
  const f = await fixture(t, {
    "index.html": page(),
    "posts/hello-world/index.html": page(),
    "404.html": "<!doctype html><html><head></head><body>404</body></html>",
  });
  await f.run();
  const names = await readdir(path.join(f.root, "_astro"));
  assert.equal(names.length, 1);
  assert.match(names[0], /^fonts\.[a-f0-9]{16}\.css$/);
  assert.equal(await f.read(`_astro/${names[0]}`), `${song}\n${latin}`);
  const expected =
    before +
    `<link rel="stylesheet" href="/_astro/${names[0]}">` +
    preload +
    after;
  assert.equal(await f.read("index.html"), expected);
  assert.equal(await f.read("posts/hello-world/index.html"), expected);
  assert.equal(
    await f.read("404.html"),
    "<!doctype html><html><head></head><body>404</body></html>"
  );

  // Running the hook twice must not add links or alter already-extracted pages.
  await f.run();
  assert.equal(await f.read("index.html"), expected);
  assert.deepEqual(await readdir(path.join(f.root, "_astro")), names);
});

test("different font sets receive different content hashes", async t => {
  const f = await fixture(t, {
    "index.html": page(),
    "other/index.html": page(
      song.replace("font-weight:400", "font-weight:700")
    ),
  });
  await f.run();
  const names = await readdir(path.join(f.root, "_astro"));
  assert.equal(names.length, 2);
  const home = await f.read("index.html");
  const other = await f.read("other/index.html");
  assert.notEqual(home, other);
  for (const name of names) {
    assert.equal(Number(home.includes(name)) + Number(other.includes(name)), 1);
  }
});

test("comments and disabled Font components are preserved without being extracted", async t => {
  const comment =
    '<!-- <Font cssVariable="--font-noto-serif-sc" preload={false} /> -->';
  const html = page().replace(preload, `${comment}${preload}`);
  const f = await fixture(t, { "index.html": html });
  await f.run();
  const [name] = await readdir(path.join(f.root, "_astro"));
  assert.equal(await f.read(`_astro/${name}`), `${song}\n${latin}`);
  assert.equal(
    await f.read("index.html"),
    before +
      `<link rel="stylesheet" href="/_astro/${name}">` +
      comment +
      preload +
      after
  );
});

test("marker text in scripts or article examples is not treated as a font block", async t => {
  const html =
    '<!doctype html><html><head><script>const example = "<!-- astro-fonts:start -->";</script></head><body><pre>&lt;!-- astro-fonts:end --&gt;</pre></body></html>';
  const f = await fixture(t, { "index.html": html });
  await f.run();
  assert.equal(await f.read("index.html"), html);
  assert.deepEqual(await readdir(f.root), ["index.html"]);
});

test("base paths, custom asset directories, and CDN prefixes resolve correctly", async t => {
  for (const assetsPrefix of [
    undefined,
    "https://cdn.example.com/",
    { css: "https://css.example.com", fallback: "https://cdn.example.com" },
    { fallback: "https://cdn.example.com" },
  ]) {
    const css = song.replace("/_astro/", "/blog/static/");
    const f = await fixture(
      t,
      { "posts/index.html": page(css) },
      {
        base: "/blog/",
        build: { assets: "static", assetsPrefix },
      }
    );
    await f.run();
    const [name] = await readdir(path.join(f.root, "static"));
    const prefix =
      typeof assetsPrefix === "string"
        ? assetsPrefix.replace(/\/$/, "")
        : (assetsPrefix?.css ?? assetsPrefix?.fallback ?? "");
    assert.ok(
      (await f.read("posts/index.html")).includes(
        `href="${prefix}/blog/static/${name}"`
      )
    );
    assert.equal(await f.read(`static/${name}`), `${css}\n${latin}`);
  }
});

test("broken markers or unexpected content fail the build instead of changing semantics", async t => {
  for (const [html, error] of [
    [page().replace("<!-- astro-fonts:end -->", ""), /Expected one/],
    [before + marked() + marked() + after, /Expected one/],
    [
      page().replace(
        `<style>${song}</style>`,
        "<style>body{color:blue}</style>"
      ),
      /Expected @font-face/,
    ],
    [
      page().replace(
        `<style>${song}</style>`,
        `<style media="print">${song}</style>`
      ),
      /Only Font styles/,
    ],
    [
      page().replace(preload, "<script>doSomething()</script>"),
      /Only Font styles/,
    ],
    [
      page(song.replace("/_astro/fonts/song.woff2", "./song.woff2")),
      /relative font URL/,
    ],
  ]) {
    const f = await fixture(t, { "index.html": html });
    await assert.rejects(f.run(), error);
    assert.equal(await f.read("index.html"), html);
  }
});
