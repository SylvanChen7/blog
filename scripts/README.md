# FamilySong 字体分片

离线生成四款 FamilySong 的 WOFF2 分片与 CSS。原始 TTF 保持不变；Astro 通过独立的 `src/utils/family-song.config.ts` 读取产物 manifest。

## 准备

在项目根目录执行：

```sh
pnpm install
pnpm exec cn-font-split i default@7.6.8
```

npm 包固定为 `cn-font-split@7.4.3`，其原生核心独立固定为 `7.6.8`。第二条命令需要访问 GitHub；pnpm 不运行依赖的安装脚本时也可用这条命令显式初始化。生成步骤本身离线运行。

还需要可导入 `fontTools`、`brotli` 的 Python。本机已有 `/Users/pig/anaconda3/bin/python`，本次使用 FontTools 4.25.0。其他机器可在独立 Python 环境中安装 `fonttools[woff]`；实际版本记入产物清单，生成后必须通过相同校验。

## 生成

```sh
pnpm run fonts:split \
  --input '/Users/pig/Workspace/Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song' \
  --output src/assets/familysong \
  --python /Users/pig/anaconda3/bin/python
```

默认输入为项目同级 `Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song`，默认输出为项目内 `src/assets/familysong/`。Python 也可通过 `FONTTOOLS_PYTHON` 指定。`--chunk-kib 70` 设置估算目标大小，不保证每片都小于 70 KiB。

输出目录必须不存在。重跑时选一个新的 `--output` 目录；脚本不会覆盖已有结果。处理与校验都成功后才将临时目录改名为正式输出，失败会保留 `*.staging-*` 目录用于诊断。

仓库已包含生成结果，更新时可先输出到 `temp/familysong-next`，验证后替换 `src/assets/familysong/`。Astro 构建只读取现有产物，不运行切分脚本，也不依赖机器上的原始 TTF 或 Python 环境。

产物结构：

```text
src/assets/familysong/
  index.css             # 四款合并入口，直接引用相对子目录，无 @import
  manifest.json         # 工具版本、配置、输入哈希、分片哈希和验证结果
  regular/
  italic/
  black/
  black-italic/
    font.css            # 各款也可独立引用
    manifest.json
    <sha256前16位>.woff2
```

Astro 配置会将每片注册为独立的本地字体 variant，保留 `unicodeRange`、400/900 字重和 normal/italic 样式。`Layout.astro` 通过 `<Font cssVariable="--font-family-song" preload={false} />` 输出字体声明；Tailwind 类 `font-family-song` 可应用该字体，正文默认字体保持原有配置。无需额外引用生成的 `index.css`，该文件保留供独立使用和校验。

## 修复和校验

实测 `cn-font-split` 原生核心 7.6.8 会丢弃 Black 的 `cmap format 14`。`familysong-fonttools.py` 从原始 TTF 重建涉及异体字的分片，同时包含基字符和 variation selector，再按内容哈希命名。其余分片沿用 cn-font-split 产物。

每款生成时必须通过：

- 全部普通 Unicode 字符覆盖与源字体一致，CSS 覆盖完整且指向存在的字符。
- 所有可编码字形的展开轮廓及水平字宽/侧承与源字体逐一相同。
- 行高指标、字重、正斜体标志保持不变。
- Black 的全部 23 个 Unicode 变体序列及对应轮廓、字宽保留，CSS 包含需要的基字符与 selector。
- CSS 文件引用、分片大小及 SHA-256 与 manifest 一致。

可独立重验一款（只读，不修改产物）：

```sh
/Users/pig/anaconda3/bin/python scripts/familysong-fonttools.py verify \
  --source '/Users/pig/Workspace/Assets/Fonts/typora-latex-theme-fonts-main/General platform/Family Song/FmlSong-Black.ttf' \
  --directory src/assets/familysong/black
```

完整分片集可能比原来的 WOFF2 总体更大，因为公共数据会重复；按需加载节省的是具体页面的下载量。接入配置需通过 `pnpm run build`，实际应用到页面后的请求量和字体替换效果还需按页面测量。
