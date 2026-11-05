# 本地模型

入口：「设置 → 模型与供应商 → 本机模型」，快捷键 `Ctrl/⌘+Shift+J` 直达。模型下载完之后可以完全离线使用。

## 一键运行开源小模型

- 内置模型目录：Qwen3 0.6B / 1.7B / 4B、Qwen2.5 1.5B Instruct、SmolLM2 1.7B Instruct、Phi-4 mini Instruct，均为宽松开源许可（Apache-2.0 / MIT）。
- 按电脑内存推荐合适的模型，每张卡片标注内存是否够用。
- 下载前显示许可，带进度、可取消，下载后校验 SHA-256。不需要安装 Ollama：第一次下载模型时会顺带获取 llama.cpp 推理程序。
- 「启动」后模型自动注册为本机供应商；可以「设为聊天模型」、停止、删除，或勾选「启动应用时自动运行」。

## Ollama（可选）

装了 Ollama 的话，可以在这里列出、拉取（带进度）和删除它的模型，和内置引擎互不依赖。默认地址 `http://127.0.0.1:11434`。请只拉取许可证允许你使用的模型。

给编程助手用 Ollama 的模型时，请以足够大的上下文启动：`OLLAMA_CONTEXT_LENGTH=20480 ollama serve`。默认上下文太小，长提示会被截断，导致空回复或答非所问。

## 离线模式

开启后等同于打开「仅本地模型可读文件」（见 [隐私与安全](privacy-security.md#仅本地模式)）：文件内容、图片、知识库片段只交给本机模型；内置模型正在运行时，它会被设为对话模型。

## 实现

- 推理服务是 llama.cpp 的 `llama-server`（MIT），只监听 `127.0.0.1` 的随机端口，以 OpenAI 兼容接口提供服务。
- 模型目录在 `apps/desktop-go/internal/core/local/llmcatalog.go`，每项都固定文件与 SHA-256；服务在 `internal/core/local/service.go`，视图在 `packages/ai-chat/src/components/LocalPanel`。
