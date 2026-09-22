"""Repair UVS subsets and verify FamilySong coverage, outlines, metrics and CSS."""

import argparse
import hashlib
import json
import re
from pathlib import Path

import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont


def check(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def uvs(font):
    cmap = font.getBestCmap()
    return {
        (base, selector): glyph or cmap[base]
        for table in font["cmap"].tables if table.format == 14
        for selector, pairs in table.uvsDict.items()
        for base, glyph in pairs
    }


def parse_ranges(value):
    result = set()
    for item in value.split(","):
        match = re.fullmatch(r"U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?", item.strip())
        check(match, f"Invalid Unicode range: {item}")
        lo = int(match[1], 16)
        hi = int(match[2] or match[1], 16)
        check(lo <= hi <= 0x10FFFF, f"Invalid Unicode range: {item}")
        result.update(range(lo, hi + 1))
    return result


def ranges(codepoints):
    groups = []
    for point in sorted(codepoints):
        if groups and point == groups[-1][1] + 1:
            groups[-1][1] = point
        else:
            groups.append([point, point])
    return ",".join(
        f"U+{lo:X}" if lo == hi else f"U+{lo:X}-{hi:X}" for lo, hi in groups
    )


def faces(css):
    result = []
    for block in re.findall(r"@font-face\s*\{([^}]+)\}", css):
        urls = re.findall(r'url\([\'"]?\./([^\'"\)]+)[\'"]?\)', block)
        interval = re.search(r"unicode-range\s*:\s*([^;]+)", block)
        check(len(urls) == 1 and interval, "Expected one local WOFF2 URL and unicode-range per face")
        check(Path(urls[0]).name == urls[0], "Font URL must be a filename in the variant directory")
        result.append((urls[0], parse_ranges(interval[1]), block))
    check(result, "No @font-face declarations")
    return result


def signature(font, glyph):
    coordinates, ends, flags = font["glyf"][glyph].getCoordinates(font["glyf"])
    # Encoding flags and composite glyph IDs may change; flattened geometry must not.
    geometry = (list(coordinates), list(ends), [flag & 1 for flag in flags])
    return digest(repr(geometry).encode()), font["hmtx"][glyph]


def font_metrics(font):
    return {
        "unitsPerEm": font["head"].unitsPerEm,
        **{name: getattr(font["hhea"], name) for name in ("ascent", "descent", "lineGap")},
        **{name: getattr(font["OS/2"], name) for name in (
            "sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent"
        )},
    }


def css_face(filename, codepoints, weight, style):
    return (
        '@font-face {\n  font-family: "Family Song";\n'
        f'  src: url("./{filename}") format("woff2");\n'
        f"  font-weight: {weight};\n  font-style: {style};\n"
        f"  font-display: swap;\n  unicode-range: {ranges(codepoints)};\n}}\n"
    )


def finalize(source_path, directory, weight, style):
    source = TTFont(source_path, recalcTimestamp=False)
    source_uvs = uvs(source)
    declarations = faces((directory / "result.css").read_text())
    repaired = 0
    entries = []
    stylesheet = []
    old_paths = set()
    for filename, declared, _ in declarations:
        old_path = directory / filename
        old_paths.add(old_path)
        with TTFont(old_path) as font:
            cmap = set(font.getBestCmap())
        relevant = {key for key in source_uvs if key[0] in cmap}
        data = old_path.read_bytes()
        if relevant:
            # cn-font-split 7.6.8 drops cmap format 14. Rebuild only affected shards.
            selectors = {selector for _, selector in relevant}
            with TTFont(source_path, recalcTimestamp=False) as font:
                options = subset.Options()
                options.layout_features = ["*"]
                options.recalc_timestamp = False
                worker = subset.Subsetter(options=options)
                worker.populate(unicodes=cmap | selectors)
                worker.subset(font)
                font.flavor = "woff2"
                from io import BytesIO
                buffer = BytesIO()
                font.save(buffer)
                data = buffer.getvalue()
            declared |= selectors
            repaired += 1
        sha = digest(data)
        name = f"{sha[:16]}.woff2"
        new_path = directory / name
        check(not new_path.exists() or new_path.read_bytes() == data, "Hash collision")
        new_path.write_bytes(data)
        entries.append({"file": name, "bytes": len(data), "sha256": sha, "unicodeRange": ranges(declared)})
        stylesheet.append(css_face(name, declared, weight, style))
    retained = {directory / entry["file"] for entry in entries}
    for old_path in old_paths - retained:
        old_path.unlink()
    (directory / "font.css").write_text("\n".join(stylesheet))
    (directory / "result.css").unlink()
    source.close()
    return entries, repaired


def verify(source_path, directory, weight, style, entries):
    source = TTFont(source_path, recalcTimestamp=False)
    cmap = source.getBestCmap()
    source_uvs = uvs(source)
    check(source["OS/2"].usWeightClass == weight, "Source weight mismatch")
    check(bool(source["OS/2"].fsSelection & 1) == (style == "italic"), "Source style mismatch")
    declarations = faces((directory / "font.css").read_text())
    check(len(declarations) == len(entries), "CSS face count mismatch")
    check({p.name for p in directory.glob("*.woff2")} == {e["file"] for e in entries}, "Unreferenced or missing WOFF2")
    signatures = {}

    def original(glyph):
        if glyph not in signatures:
            signatures[glyph] = signature(source, glyph)
        return signatures[glyph]

    covered, css_covered, seen_uvs = set(), set(), set()
    for entry, (filename, declared, block) in zip(entries, declarations):
        check(filename == entry["file"] and declared == parse_ranges(entry["unicodeRange"]), "CSS/manifest mismatch")
        data = (directory / filename).read_bytes()
        check(len(data) == entry["bytes"] and digest(data) == entry["sha256"], f"Corrupt shard: {filename}")
        check('local(' not in block and 'font-family: "Family Song";' in block, "Unexpected family/source")
        for prop, value in (("font-weight", weight), ("font-style", style), ("font-display", "swap")):
            check(f"{prop}: {value};" in block, f"Incorrect {prop}")
        with TTFont(directory / filename) as font:
            actual = font.getBestCmap()
            actual_uvs = uvs(font)
            check(font_metrics(font) == font_metrics(source), f"Line metrics changed: {filename}")
            check(font["OS/2"].usWeightClass == weight, f"Shard weight changed: {filename}")
            check(bool(font["OS/2"].fsSelection & 1) == (style == "italic"), f"Shard style changed: {filename}")
            selectors = {selector for _, selector in actual_uvs}
            check(declared <= set(actual) | selectors, f"CSS advertises absent characters: {filename}")
            for point, glyph in actual.items():
                check(point in cmap, f"Unexpected U+{point:X}")
                check(signature(font, glyph) == original(cmap[point]), f"Outline/width changed: U+{point:X} in {filename}")
            for key, glyph in actual_uvs.items():
                check(key in source_uvs, f"Unexpected UVS: {key}")
                check(signature(font, glyph) == original(source_uvs[key]), f"UVS outline/width changed: {key}")
                if key[0] in declared and key[1] in declared:
                    seen_uvs.add(key)
            covered.update(actual)
            css_covered.update(declared & set(actual))
    check(covered == set(cmap), f"Font coverage mismatch: missing {len(set(cmap) - covered)}")
    check(css_covered == set(cmap), f"CSS coverage mismatch: missing {len(set(cmap) - css_covered)}")
    check(seen_uvs == set(source_uvs), f"UVS coverage mismatch: missing {set(source_uvs) - seen_uvs}")
    source.close()
    return {"codepoints": len(covered), "uvsSequences": len(seen_uvs), "outlinesAndWidths": "passed", "lineMetrics": "passed", "cssCoverage": "passed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["finalize", "verify"])
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--weight", type=int)
    parser.add_argument("--style", choices=["normal", "italic"])
    args = parser.parse_args()
    if args.mode == "finalize":
        check(args.weight and args.style, "finalize requires --weight and --style")
        entries, repaired = finalize(args.source, args.directory, args.weight, args.style)
        manifest = {
            "source": {"file": args.source.name, "bytes": args.source.stat().st_size, "sha256": digest(args.source.read_bytes())},
            "fontToolsVersion": fontTools.__version__,
            "weight": args.weight, "style": args.style,
            "uvsRepairedShards": repaired, "shards": entries,
        }
    else:
        manifest = json.loads((args.directory / "manifest.json").read_text())
        check(digest(args.source.read_bytes()) == manifest["source"]["sha256"], "Source hash mismatch")
    result = verify(args.source, args.directory, manifest["weight"], manifest["style"], manifest["shards"])
    manifest["verification"] = result
    sizes = [entry["bytes"] for entry in manifest["shards"]]
    manifest["summary"] = {"shards": len(sizes), "woff2Bytes": sum(sizes), "minShardBytes": min(sizes), "maxShardBytes": max(sizes)}
    if args.mode == "finalize":
        (args.directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"font": args.source.name, **manifest["summary"], **result}), flush=True)


if __name__ == "__main__":
    main()
