import { fontProviders } from "astro/config";
import manifest from "../assets/familysong/manifest.json";

type FontVariant = {
  src: [string];
  weight: number;
  style: "normal" | "italic";
  unicodeRange: [string];
};

// Each shard is a separate @font-face, not an alternative source of one face.
const [firstVariant, ...otherVariants] = manifest.variants.flatMap(variant => {
  const { style } = variant;
  if (style !== "normal" && style !== "italic") {
    throw new Error(`Unsupported Family Song font style: ${style}`);
  }

  return variant.shards.map<FontVariant>(shard => ({
    src: [`./src/assets/familysong/${variant.id}/${shard.file}`],
    weight: variant.weight,
    style,
    unicodeRange: [shard.unicodeRange],
  }));
});

if (!firstVariant) {
  throw new Error("The Family Song manifest contains no font shards.");
}

const variants: [FontVariant, ...FontVariant[]] = [
  firstVariant,
  ...otherVariants,
];

export default {
  name: "Family Song",
  cssVariable: "--font-family-song" as const,
  provider: fontProviders.local(),
  fallbacks: ["serif"],
  display: "swap" as const,
  options: { variants },
};
