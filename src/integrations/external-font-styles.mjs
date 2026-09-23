import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";

const START = "astro-fonts:start";
const END = "astro-fonts:end";

// Source offsets let us replace only the marked styles, without reserializing
// the rest of the page (including scripts, preload links, and article content).
function extractStyles(html) {
  if (!html.includes(START) && !html.includes(END)) return null;

  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.find(node => node.nodeName === "html");
  const head = root?.childNodes.find(node => node.nodeName === "head");
  const nodes = head?.childNodes ?? [];
  const markers = nodes.filter(
    node =>
      node.nodeName === "#comment" && [START, END].includes(node.data.trim())
  );
  if (!markers.length) return null;
  if (
    markers.length !== 2 ||
    markers[0].data.trim() !== START ||
    markers[1].data.trim() !== END
  ) {
    throw new Error("Expected one astro-fonts:start/end pair in <head>.");
  }

  const styles = [];
  const between = nodes.slice(
    nodes.indexOf(markers[0]) + 1,
    nodes.indexOf(markers[1])
  );
  for (const node of between) {
    if (node.nodeName === "#comment") continue;
    if (node.nodeName === "#text" && !node.value.trim()) continue;
    if (
      node.nodeName === "link" &&
      node.attrs.some(
        attr => attr.name === "rel" && attr.value === "preload"
      ) &&
      node.attrs.some(attr => attr.name === "as" && attr.value === "font")
    ) {
      continue;
    }
    if (node.nodeName !== "style" || node.attrs.length) {
      throw new Error(
        "Only Font styles and font preloads belong in astro-fonts."
      );
    }
    const location = node.sourceCodeLocation;
    const css = html.slice(
      location.startTag.endOffset,
      location.endTag.startOffset
    );
    if (!css.includes("@font-face")) {
      throw new Error("Expected @font-face in the marked Font styles.");
    }
    // Astro emits root-relative or absolute font URLs. A document-relative URL
    // would change meaning when moved to an external stylesheet, so fail loudly.
    for (const [, url] of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
      if (!/^(?:\/|https?:|data:)/i.test(url)) {
        throw new Error(`Cannot externalize a relative font URL: ${url}`);
      }
    }
    styles.push({ location, css });
  }
  if (!styles.length) throw new Error("No Font styles found in astro-fonts.");

  return { markers, styles };
}

/** @returns {import("astro").AstroIntegration} */
export default function externalFontStyles() {
  let base = "/";
  let assets = "_astro";
  let assetsPrefix = "";

  return {
    name: "external-font-styles",
    hooks: {
      "astro:config:done": ({ config }) => {
        base = config.base;
        assets = config.build.assets;
        const prefix = config.build.assetsPrefix;
        assetsPrefix =
          typeof prefix === "string"
            ? prefix
            : (prefix?.css ?? prefix?.fallback ?? "");
      },
      "astro:build:done": async ({ dir, logger }) => {
        const output = fileURLToPath(dir);
        const files = await readdir(output, {
          recursive: true,
          withFileTypes: true,
        });
        const emitted = new Set();
        let pages = 0;

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".html")) continue;
          const filePath = path.join(file.parentPath, file.name);
          const html = await readFile(filePath, "utf8");
          const extracted = extractStyles(html);
          if (!extracted) continue;

          const { markers, styles } = extracted;
          const css = styles.map(style => style.css).join("\n");
          const hash = createHash("sha256")
            .update(css)
            .digest("hex")
            .slice(0, 16);
          const name = `fonts.${hash}.css`;
          const assetPath = path.posix.join("/", base, assets, name);
          const href = assetsPrefix
            ? `${assetsPrefix.replace(/\/+$/, "")}${assetPath}`
            : assetPath;
          const escapedHref = href
            .replaceAll("&", "&amp;")
            .replaceAll('"', "&quot;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");

          if (!emitted.has(name)) {
            await mkdir(path.join(output, assets), { recursive: true });
            await writeFile(path.join(output, assets, name), css);
            emitted.add(name);
          }

          const edits = [
            ...markers.map(marker => ({
              ...marker.sourceCodeLocation,
              replacement: "",
            })),
            ...styles.map((style, index) => ({
              ...style.location,
              replacement:
                index === 0
                  ? `<link rel="stylesheet" href="${escapedHref}">`
                  : "",
            })),
          ].sort((a, b) => b.startOffset - a.startOffset);
          let result = html;
          for (const edit of edits) {
            result =
              result.slice(0, edit.startOffset) +
              edit.replacement +
              result.slice(edit.endOffset);
          }
          await writeFile(filePath, result);
          pages++;
        }
        logger.info(
          `Externalized fonts on ${pages} pages into ${emitted.size} shared CSS file(s).`
        );
      },
    },
  };
}
