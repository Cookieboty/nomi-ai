# 本地模型

入口：对话窗口 🏠（`Ctrl/⌘+Shift+J`），或设置 → 本机管理（剪贴板 / 数据导出 / 本机小模型 / Ollama；日历在设置 → 日程与日历 → 日历接入）。所有功能都可以离线使用。

## 一键运行开源小模型

- 内置模型目录：Qwen3 0.6B / 1.7B / 4B、Qwen2.5 1.5B Instruct、SmolLM2 1.7B Instruct、Phi-4 mini Instruct，均为宽松开源许可（Apache-2.0 / MIT）。
- 根据电脑内存推荐合适的模型，并在每张卡片上标注「内存充足 / 偏紧 / 不足」。
- 下载前显示许可，带进度、可取消，校验 SHA-256。第一次下载时会顺带获取 llama.cpp 推理程序。
- 「启动」后模型自动注册为「llama.cpp（本机）」供应商；可「设为聊天模型」、停止、删除，或「启动应用时自动运行」。

## Ollama

如果你装了 Ollama，可以在这里列出、拉取（带进度）和删除本机模型。

给编程助手（Claude Code / Codex 经本地路由）用 Ollama 时，请以足够大的上下文启动：`OLLAMA_CONTEXT_LENGTH=20480 ollama serve`。默认上下文太小，长提示会被截断，导致空回复。详见[编程助手接入](coding-agent-harness.md)。

## 离线模式

开启后只使用本地模型：云端供应商和需要联网的工具会被拒绝；如果本地模型在运行，它会成为对话模型。

## 技术说明

- 推理服务是 llama.cpp 的 `llama-server`（MIT），只监听 `127.0.0.1` 的随机端口，以 OpenAI 兼容接口提供服务。
- 模型目录在 `packages/electron/src/local/llmCatalog.ts`，每项都固定文件与 SHA-256。
