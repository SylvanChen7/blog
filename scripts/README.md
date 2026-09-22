# FamilySong Font Subsetting

Generate WOFF2 subsets and CSS for all four FamilySong variants offline. The original TTF files remain unchanged; Astro reads the generated manifest through the separate `src/utils/family-song.config.ts` configuration.

## Fetching Existing Subsets

`fonts:fetch` installs an existing subset bundle into `src/assets/familysong/`. It does not require the original TTF files, Python, or the cn-font-split native core. First, run `pnpm install` as described in the project README.

Supported sources:

| Source                | `--source` example                                         |
| --------------------- | ---------------------------------------------------------- |
| Local directory       | `/path/to/familysong`                                      |
| Local archive         | `/path/to/familysong.tar.gz`; `file:///...` URLs also work |
| Public GitHub Release | `github:owner/repo@fonts-v1/familysong.tar.gz`             |
| Direct HTTP(S) URL    | `https://example.com/fonts/familysong.tar.gz`              |

Supported archive formats are `.tar`, `.tar.gz`, and `.tgz`; ZIP is not supported. Remote URLs only need to return a supported archive and do not need a filename extension. Full GitHub Release download URLs, object storage/CDN URLs, and signed URLs are supported. Encode any `/` in a GitHub shorthand tag as `%2F`. Token authentication for private GitHub Releases is not currently supported.

```sh
# Local directory: verify each font subset and index.css against the manifest
pnpm run fonts:fetch --source /path/to/familysong

# Local archive: optionally pass --sha256 to verify the archive itself
pnpm run fonts:fetch --source /path/to/familysong.tar.gz

# Remote sources require the archive SHA-256; URLs and hashes below are placeholders
pnpm run fonts:fetch \
  --source 'github:owner/repo@fonts-v1/familysong.tar.gz' \
  --sha256 '<64-digit archive SHA-256>'

pnpm run fonts:fetch \
  --source 'https://example.com/fonts/familysong.tar.gz' \
  --sha256 '<64-digit archive SHA-256>'

# Install to a temporary location for inspection without replacing the current fonts
pnpm run fonts:fetch --source /path/to/familysong.tar.gz --output temp/familysong-check

# With no source argument or environment variable, verify installed fonts only
# Missing or corrupt fonts cause an error
pnpm run fonts:fetch
```

Relative local paths resolve from the command's working directory. The default output is always this project's `src/assets/familysong/`. You can use the `FAMILYSONG_SOURCE` and `FAMILYSONG_SHA256` environment variables instead of arguments; the corresponding command-line arguments take precedence.

When a source is explicitly specified, each run reads or downloads it again without relying on the build cache. The script extracts and validates the bundle in a temporary directory before replacing the existing Family Song directory. Download failures, archive hash mismatches, and missing or corrupt subsets leave the existing fonts untouched. Directories that do not contain Family Song are not overwritten. Symbolic links and hard links are not allowed in archives; symbolic links are also rejected in local directories. Extraction is limited to 512 MiB and 10,000 entries, with a download timeout of 120 seconds.

### Creating an Archive

The archive must contain `manifest.json`, `index.css`, and all four variant directories either directly at its root or inside a single enclosing directory. Package the entire generated directory:

```sh
mkdir -p temp
COPYFILE_DISABLE=1 tar -czf temp/familysong.tar.gz -C src/assets familysong
shasum -a 256 temp/familysong.tar.gz
```

`COPYFILE_DISABLE=1` prevents macOS from adding AppleDouble metadata. After uploading the archive as a Release asset or to another file hosting service, record its download URL and the SHA-256 printed above. A URL tied to a fixed version is recommended.

### Vercel / CI

Set `FAMILYSONG_SOURCE` and `FAMILYSONG_SHA256` in the build environment, then use this Build Command:

```sh
pnpm run fonts:fetch && pnpm run build
```

Fetching must run before `astro check` / `astro build` because the Astro configuration imports the font manifest. Use a remote source on Vercel; local paths on a development machine are not available there. Extraction happens only during the build, and Astro still emits the font assets for deployment.

The repository currently retains the font subsets, and the existing build command is unchanged. The new command does not automatically publish Releases, remove fonts from Git, or change deployment settings.

Run the fetch tests with `pnpm run fonts:test`. They use temporary directories and mocked HTTP responses without accessing actual Releases or modifying the current fonts.

## Setup

Run from the project root:

```sh
pnpm install
pnpm exec cn-font-split i default@7.6.8
```

The npm package is pinned to `cn-font-split@7.4.3`, and its native core is separately pinned to `7.6.8`. The second command requires GitHub access and can explicitly initialize the core when pnpm does not run dependency installation scripts. Generation itself runs offline.

You also need a Python environment that can import `fontTools` and `brotli`. This machine has `/Users/pig/anaconda3/bin/python`; the current subsets were generated with FontTools 4.25.0. On other machines, install `fonttools[woff]` in a separate Python environment. The actual version is recorded in the output manifest, and generated subsets must pass the same validation.

## Generation

```sh
pnpm run fonts:split \
  --input '/Users/pig/Workspace/Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song' \
  --output src/assets/familysong \
  --python /Users/pig/anaconda3/bin/python
```

The default input is `Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song` under the project's parent directory. The default output is `src/assets/familysong/` inside the project. You can also select Python through `FONTTOOLS_PYTHON`. `--chunk-kib 70` sets an estimated target size; it does not guarantee that every subset is smaller than 70 KiB.

The output directory must not already exist. Choose a new `--output` directory when rerunning the script; existing results are never overwritten. The temporary directory is renamed to the final output only after processing and validation succeed. On failure, the `*.staging-*` directory is retained for diagnosis.

The repository already includes generated subsets. To update them, first generate into `temp/familysong-next`, validate the result, and then replace `src/assets/familysong/`. Astro builds only read the existing artifacts; they do not run the subsetting script or require the original TTF files or a Python environment.

Output structure:

```text
src/assets/familysong/
  index.css             # Combined entry for all four variants; relative URLs, no @import
  manifest.json         # Tool versions, configuration, input/subset hashes, validation results
  regular/
  italic/
  black/
  black-italic/
    font.css            # Each variant can also be referenced independently
    manifest.json
    <first-16-sha256-digits>.woff2
```

The Astro configuration registers each subset as a separate local font variant, preserving `unicodeRange`, weights 400/900, and normal/italic styles. `Layout.astro` emits font declarations through `<Font cssVariable="--font-family-song" preload={false} />`. The Tailwind class `font-family-song` applies the font; the default body font follows the existing theme configuration. There is no need to import the generated `index.css` separately; it is retained for standalone use and validation.

## Repair and Validation

Testing showed that cn-font-split native core 7.6.8 drops Black's `cmap format 14` data. `familysong-fonttools.py` rebuilds the affected subsets from the original TTF, retaining both base characters and variation selectors, then names the files by their content hashes. Other subsets retain the cn-font-split output.

Each generated variant must pass the following checks:

- Ordinary Unicode character coverage matches the source font, and CSS covers all required characters without referencing absent ones.
- Expanded outlines and horizontal advance widths/side bearings of all encoded glyphs match the source font exactly.
- Line metrics, weights, and upright/italic flags remain unchanged.
- All 23 Unicode variation sequences in Black are retained with their outlines and advance widths, and CSS includes the required base characters and selectors.
- CSS file references, subset sizes, and SHA-256 hashes match the manifest.

Revalidate a single variant independently without modifying the output:

```sh
/Users/pig/anaconda3/bin/python scripts/familysong-fonttools.py verify \
  --source '/Users/pig/Workspace/Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song/FmlSong-Black.ttf' \
  --directory src/assets/familysong/black
```

The complete subset bundle may be larger than the original WOFF2 files because shared data is duplicated. On-demand loading reduces the amount downloaded by individual pages. Font integration changes must pass `pnpm run build`; request counts and font substitution behavior still need to be measured on the pages that use the fonts.
