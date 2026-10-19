---
'@nomi-ai/electron': minor
'@nomi-ai/bundle-ig-electron-caps': minor
---

新增「豆包流式语音识别 2.0（云端，自带 API Key）」识别引擎（#61），与本地 whisper.cpp、OpenAI 兼容服务并存，默认仍为离线。主进程按官方 WebSocket 二进制协议（bigmodel_async，X-Api-Key + 2.0 资源 ID）流式识别：临时结果只回给发起窗口，最终结果只交付一次；建连阶段对断网 / 5xx / 限流 / 繁忙有限重试，发出音频后不重连不重发；鉴权、未开通、额度、超时等错误给出可操作提示。API Key 用 safeStorage 加密单独保存（不可用时拒绝保存，不进 settings.json / 导出 / 日志）；单独的云端同意，「仅本地模型」在建连前和每次推音频时检查；可选失败后回退到已安装的本地模型。用户主动的「测试连接」只鉴权不发音频。ASR seam 的 VolcAsrProvider 同步改为真实实现。新增依赖 ws（MIT）。真实接口未验证，仅 mock WebSocket 测试。
