# 安装包体积 · 2.0.5 easy wins

> 实现优先于文档。本文仅记录已落地的低风险项与未做项。

## 已落地（`release/2.0.5`）

| 项               | 手段                                                                           | 预期量级（原始 / 安装约） |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------- |
| asarUnpack 重复  | `afterPack` 重建 asar，去掉与 `app.asar.unpacked` 重叠的 onnx / tesseract 文件 | ~20 MiB / ~5–6 MiB        |
| bare-* prebuilds | files 排除 android/ios；afterPack 只留 `${platform}-${arch}`                   | ~4–5 MiB / ~2 MiB         |
| zlibjs           | files + afterPack 只留 `bin/node-zlib.js`                                      | ~3.5 MiB / ~1 MiB         |
| i18n             | 排除 `src` 与 ESM `dist`，保留 `dist-cjs`                                      | ~2 MiB / ~0.5 MiB         |
| assets           | 不进 asar，仅 `extraResources`                                                 | ~1.3 MiB / ~0.5 MiB       |

tesseract.js-core：2.0.4 已只留 relaxedsimd 双变体。`createWorker(..., 1)` 虽意图 LSTM_ONLY，但 worker 把布尔 `lstmOnly` 传给 `getCore(oem)`，数字 OEM 判断失效，运行时加载**非 LSTM** `tesseract-core-relaxedsimd`。故不能再砍非 LSTM 核心。

## 未做（产品门控）

按需下载 / 延迟加载 Rive、Sprite、ort、tesseract、mp3 等，不在 2.0.5 范围。

## 关键入口

- `apps/desktop-electron/electron-builder.yml`（files / asarUnpack / afterPack）
- `apps/desktop-electron/scripts/after-pack-slim.mjs`
- 回归：`scripts/__tests__/electron-builder-slim.test.ts`
