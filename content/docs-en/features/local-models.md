# Local Models

Entry point: **Settings → Models & Agents → Local Models**, or press `Ctrl/⌘+Shift+J` to jump straight there. Once a model is downloaded, it works completely offline.

## One-Click Open-Source Small Models

- Built-in model catalog: Qwen3 0.6B / 1.7B / 4B, Qwen2.5 1.5B Instruct, SmolLM2 1.7B Instruct, and Phi-4 mini Instruct—all under permissive open-source licenses (Apache-2.0 / MIT).
- Recommends suitable models based on your computer's RAM, with each card indicating whether memory is sufficient.
- Displays the license before download, supports progress tracking and cancellation, and verifies SHA-256 after download. Ollama is not required: downloading a model for the first time automatically fetches the `llama.cpp` inference runtime.
- After clicking **Start**, the model is automatically registered as a local provider; you can click **Use for chat**, stop it, delete it, or check **Run when the app starts**.

## Ollama (Optional)

If Ollama is installed, you can list, pull (with progress), and delete its models here, independent of the built-in engine. Default address: `http://127.0.0.1:11434`. Only pull models whose licenses permit your intended use.

When using an Ollama model with an agent, start Ollama with a sufficiently large context window: `OLLAMA_CONTEXT_LENGTH=20480 ollama serve`. The default context length is too small, causing long prompts to be truncated and leading to empty or off-target replies.

## Offline Mode

Enabling offline mode is equivalent to turning on **Only local models can read files** (see [Privacy & Security](privacy-security.md#local-only-mode)): file contents, images, and knowledge base snippets are sent only to local models. If a built-in model is running, it is set as the chat model.

## Implementation

- Inference runs via `llama.cpp`'s `llama-server` (MIT), listening only on a random port on `127.0.0.1` and exposing an OpenAI-compatible endpoint.
- Model catalog: `apps/desktop-go/internal/core/local/llmcatalog.go` (each entry pins its file and SHA-256); service: `internal/core/local/service.go`; UI: `packages/ai-chat/src/components/LocalPanel`.
