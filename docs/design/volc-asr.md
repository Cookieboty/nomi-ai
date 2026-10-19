# 豆包流式语音识别 2.0（#61）

语音设置 → 识别引擎 →「豆包流式语音识别 2.0（云端，自带 API Key）」。与本地 whisper.cpp、OpenAI 兼容服务并存；
默认仍是本地离线，旧配置不迁移。TTS 不受影响。

## 协议（2026-10-19 核对官方文档）

来源：火山引擎「大模型流式语音识别API」（https://www.volcengine.com/docs/6561/1354869 ，文档更新于 2026-08-06）。

- 端点：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（双向流式优化版，结果变化时才回包）。
- 握手头（新版控制台）：`X-Api-Key`、`X-Api-Resource-Id`（2.0：`volc.seedasr.sauc.duration` 小时版 / `volc.seedasr.sauc.concurrent` 并发版）、
  `X-Api-Request-Id`、`X-Api-Connect-Id`（UUID）、`X-Api-Sequence: -1`。返回头 `X-Tt-Logid` 记在错误详情里便于排错。
  不支持旧版 App Key / Access Key，也不提供 1.0 的 bigasr 资源。
- 帧：4 字节头（版本 1、头长 1×4、消息类型 + 标志、序列化 + 压缩）+ 大端 payload size + payload。
  - full client request：JSON + gzip；`audio = pcm / raw / 16000 / 16 / 1`，`request = bigmodel + itn + punc + show_utterances + result_type=full`。
  - audio only request：原始 PCM16 + gzip，200 ms（6400 字节）一包；最后一包标志 `0b0010`。
  - full server response：标志 `0b0001` 带序号，`0b0010` / 负序号 = 最后一包结果；`result.text` 为全量文本。
  - error：错误码 + 消息。已知码：45000001 参数无效、45000002 空音频、45000081 等包超时、45000151 音频格式、55000031 繁忙、550xxxxx 服务内部错误。

实现：`packages/electron/src/voice/volcAsr.ts`（生产路径，基于 `ws`）；
`packages/bundle-ig-electron-caps/src/plugins/asr/VolcAsrProvider.ts`（ASR seam，同规格，传输由宿主注入）。

## 流程

1. 渲染进程 `pttStart`：与打开麦克风并行调用 `ai:voice:streamStart`；主进程先检查 readiness（Key、仅本地模型、豆包单独的云端同意），不就绪则不建连。
2. 录音帧转 PCM16，约每 100 ms 合并一次 `ai:voice:streamPush`（单次 ≤ 64 KB，总计 ≤ 25 MB）；会话还没建好时先缓存。
3. 临时文本通过 `ai:voice:stream` 只发给发起的窗口（`state.partial`，可被修订，不自动发送）。
4. 松开：`ai:voice:streamStop` 发送最后一包，等最终结果，按现有 autoSend 交付一次；取消走 `ai:voice:streamCancel`，丢弃结果。
5. 免按键分句（整段音频）也走豆包：建连后按 200 ms 分包、每包间隔 40 ms 推送。唤醒词检测始终只用本地 whisper.cpp。

会话按窗口归属，别的窗口不能推送 / 结束；窗口销毁、切换引擎、清除 Key 时取消所有会话。控制器用代次（gen）丢弃旧会话的帧和文本：
启动中取消、A 取消后 B 开始，A 的音频 / 文本都不会进入 B。

## 超时、重试与错误

- 建连超时 8 s、调用方 15 s 不推音频视为卡住、最后一包后等最终结果 10 s。
- 只在**还没发出音频**的建连阶段，对断网、HTTP 5xx、429 限流、55000031 繁忙最多重试 2 次（退避 400 ms / 1.2 s）。
  音频发出后断开不重连、不重发，避免重复上传和重复计费。
- 错误映射：401/403 或鉴权类消息 → Key 无效（界面给「去设置」）；未开通资源；额度不足 / 欠费；限流 / 并发；超时；网络；协议；空音频；音频格式；参数；服务端。
  服务端消息里如果回显了 Key 会被打码。

## 隐私与密钥

- API Key 用 safeStorage 加密存到 `userData/voice/volc-key.json`（0600）；安全存储不可用时拒绝保存（#35）。
  `settings.json`、数据导出（只导出 `voice/settings.json`）、日志、审计、错误信息里都没有 Key；公开 IPC 只回 `hasKey`。
- 豆包使用单独的云端同意 id `volc:openspeech.bytedance.com`，不复用其他服务的同意。
- 「仅本地模型」在建连前、每次推送音频时和结束时都检查；中途开启会立即取消会话并提示，后续音频不再外发。
- 录音只在内存中；回退用的 PCM 只在开启回退时保留，会话结束即丢弃。审计只记来源、引擎、时长、是否回退。

## 回退

默认云端失败就停下并提示。用户可开启「云端识别失败时改用本地 whisper.cpp」：只在本地引擎和已选模型都已安装时生效，
不会自动下载；未安装时错误里说明无法回退。不会自动切换到其他云服务。

## 测试连接

用户点击并二次确认后才执行：建连 + 发送参数包、等待约 1.5 s 看有无错误帧，**不发送音频**。
成功文案为「已连接到豆包语音并通过鉴权（没有发送音频，未做识别测试）」，不把它说成识别可用。

## 未验证

只用本机 mock WebSocket 服务器测试过。真实 2.0 接口（鉴权失败时的实际 HTTP 状态 / 错误码、额度与未开通的具体错误、
bigmodel_async 对 40 ms 间隔批量推送的容忍度、首字 / 最终延迟、取消行为）需要测试账号、有效 Key、已开通资源和录音 / 费用授权后再验收。
