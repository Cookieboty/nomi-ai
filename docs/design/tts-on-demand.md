# 离线 TTS 模型按需下载（TTS on demand）

> 状态：1.0.4 实现。相关代码：`packages/electron/src/tts/sherpa/*`、`src/tts/TtsModelController.ts`、`src/tts/registerTtsModel.ts`、`src/voice/download.ts`、`packages/ai-chat/src/components/SettingsView/TtsModelCard.tsx`。

## 中文

### 背景

1.0.3 及以前，sherpa-onnx 离线语音模型 `vits-zh-hf-theresa`（解压后 138,661,153 B ≈ 132 MiB）作为 electron-builder `extraResources` 打进每个平台的安装包。很多用户从不开语音，却都要下载这部分。1.0.4 起安装包不再带模型，用户开启语音时才下载。

### 下载源与校验（钉在代码里）

| 项       | 值                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------- |
| URL      | `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-theresa.tar.bz2` |
| sha256   | `f337638c49689e1d87135c4e224daa1aacc0109e784b1cf78eafb1b14a1d9e92`                              |
| 归档大小 | 120,596,617 B（≈ 115.0 MiB）                                                                    |
| 解压后   | 138,661,153 B，逐文件字节数见 `manifest.ts`                                                     |
| 镜像     | `NOMI_SHERPA_TTS_MODEL_URL`（逗号 / 分号 / 空白分隔，最后兜底官方；sha256 不变）                |

### 存放位置

- 模型：`<userData>/tts-models/vits-zh-hf-theresa/`
- 下载临时文件：`<userData>/tts-models/.download/vits-zh-hf-theresa.tar.bz2.part`
- 解压临时目录：`<userData>/tts-models/vits-zh-hf-theresa.partial/`（校验通过后原子改名）

所有加载模型的路径（`synthesize`、`warmup`、`tts:health`、`tts:sherpa:status`）都通过 `locateModel` 查找，顺序为：`NOMI_SHERPA_TTS_MODEL_DIR` → 开发态（未打包）`../models/<id>`、`models/<id>` → `userData`。打包版不再查 `resources/tts-models`。

### 何时下载

| 情形                                            | 行为                                                                | 失败 / 取消                                         |
| ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| 设置页「开启语音」开关                          | 写入 `enabled=true`，开始下载，显示进度                             | 语音关回去，显示错误 + 重试                         |
| 看板娘工具栏打开语音 / 首次引导选择声音         | 同上（经 `save-voice-settings` → eventBus `voice:enabled-changed`） | 同上，工具栏按钮经 `voice-settings:changed` 同步    |
| 启动时语音已开且模型缺失（老用户升级）          | 后台自动下载                                                        | **不关语音**（不是用户操作），设置页显示错误 + 重试 |
| 合成 / 预热时缺模型                             | **不下载**，抛 `not_ready`（附提示），路由静默                      | —                                                   |
| provider 不是 `sherpa-theresa`（Fish / legacy） | 不需要模型，不下载                                                  | —                                                   |
| `CD_TTS=off`（E2E）                             | 启动时不自动下载                                                    | —                                                   |

### 进度、取消、重试、续传

- `SherpaTtsService.download()` 是单飞的，`getStatus()` 返回 `downloading` 以及 `phase`（download / extract）、`received`、`total`；`onStatus` 推送状态，进度推送限频 200 ms。主进程把它转发为 `ai:tts-model:changed`。
- **取消**：中止请求并删除 `.part`、`.partial`，下次重新开始。
- **断点续传**：`downloadVerified({ resume: true })` 在网络错误、超时或进程退出时保留 `.part`。下次请求带 `Range: bytes=<已有字节>-`：
  - 返回 206 时追加写入；已有字节先读入 sha256，所以哈希覆盖完整文件。
  - 返回 200（服务器不支持 Range）时从头下载。
  - 返回 416 时删除 `.part`。
  - `.part` 比预期大时从头下载。
  - sha256 不符时一定删除 `.part`，下次从头下载。
- 开始时会把已有的 `.part` 字节数当作初始进度。设置页在未下载状态下会显示「已下载 x MB，将从断点继续」。
- 解压或校验失败时删除 `.partial`；归档在 `finally` 中删除。
- **删除模型**：删除 userData 里的模型目录和临时文件，卸载引擎（`resetEngine`），并关闭语音。环境变量目录和开发目录里的模型不受影响，设置页上也不显示删除按钮。

### 默认值与老用户

- `ConfigService` 默认 `voiceSettings.enabled` 从 `true` 改为 **`false`**。
- `config.json` 在首次启动时就会以完整默认值写盘，所以 ≤1.0.3 的用户磁盘上已有 `enabled: true`（除非手动关过）。加载时深合并，已保存的值优先，因此：
  - 原来开着语音的用户保持开启，启动时自动下载模型。下载完成前语音静默，完成后自动可用，不需要重启。
  - 原来关着语音的用户保持关闭。
  - 新安装默认关闭。
- 升级后，旧安装目录里的 `resources/tts-models` 随新安装包被替换掉，不做迁移（旧路径本来就在安装目录里，和 userData 无关）。

### IPC

| 通道                             | 方向                                       | 说明                                                                                                                  |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `ai:tts-model:status`            | invoke                                     | `TtsModelState`（`SherpaModelStatus` + `voiceEnabled`）                                                               |
| `ai:tts-model:set-voice-enabled` | invoke(boolean)                            | 开 / 关语音；开启时按需下载，失败或取消回滚，返回 `{ ok, voiceEnabled, error?, status }`，取消时 `error: 'cancelled'` |
| `ai:tts-model:download`          | invoke                                     | 重新下载，不改语音开关                                                                                                |
| `ai:tts-model:cancel`            | invoke                                     | 取消下载并删除半成品；语音开着而没有模型时关闭语音                                                                    |
| `ai:tts-model:delete`            | invoke                                     | 删除模型并关闭语音                                                                                                    |
| `ai:tts-model:changed`           | push                                       | 状态 / 进度                                                                                                           |
| `voice-settings:changed`         | push（electronAPI.onVoiceSettingsChanged） | 主进程改了语音开关，看板娘 `VoiceService` 与工具栏同步                                                                |

所有 `ai:*` 通道都走 `guardedHandle`，校验 sender。

### 打包

- `electron-builder.yml` 删除了 `resources/tts-models → tts-models` 这条 `extraResources`。sherpa-onnx 原生库的 `asarUnpack` 保留。
- 删除 `scripts/sync-tts-model.mjs`、`sync-tts-model` 脚本和 10 个 `prepackage*` 钩子，以及 CI 的 "Cache sherpa TTS model" 步骤。
- 单测 `packagingNoModel.test.ts` 防止回归。
- 开发态 `postinstall`（`ensure-tts-model.mjs` → `../models`）保留，只服务 `pnpm dev`，与打包无关。

### 体积（Linux x64 本地实测）

见本次提交说明。打包后的 `resources/tts-models` 原为 138,661,153 B，现已移除。

### 未覆盖 / 取舍

- 下载走 Electron 主进程 Node `fetch`，不读系统代理。网络不通时请用镜像变量或手动放置（见 `docs/features/voice.md`）。
- 没有做磁盘空间预检。空间不足时在解压或写入阶段失败，并报清楚的错误。
- 当前只有一个模型，以后多模型时 manifest 可以扩展成列表。

## English

### Summary

Starting with 1.0.4, the sherpa-onnx offline TTS model (`vits-zh-hf-theresa`) is no longer bundled with the installer. The download is 120,596,617 B and it takes 138,661,153 B extracted. The model is downloaded on demand into `<userData>/tts-models/`. The native sherpa-onnx libraries are still bundled.

- **Source:** `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-theresa.tar.bz2`, sha256 `f337638c49689e1d87135c4e224daa1aacc0109e784b1cf78eafb1b14a1d9e92`. Size and per-file sizes are pinned in `manifest.ts`. Mirrors can be set with `NOMI_SHERPA_TTS_MODEL_URL`.
- **When it downloads:**
  - The user turns voice on: the Settings → Voice toggle, the mascot toolbar, or picking a voice in onboarding. If the download fails or is cancelled, voice is switched back off and the error is shown with Retry.
  - Startup finds voice already on with no model, which happens to users upgrading from ≤1.0.3. The model downloads in the background, and a failure here keeps voice on and shows the error in Settings.
  - Synthesis never downloads. A missing model yields `not_ready` plus a hint and stays silent; it never crashes.
- **Progress, cancel and resume:**
  - Progress is pushed on `ai:tts-model:changed`.
  - Cancel deletes the partial file.
  - A network error or quitting mid-download keeps `.part`, and the next attempt resumes with an HTTP `Range` request. If the server answers 200, the download restarts.
  - The sha256 covers the whole file. A mismatch deletes the partial file.
- **Delete model:** removes the userData copy, unloads the engine and turns voice off.
- **Defaults:** `voiceSettings.enabled` now defaults to `false`. Existing installs already have `enabled: true` saved in `config.json` (written on first launch), so they keep voice on and get the startup download. Users who had turned voice off stay off.
- **Packaging:** the `extraResources` entry, `sync-tts-model.mjs`, the `prepackage*` hooks and the CI cache step are gone. The dev-only `postinstall` model fetch remains.
