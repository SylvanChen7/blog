import {
  defineConfig,
  envField,
  fontProviders,
  svgoOptimizer,
} from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import remarkToc from "remark-toc";
import remarkCollapse from "remark-collapse";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeCallouts from "rehype-callouts";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { transformerFileName } from "./src/utils/transformers/fileName";
import config from "./astro-paper.config";

export default defineConfig({
  site: config.site.url,
  integrations: [
    mdx(),
    sitemap({
      filter: page =>
        config.features?.showArchives !== false || !page.endsWith("/archives/"),
    }),
  ],
  i18n: {
    locales: ["en"],
    defaultLocale: "en",
    routing: {
      prefixDefaultLocale: false,
    },
  },
  markdown: {
    processor: unified({
      smartypants: false,
      remarkPlugins: [
        remarkMath,
        remarkToc,
        [remarkCollapse, { test: "Table of contents" }],
      ],
      rehypePlugins: [rehypeKatex, rehypeCallouts],
    }),
    shikiConfig: {
      themes: { light: "min-light", dark: "night-owl" },
      defaultColor: false,
      wrap: false,
      transformers: [
        transformerFileName({ style: "v2", hideDot: false }),
        transformerNotationHighlight(),
        transformerNotationWordHighlight(),
        transformerNotationDiff({ matchAlgorithm: "v3" }),
      ],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  image: { responsiveStyles: true, layout: "constrained" },
  fonts: [
    {
      name: "Google Sans Code",
      cssVariable: "--font-google-sans-code",
      provider: fontProviders.google(),
      fallbacks: ["monospace"],
      weights: [300, 400, 500, 600, 700],
      styles: ["normal", "italic"],
    },
    {
      name: "Noto Sans SC",
      cssVariable: "--font-noto-sans-sc",
      provider: fontProviders.google(),
      fallbacks: [],
      weights: [300, 400, 500, 600, 700],
      styles: ["normal", "italic"],
    },
    {
      name: "Noto Sans",
      cssVariable: "--font-noto-sans",
      provider: fontProviders.google(),
      fallbacks: [],
      weights: [300, 400, 500, 600, 700],
      styles: ["normal", "italic"],
    },
    {
      name: "Lora",
      cssVariable: "--font-lora",
      provider: fontProviders.google(),
      fallbacks: [],
      weights: [400, 500, 600, 700],
      styles: ["normal", "italic"],
    },
    {
      name: "XCharter",
      cssVariable: "--font-xcharter",
      provider: fontProviders.local(),
      fallbacks: [],
      options: {
        variants: [
          {
            src: ["./src/assets/fonts/xcharter-regular.woff2"],
            weight: 400,
            style: "normal",
          },
          {
            src: ["./src/assets/fonts/xcharter-italic.woff2"],
            weight: 400,
            style: "italic",
          },
          {
            src: ["./src/assets/fonts/xcharter-bold.woff2"],
            weight: 700,
            style: "normal",
          },
          {
            src: ["./src/assets/fonts/xcharter-bold-italic.woff2"],
            weight: 700,
            style: "italic",
          },
        ],
      },
    },
    {
      name: "Bitstream Charter",
      cssVariable: "--font-bitstream-charter",
      provider: fontProviders.local(),
      fallbacks: [],
      options: {
        variants: [
          {
            src: ["./src/assets/fonts/charter_regular.woff2"],
            weight: 400,
            style: "normal",
          },
          {
            src: ["./src/assets/fonts/charter_italic.woff2"],
            weight: 400,
            style: "italic",
          },
          {
            src: ["./src/assets/fonts/charter_bold.woff2"],
            weight: 700,
            style: "normal",
          },
          {
            src: ["./src/assets/fonts/charter_bold_italic.woff2"],
            weight: 700,
            style: "italic",
          },
        ],
      },
    },
  ],
  env: {
    schema: {
      PUBLIC_GOOGLE_SITE_VERIFICATION: envField.string({
        access: "public",
        context: "client",
        optional: true,
      }),
    },
  },
  experimental: {
    svgOptimizer: svgoOptimizer(),
  },
});
