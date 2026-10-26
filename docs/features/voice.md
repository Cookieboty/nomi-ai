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

自 2.0.3 起不再内置离线语音引擎，也不再使用系统朗读（speechSynthesis）。Nomi 的声音分两部分：

### 诺米提示语音（预录，默认开启）

- 诺米的常用中文提示语（问候、提醒、开关语音等，共 96 段）随安装包内置为预录语音，约 1.6 MB，位于 `packages/renderer/public/voice/nomi/zh/`（`<key>.mp3` + `manifest.json`）。
- 音色：微软晓伊（`zh-CN-XiaoyiNeural`，语速 -5%，音调 +0Hz）。
- 只在**同时满足**以下条件时播放：当前角色是诺米、界面语言为中文、看板娘未静音、「设置 → 语音与屏幕 → 语音 → 诺米提示语音」开启（IPC `tts:prompt-voice`）。
- 播放顺序：**预录片段 → 实时朗读引擎 → 静音**。台词有对应片段就播片段；没有则交给实时朗读引擎；引擎为「无」或未接入时只显示文字。
- 带变量的台词（如「已切换到 xx 模式」「你不在的时候错过了 N 条提醒」）气泡显示完整文字，语音念一句固定说法。
- 同一句 1.5 秒内只播一次（气泡和事件语音同时触发时不会重复）。口型、音量、语音打断沿用原有播放逻辑（`packages/renderer/src/mascot/tts/fishSpeak.ts` 的 `playAudioClip`）。
- 片段生成脚本：`scripts/voice/gen.py`（需要 `pip install edge-tts` 和 ffmpeg）。台词文字取自 `@nomi-ai/i18n` 中文文案；新增台词用 `--add KEY`，改了文案用 `--only KEY` 重新生成。

> **许可提示**：当前片段由微软 Edge 在线 Neural 朗读服务生成，其输出的再分发许可不明确，属于临时素材。正式发布前需用 Azure Speech 订阅（同一音色）重新生成。

### 实时朗读引擎（默认「无」）

「设置 → 语音与屏幕 → 语音 → 实时朗读引擎」可选：

| 选项（`provider`） | 说明                                                 |
| ------------------ | ---------------------------------------------------- |
| `none`（**默认**） | 不合成语音，AI 回复只出文字（预录提示语音不受影响）  |
| `edge`             | 微软 Edge 在线朗读 —— **暂未接入**，选中后静默并提示 |
| `azure`            | Azure Speech —— **暂未接入**，选中后静默并提示       |
| `openai`           | OpenAI 语音 —— **暂未接入**，选中后静默并提示        |

- 路由：`packages/electron/src/tts/ttsRouter.ts`；IPC `tts:speak` / `tts:health`。失败或超时（90 s）一律静默，不会回退到系统朗读。
- 旧配置兼容：已移除的内置离线引擎按「无」处理；之前配置过的 Fish（本地 / 云）或自建 legacy 引擎继续可用，但不再作为新选项提供。选用 Fish 时适用 Fish Audio Community License（Built with Fish Audio），详见 `NOTICE` / `THIRD_PARTY_NOTICES.md`。
- e2e：`CD_TTS=off` 时不调用任何实时朗读引擎。
- 「语音设置」：当前角色的语速、音量。
- **不提供**「上传我的音色 / 任意参考音频克隆」入口。

## 技术说明

- 本地识别使用 whisper.cpp（MIT）；语音活动检测使用 Silero VAD（MIT，ONNX Runtime 运行），未下载时退回能量检测。
- 录音只在内存或临时文件中，识别后立即删除，不写日志。在线识别每次调用都记入审计日志。
- 唤醒词通过「语音分段 → 本地识别 → 模糊匹配」实现。
- 预录提示语音：`packages/renderer/src/mascot/voice/promptClips.ts`；实时朗读路由 `packages/electron/src/tts/ttsRouter.ts`。
- 渲染播放 `packages/renderer/src/mascot/tts/fishSpeak.ts`（预录片段与引擎返回的音频通用）。
