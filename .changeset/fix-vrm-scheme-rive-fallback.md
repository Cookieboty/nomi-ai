---
'@nomi-ai/host-electron': patch
'@nomi-ai/renderer': patch
---

fix: 修复用户导入 / 商店下载的 VRM 看板娘无法加载（`cdmodel://` 协议被后注册的 `chat-asset://` 特权声明覆盖，现统一一次性注册）；Rive 看板娘启动失败（wasm / 场景加载失败或 20 秒未就绪）时自动回退到分层 2D 渲染器，并补上 `mascot-model-loaded` 就绪信号；修复滚轮缩放看板娘时脚底锚点漂移（上报给主进程的包围盒落后一次窗口缩放）。
