# 语音

## 语音输入

- **按住说话**：按住 🎙 按钮，或在对话窗口按住 `F2`；`Esc` 取消。
- **免按键对话**：`Ctrl/⌘+Shift+H`，或右键 Nomi 的麦克风。自动检测你什么时候开始和停止说话。
- **语音打断**：你一开口，Nomi 的语音播报就会停下。
- 听的时候 Nomi 会点头，识别时做思考状。
- **识别引擎**：默认在本机离线识别（模型按需下载，下载前显示许可并校验）；也可以使用你已配置供应商的在线识别服务（首次使用需同意，开启「仅本地」时不可用）。

## 唤醒词（默认关闭）

开启后说出唤醒词（默认「你好，诺米」，可修改），Nomi 会开始听你说话；唤醒词后面紧跟的话会直接作为指令。

## 语音播报

Nomi 默认使用**内置离线语音**（[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)，本机 CPU 合成，不需要联网或外部服务）。
合成发生在 Electron 主进程；渲染层只拿到一段 WAV 播放并驱动口型。

| 提供方（`provider`）         | 说明                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sherpa-theresa`（**默认**） | 内置离线 TTS：sherpa-onnx 原生 addon + 中文 VITS 模型，`sid=0`、全局 `speed=1.0`；当前角色的语速设置会覆盖它 |
| `fish-local`                 | 高级 / 可选：本机 [fish-speech](https://github.com/fishaudio/fish-speech) HTTP API，`http://127.0.0.1:8080`  |
| `fish-cloud`                 | 高级 / 可选：[Fish Audio 云](https://fish.audio) `https://api.fish.audio/v1/tts`，**你自己的** API Key       |
| `legacy`                     | 保留：自行接入外部 TTS（hostname/port/path/audioUrl/promptText）                                             |

**行为**

- 没有保存过配置时默认就是 `sherpa-theresa`。
- **旧配置迁移**：磁盘上若仍是「未改过的」Fish 时代产品默认（`fish-local` + `nomi` + `http://127.0.0.1:8080`），加载时一次性改写为 `sherpa-theresa` 并写回；自定义过 Fish 地址/声线的配置保持原样。
- 路由（`packages/electron/src/tts/ttsRouter.ts`）：`sherpa-theresa` → sherpa；`fish-*` → Fish，失败再试 sherpa；`legacy` → 遗留播放器；关闭或 TTS 失败 → 静默。
- **回退**：sherpa 模型缺失 / 原生库加载失败 / 合成出错时不调用系统 Web Speech。Fish 不可达时优先走 sherpa，两者都不可用则静默。
- 角色说话时主进程分句合成并拼接成一段 WAV（`audio/wav`，22.05 kHz mono），经 IPC `tts:speak` 以 base64 返回；渲染层沿用原有播放 / 口型 / 打断逻辑。
- **不提供**「上传我的音色 / 任意参考音频克隆」入口。产品内角色自己说话 ≠ Hosted Service；不要把本应用做成对外自助 TTS 平台。

### 模型分发（按需下载，不随安装包）

自 1.0.4 起，离线 TTS 模型（下载约 115 MB，解压约 133 MB）**不再打包进安装包**，改为用户开启语音时按需下载。设计细节见 [docs/design/tts-on-demand.md](../design/tts-on-demand.md)。sherpa-onnx 原生库（`sherpa-onnx-node` + 平台包）仍随安装包分发。

1. **新安装默认语音关闭**（`voiceSettings.enabled=false`）。在主界面「设置 → 语音与屏幕 → 语音 → 朗读（离线语音）」开启语音、看板娘工具栏打开语音、或首次引导里选一个声音时，主进程从官方 release 下载模型到 `userData/tts-models/<id>/`。设置页显示进度条、可取消；失败显示原因并**把语音关回去**，可点「重试」；已下载可「删除模型」（语音随之关闭）。
2. **老用户升级**：`config.json` 里已保存 `enabled=true` 的用户保持开启，启动时自动在后台下载模型（这次失败不会关语音，设置页显示错误 + 重试）；关着的保持关闭。
3. 下载：地址 / sha256 / 字节数钉死在 `packages/electron/src/tts/sherpa/manifest.ts`；`NOMI_SHERPA_TTS_MODEL_URL` 可加镜像。**断点续传**：下载中途退出 / 断网，半成品保留在 `userData/tts-models/.download/<id>.tar.bz2.part`，下次用 HTTP `Range` 续传（服务器不支持则从头下）；sha256 覆盖完整文件，不符则删除半成品。用户点「取消」会删除半成品。
4. 运行时定位顺序：`NOMI_SHERPA_TTS_MODEL_DIR` → 开发态（未打包）`../models/<id>`、`models/<id>` → `userData/tts-models/<id>`。不再读取 `process.resourcesPath/tts-models`。
5. **缺模型永不崩溃**：`synthesize` / `warmup` 只抛 `not_ready`（附「去设置里开启语音下载」提示），路由静默；**不会在后台自动下载**（只有上面两种情形会下载）。模型就绪后完全离线工作。
6. **开发**：`pnpm i` 的 `postinstall`（`scripts/ensure-tts-model.mjs`）仍会把模型准备到仓库同级 `../models/<id>`，方便 `pnpm dev`；与打包无关。已完整（按清单大小 + `.nomi-model.json` 版本标记校验）则毫秒级跳过；`NOMI_SKIP_MODEL_DOWNLOAD=1`（旧名 `NOMI_SKIP_TTS_MODEL=1`）跳过；CI（`CI=true`）里 postinstall 默认跳过，需要预下载时设 `NOMI_SKIP_MODEL_DOWNLOAD=0`。
7. IPC：`ai:tts-model:status | download | cancel | delete | set-voice-enabled`，推送 `ai:tts-model:changed`（进度限频 200 ms）；语音开关被主进程改动时推送 `voice-settings:changed` 同步看板娘工具栏。旧的 `tts:sherpa:status` 保留（新增 `downloading` 状态）。

#### 环境变量

| 变量                                                           | 作用                                                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOMI_SKIP_MODEL_DOWNLOAD=1`                                   | 跳过开发态 postinstall / dev 的模型准备（`=0` 时在 CI 里也强制准备）                                                                                        |
| `NOMI_SKIP_TTS_MODEL=1`                                        | 跳过开发态 postinstall / dev 的模型准备（CI）                                                                                                               |
| `NOMI_SHERPA_TTS_MODEL_URL`                                    | 镜像地址（同一个 `vits-zh-hf-theresa.tar.bz2`，sha256 仍按清单校验）；可多个，逗号 / 分号 / 空白分隔，按序尝试，最后兜底官方 GitHub。脚本与运行时下载都生效 |
| `NOMI_SHERPA_TTS_MODEL_DIR`                                    | 指向已手动解压的模型目录（完整则不再下载）                                                                                                                  |
| `NOMI_SHERPA_TTS_ATTEMPTS` / `NOMI_SHERPA_TTS_IDLE_TIMEOUT_MS` | 脚本每地址重试次数（默认 3）/ 空闲超时毫秒（默认 30000）                                                                                                    |
| `HTTPS_PROXY` / `HTTP_PROXY`                                   | Node 内置 fetch 默认不走代理；脚本会尽力启用（Node ≥ 22.21 / 24.5），运行时下载（Electron）请用系统代理或镜像                                               |

#### 手动下载（国内网络 / GitHub 不通 / 公司代理）

1. 浏览器或下载器获取 `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-theresa.tar.bz2`（约 115 MB，sha256 `f337638c…1d9e92`）。
2. 解压（Windows 可用 7-Zip / `tar -xjf`），得到 `vits-zh-hf-theresa/` 目录，放到 `<repo>/../models/vits-zh-hf-theresa`（例如 `D:\self_git\models\vits-zh-hf-theresa`，内含 `theresa.onnx`、`lexicon.txt`、`tokens.txt`、`*.fst`、`dict/`），或放任意位置并设置 `NOMI_SHERPA_TTS_MODEL_DIR`。
3. `pnpm --filter @nomi-ai/electron ensure-tts-model --check` 校验；通过后重启 `pnpm dev`，下一条语音即用 sherpa。
4. 安装版：把解压出的目录放到 `userData/tts-models/vits-zh-hf-theresa/`（Linux `~/.config/Nomi/`、macOS `~/Library/Application Support/Nomi/`、Windows `%APPDATA%\Nomi\`），重启后设置页即显示「已下载」。

#### 常见失败排查

- 日志 `model install FAILED [download]`：网络 / 超时 → 设镜像 `NOMI_SHERPA_TTS_MODEL_URL` 或手动下载。
- `[prepare]` 目录不可写（权限 / 磁盘满）：设置页显示错误，语音保持关闭；脚本请换权限正常的位置或手动解压。
- `[extract]` / `[finalize]`：磁盘空间不足、杀毒软件 / 资源管理器占用目录（已自动重试 rename）。
- `engine load FAILED` + `sherpa-onnx 原生库加载失败`：见下方 Windows 说明，错误信息里带真实 dlopen 原因。

### 实现与平台

- 原生 addon：`sherpa-onnx-node@1.13.8`（N-API，Electron 可直接加载，无需 electron-rebuild）。预编译包为 optionalDependencies：`darwin-arm64` / `darwin-x64` / `linux-x64` / `linux-arm64` / `win-x64` / `win-ia32`。
- `electron-builder.yml` 的 `asarUnpack` 已包含 `sherpa-onnx-*`（`.node` 与 `libonnxruntime` / `libsherpa-onnx-c-api` 动态库必须在磁盘上）。
- **Windows x64 原生库**：需要平台包 `sherpa-onnx-win-x64`（`sherpa-onnx-node` 的 optionalDependency，须在 Windows 本机 `pnpm install` 安装，不要拷贝 Linux 的 node_modules）及其 `onnxruntime.dll` / `sherpa-onnx-c-api.dll`。加载前代码会把平台包目录加入 `PATH`；`sherpa-onnx-node` 自带 loader 会吞掉真实 dlopen 错误，`nativeAddon.ts` 失败后会诊断（平台包缺失 / DLL 缺失 / 真实 dlopen 错误）并给出提示：未装 **VC++ 2015-2022 x64 运行库**（<https://aka.ms/vs/17/release/vc_redist.x64.exe>）、`System32` 下旧版 `onnxruntime.dll` 抢先加载、杀毒软件拦截。
- 懒加载 + 单例：首次合成时才 `require` addon 并加载模型（约 0.7–1.5 s）；推理用 `createAsync` / `generateAsync`，不阻塞主进程事件循环；同一时刻只跑一个合成，新请求会让旧请求在句间退出（对应打断）。
- 参考参数（同 `/workspace/tts-samples/gen.py`）：`numThreads=4`、`provider=cpu`、`maxNumSentences=1`、`ruleFsts=phone/date/number/new_heteronym`、`dictDir=dict/`。CPU 实时率约 0.15–0.2。
- 每条 `tts:speak` 都有一条结果日志：`tts:speak success|fallback|error`（含 provider / via / 耗时 / code / message）；单次请求 90 s 总超时，超时静默，IPC 不会永久挂起。
- 单次文本上限 1500 字符（超出静默）；引擎加载失败后 60 s 内不重试，直接静默。

### 本地验证

```bash
# 单元测试（路由 / 回退 / 模型定位 / 分句 / WAV）
pnpm --filter @nomi-ai/electron exec jest --watchman=false --coverage=false tests/unit/tts

# 用已有模型目录跑通真实合成（开发态）
NOMI_SHERPA_TTS_MODEL_DIR=/path/to/extracted-model pnpm dev
# 然后让看板娘说话；或在「设置 → 语音与屏幕 → 语音 → 朗读引擎」点「检测连接」（会预热引擎并报告耗时）
```

### 设置页

- 「设置 → 语音与屏幕 → 语音 → 朗读引擎」（原独立的「TTS 语音配置」窗口已并入设置）：默认「内置离线语音」；高级可切换 Fish 本地 / 云、legacy；检测连接；**Built with Fish Audio** 标注（仅选用 Fish 时适用，文案保留）。
- 「语音设置」：当前角色 TTS 语速、音量；没有可用 TTS 时保持静默。

## 高级：Fish Audio（可选，Built with Fish Audio）

Fish 代码与合规文案保留，但**不再默认启用**。选择 `fish-local` / `fish-cloud` 后：

- 主进程调用 Fish `/v1/tts`；失败或服务未就绪时先尝试 sherpa，仍失败则静默。
- Nomi 默认 `referenceId` / `voiceHint` = `nomi`（内置可爱预设）。
- 应用已内置种子 `packages/electron/assets/tts/references/nomi/{sample.wav,sample.lab}`，合成时以 `reference_audio`（base64）+ `reference_text` 发给本地 Fish，**无需**拷进 fish-speech 的 `references/`。

```bash
# 示例：Docker Compose（以官方文档为准）
docker compose --profile server up

# 健康检查
curl -s http://127.0.0.1:8080/v1/health
# → {"status":"ok"}
```

仍需在本机（或局域网）运行 fish-speech HTTP 服务；应用不捆绑数 GB 模型权重。Fish 云：在配置页填写你自己的 Bearer Token（safeStorage 加密），默认模型头可用 `s2.1-pro-free`（以官方为准）。

## 许可要点

- **sherpa-onnx**：Apache-2.0（© k2-fsa 项目贡献者），见 `NOTICE` 与 `THIRD_PARTY_NOTICES.md`。

### Fish Audio Community License（仅选用 Fish 时适用）

- **Built with Fish Audio**（协议要求显著标注）。
- 研究 / 非商用免费；年营收 &lt; **USD 500,000** 可在社区许可下商用（以官方 LICENSE 为准）。
- **Hosted Service**（向第三方提供自助 TTS / 克隆 API）需与 Fish Audio 另行签约。
- 不可未经同意克隆真人；不可用输出训练其他基础 TTS 模型。
- 完整摘录见仓库根目录 `NOTICE` 与 `THIRD_PARTY_NOTICES.md`。

## 技术说明

- 本地识别使用 whisper.cpp（MIT）；语音活动检测使用 Silero VAD（MIT，ONNX Runtime 运行），未下载时退回能量检测。
- 录音只在内存或临时文件中，识别后立即删除，不写日志。在线识别每次调用都记入审计日志。
- 唤醒词通过「语音分段 → 本地识别 → 模糊匹配」实现。
- sherpa：`packages/electron/src/tts/sherpa/`；路由 `packages/electron/src/tts/ttsRouter.ts`；IPC `tts:speak` / `tts:health` / `tts:sherpa:*`。
- Fish 客户端：`packages/electron/src/tts/fish/`；渲染播放 `packages/renderer/src/mascot/tts/fishSpeak.ts`（对所有引擎返回的音频通用）。
