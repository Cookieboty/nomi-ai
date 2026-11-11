<p align="center"><img src="docs/brand/nomi-wordmark.svg" alt="Nomi" width="320"></p>

<h1 align="center">Nomi</h1>

<p align="center">
  <b>One place. Every AI capability.</b><br>
  让每一种 AI 能力，都为你所用
</p>

<p align="center">
  Put Claude Code and Codex on one board and run them side by side. Connect a model once: official, third-party, or local.<br>
  The desktop character is optional. Turn it off if you do not want it.
</p>

<p align="center">macOS · Windows · Linux　|　Go + Wails core, ~25 MB installer　|　MIT</p>

<p align="center">
  <a href="https://github.com/Cookieboty/nomi-ai/stargazers"><img src="https://img.shields.io/github/stars/Cookieboty/nomi-ai?style=flat&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/releases"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FCookieboty%2Fnomi-ai%2Fbadges%2Fdownloads.json&style=flat" alt="Downloads"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/releases/latest"><img src="https://img.shields.io/github/v/release/Cookieboty/nomi-ai?style=flat" alt="Latest release"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/commits/main"><img src="https://img.shields.io/github/last-commit/Cookieboty/nomi-ai?style=flat" alt="Last commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Cookieboty/nomi-ai?style=flat" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="https://github.com/Cookieboty/nomi-ai/releases/latest">Download</a> ·
  <a href="https://withnomi.app">Website</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/development/architecture.md">Architecture</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center"><a href="README.md">中文</a> · <b>English</b></p>

<p align="center">
  <img src="docs/screenshots/agent-board.webp" alt="Agent board: who is working, how far along, and what they use" width="49%">
  <img src="docs/screenshots/workspace.webp" alt="Three-column coding workspace" width="49%">
</p>

## Every AI capability, in one place

| Capability        | In Nomi                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coding agents** | Claude Code, Codex, Gemini CLI, Grok and dsh, many sessions in parallel. Sessions already open in a terminal or IDE show up on the board, read-only |
| **Models**        | Any provider, relay or local model: connect it once and every coding agent and Nomi can use it                                                      |
| **Tools**         | MCP, skills, browser, files and commands, managed in the UI with an audit log                                                                       |
| **Nomi**          | An agent itself: memory, knowledge base, images, reminders, and it hands jobs to coding agents                                                      |

They all live in one **agent workbench**: who is working, how far along, how much they use and where they're stuck, at a glance.

## Why Nomi

### 1. Every working agent, in one place

The **agent board** puts everything at work together: Nomi's chats and background runs, dispatched and workbench coding agents, and sessions you started yourself in a terminal or IDE (read-only). Each card shows status, source folder, memory and CPU, and anything waiting on you comes first.
When memory runs low it pauses the coding agents Nomi dispatched and resumes them where they stopped once it recovers; you can pause and resume by hand any time. A load indicator stays in the title bar.
Coding-agent sessions open right in the workbench: five CLIs connect through four session drivers (ACP, stream-json, Codex app-server, exec), many sessions run in parallel, and the three-column workspace shows the diff and lets you commit or undo. The connection layer is a plugin system, so more agents can join.
→ [Coding agents](docs/features/coding-agents.md) · [Agent board](docs/development/agent-board.md) · [Coding-agent integration](docs/development/coding-agents.md)

### 2. Connect a model once, every AI can use it

Add a provider once (pick a preset or enter a URL, paste a key) and Claude Code, Codex, Gemini CLI, Grok, dsh and Nomi can all use any of its models, or switch everything to local models.
The local gateway detects and translates between **Anthropic Messages / OpenAI Responses / OpenAI Chat Completions / Gemini generateContent**; streaming, tool calls, reasoning, images and context compaction keep working, so you can use DeepSeek, GLM, Kimi or Qwen right inside Claude Code.
Third-party routing applies only to the process Nomi launches; it never edits the CLI's global config or touches official sign-ins.
→ [Unified gateway design](docs/development/gateway.md) · [Providers and models](docs/features/providers.md)

### 3. Let it run fully automatic, keep the boundaries

On macOS coding agents run in a **system sandbox** (on by default): they can't read SSH and Git credentials, cloud credentials, browser data or `.env` files, and can only write to the project folder; when something is blocked you allow it for this session or "always" (this project only) right in the chat, and the agent carries on. The working folder must be a project folder, and agents don't inherit tokens or keys from your environment. With the sandbox on, coding agents can safely run fully automatic.
Before a command runs, a helper model rates its risk: low risk runs, high risk asks you, and **once a turn has read external content (web pages, MCP results, skill files), medium-risk commands ask you too**, so a prompt injection can't use Nomi to run commands.
Chats, memory and the knowledge base stay on your machine by default; secrets are hidden before anything reaches a third-party model; API keys live in the system keychain.
→ [Privacy and security](docs/features/privacy-security.md) · [Local protection for coding agents](docs/features/coding-agents.md#本机保护)

### 4. Nomi is an agent too

It reads and writes files, runs commands, drives a browser, calls MCP servers and skills, remembers what you've told it (long-term memory), answers from your folders with clickable citations, and draws, edits images and sets reminders.
For coding it delegates to coding agents: each sub-task opens in its own column beside the chat, where you can interject, stop it or have it run another turn, and every result comes back to the main chat. It schedules with the agent board too.
Tools are offered on demand: small talk sends about 2K tokens of tool definitions, and more open up only when the chat needs them.
→ [Chat](docs/features/chat.md) · [Memory](docs/features/memory.md) · [Knowledge base](docs/features/knowledge-base.md)

### 5. Optional: Nomi on your desktop

The desktop character is optional. Turn it on and a small transparent window stays on the desktop, with expressions, gestures and lip sync. Leave it off and the workbench works the same. When it is off, it does not speak.
With it on, plenty happens without opening the main window: it gives a thumbs-up when a task finishes and apologizes when one fails, so you don't have to watch the board; the first lines of a reply show in a bubble beside it; drop a file on it for a summary; talk to it by voice and hear replies read aloud; double-click to open the chat.
→ [Desktop character](docs/features/mascot.md) · [Voice](docs/features/voice.md)

### 6. Light: a Go core on the native WebView

A Go core on [Wails v3](https://v3.wails.io) with no bundled Chromium. On macOS, Apple silicon, the DMG is about 24.5 MB and about 49 MiB installed.

## Architecture

```mermaid
flowchart LR
  subgraph View["View (React 19)"]
    Bench["Agent workbench<br/>board · three-column workspace"]
    Chat["Nomi chat"]
    Mascot["Desktop character (optional)"]
  end
  subgraph Core["Core (Go)"]
    Contract["Typed contract<br/>(surfaces / dangerous checks)"]
    Fleet["Agent board · memory guard"]
    Agents["Coding-agent drivers<br/>ACP · stream-json · app-server · exec"]
    Tools["Tools: files · commands · browser · MCP · skills<br/>command risk review + external-content taint"]
    Mem["Memory · knowledge base · schedule · images"]
    GW["Unified gateway<br/>Messages ⇄ Responses ⇄ Chat ⇄ Gemini"]
  end
  CLI["Claude Code · Codex · Gemini CLI · Grok · dsh"]
  Up["OpenAI · Anthropic · DeepSeek · GLM · Kimi · Qwen<br/>· relays · Ollama / local models"]
  View -- "loopback WebSocket + one-time token" --> Contract
  Contract --> Fleet & Agents & Tools & Mem
  Fleet -- "pause / resume" --> Agents
  Agents --> CLI
  CLI -- "third-party requests" --> GW
  Tools -- "delegates subtasks" --> Agents
  Tools & Mem --> GW
  GW --> Up
```

The view talks to the core through one typed contract instead of ad-hoc IPC channels; which windows may call which procedures, and which ones are dangerous, is declared in the contract. See [Architecture](docs/development/architecture.md) and [the app contract](docs/development/contract.md).

## Features at a glance

**Agent workbench**

- **Agent board**: see who is working, how far along, and how much memory and CPU each one uses; a memory guard pauses and resumes automatically, with a load indicator in the title bar
- **Coding agents**: five CLIs, parallel sessions, a three-column workspace to review the diff, commit or undo; official accounts or third-party models; permission modes and a system sandbox
- **Tasks**: ongoing and scheduled tasks, run by Nomi or a coding agent

**Models and tools**

- **Models**: presets for OpenAI, Anthropic, DeepSeek, Kimi, Zhipu, Qwen, Doubao, Ollama and more; automatic multi-key rotation; usage and cost recorded per upstream request
- **Local models**: one-click open-source models (llama.cpp) or Ollama; run local-only, or let only local models read your files
- **MCP and skills**: manage MCP servers and `SKILL.md` skills in the UI, import them from other tools; tool calls are audit-logged
- **Third-party provider links**: relays and model platforms can offer an "Add to Nomi" link; see [Third-party provider integration](#third-party-provider-integration) below

**Nomi**

- **Chat**: reads and writes files, runs commands, drives a browser and delegates to coding agents; command palette and slash commands
- **Knowledge base and memory**: ask questions over a folder with clickable citations; chats turn into exportable long-term memory
- **Images**: draw, edit and use reference images, with an image model matched to the chat model's vendor; an asset library keeps them all
- **Voice and reminders**: local whisper.cpp or cloud speech input, read-aloud replies; reminders and quiet hours
- **Desktop character (optional)**: 2D art or a Rive animation with expressions and lip sync; its gestures tell you how tasks are going

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/coding-agent.webp" alt="Coding agent chat"><br><sub>Coding agents</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/settings-providers.webp" alt="Providers and models"><br><sub>Providers and models</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/mascot.webp" alt="Desktop character"><br><sub>Desktop character (optional)</sub></td>
  </tr>
</table>

More screenshots in [docs/screenshots](docs/screenshots/).

## Download

From [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest):

| System                | Installer                                              | Notes                                                  |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| macOS · Apple silicon | `Nomi-<version>-arm64.dmg`                             | Drag into Applications                                 |
| macOS · Intel         | `Nomi-<version>.dmg`                                   | Same                                                   |
| Windows 10+ (x64)     | `Nomi-Setup-<version>.exe`                             | Needs WebView2 (usually preinstalled on Windows 10/11) |
| Linux (x64)           | `Nomi-<version>.AppImage` / `nomi_<version>_amd64.deb` | `chmod +x` the AppImage                                |

Installed copies offer updates in-app.

> **macOS says the app is damaged?** The app is signed but not notarized yet. After moving it to Applications, run:
>
> ```bash
> sudo xattr -dr com.apple.quarantine /Applications/Nomi.app
> ```
>
> **Windows SmartScreen?** Once you've confirmed the installer came from this repo's Releases, choose "More info → Run anyway".

## Get started in 3 minutes

1. Open Nomi and finish onboarding (language and look, AI, personal). The desktop character is off by default.
2. Open a Claude Code / Codex session, pick a working folder and sign in with your official account to start; "Agents" in the left sidebar opens the board.
3. To switch models, add a provider and API key in Settings → Models & providers, or download a local model under Local models; coding agents and Nomi can all pick it.
4. Chat with Nomi: `Ctrl/⌘+N` for a new chat, `Ctrl/⌘+K` for the command palette. Don't want the desktop character? Close it from its toolbar's "More" menu.

More detail in [Getting started](docs/getting-started.md).

## Build from source

Needs Node.js ≥ 22.12, pnpm 9 (`corepack enable`), Go (see `apps/desktop-go/go.mod`) and a cgo toolchain (plus GTK3 and WebKitGTK 4.1 dev packages on Linux).

```bash
git clone https://github.com/Cookieboty/nomi-ai.git && cd nomi-ai
corepack enable && pnpm install
pnpm dev          # hot-reloads the UI, rebuilds on Go changes
pnpm test         # unit tests for the views and shared packages
(cd apps/desktop-go && go test ./...)   # Go core tests
```

`pnpm run doctor` checks your setup. Go details are in [apps/desktop-go](apps/desktop-go/README.md), packaging and releases in [docs/RELEASE.md](docs/RELEASE.md), and the developer guide in [docs/development](docs/development/). PRs welcome; see the conventions in [AGENTS.md](AGENTS.md) first.

## Third-party provider integration

Relays and model platforms can put an "Add to Nomi" button on their own site so users add them in one click:

- `nomi://provider/import`: import the endpoint and key directly, with a few lines of template; Cherry Studio's import format also works.
- `nomi://provider/connect`: web authorization (OAuth + PKCE), so the key never appears in a link.

**Both end in a confirmation dialog in Nomi, and nothing is saved until the user confirms.** Link format, authorization flow and handling rules: [Third-party provider links](docs/integrations/provider-link.md).

## Contact

Questions and ideas go to [GitHub Issues](https://github.com/Cookieboty/nomi-ai/issues). To reach the authors on WeChat:

<table>
  <tr>
    <td align="center"><img src="docs/contact/qr-author-yxf.png" alt="Author WeChat · 言萧凡" width="160"><br><sub>言萧凡</sub></td>
    <td align="center"><img src="docs/contact/qr-author.png" alt="Author WeChat · Tomo" width="160"><br><sub>Tomo</sub></td>
  </tr>
</table>

## Acknowledgements

- **Sponsors**: [Amux AI](https://amux.ai) and [@zihe-xu](https://github.com/zihe-xu) sponsor Nomi's development.
- **Community**: [Linux.do](https://linux.do), whose members have shared a great deal of feedback and ideas.

<a href="https://github.com/zihe-xu"><img src="https://avatars.githubusercontent.com/u/25056086?v=4&s=96" width="48" height="48" alt="zihe-xu" /></a>

Nomi is built on Go, Wails, React, Vite, Vercel AI SDK, MCP, whisper.cpp / llama.cpp, Rive and other open-source projects; design credits are in [CREDITS.md](CREDITS.md).

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
