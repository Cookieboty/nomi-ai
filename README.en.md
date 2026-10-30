<p align="center"><img src="docs/brand/nomi-wordmark.svg" alt="Nomi" width="320"></p>

<h1 align="center">Nomi·诺米</h1>

<p align="center"><b>One place. Every AI capability.</b></p>

<p align="center">
  <b>让每一种 AI 能力，都为你所用。</b><br>
  Models, coding agents and external tools, connected in one place, with Nomi by your side.
</p>

<p align="center">macOS · Windows · Linux　|　MIT</p>

<p align="center">
  <a href="https://github.com/Cookieboty/nomi-ai/stargazers"><img src="https://img.shields.io/github/stars/Cookieboty/nomi-ai?style=flat&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/issues"><img src="https://img.shields.io/github/issues/Cookieboty/nomi-ai?style=flat" alt="Open issues"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/releases"><img src="https://img.shields.io/github/downloads/Cookieboty/nomi-ai/total?style=flat" alt="Total downloads"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/releases/latest"><img src="https://img.shields.io/github/v/release/Cookieboty/nomi-ai?style=flat" alt="Latest release"></a>
  <a href="https://github.com/Cookieboty/nomi-ai/commits/main"><img src="https://img.shields.io/github/last-commit/Cookieboty/nomi-ai?style=flat" alt="Last commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Cookieboty/nomi-ai?style=flat" alt="License: MIT"></a>
</p>

<p align="center">
  <a href="https://withnomi.app">Website</a> ·
  <a href="https://github.com/Cookieboty/nomi-ai/releases/latest">Download</a> ·
  <a href="https://withnomi.app/features">Features</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://withnomi.app/changelog">Changelog</a> ·
  <a href="https://withnomi.app/privacy">Privacy</a>
</p>

<p align="center"><a href="README.md">中文</a> · <b>English</b></p>

## Screenshots

<table>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/screenshots/v1.2.0-workspace.webp" alt="Three-column workspace" width="49%">
      <img src="docs/screenshots/coding-agent.webp" alt="Coding agent chat" width="49%"><br>
      <sub>Three-column workspace · Coding agents</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/mascot.webp" alt="Desktop companion"><br><sub>Desktop companion</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/chat.webp" alt="Chat window"><br><sub>AI chat</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/knowledge.webp" alt="Knowledge base"><br><sub>Knowledge base</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="3">
      <img src="docs/screenshots/settings-providers.webp" alt="Providers & models" width="32%">
      <img src="docs/screenshots/local-models.webp" alt="Local models" width="32%">
      <img src="docs/screenshots/permission-modes.webp" alt="Permission modes" width="32%"><br>
      <sub>Providers & models · Local models · Permission modes</sub>
    </td>
  </tr>
</table>

More UI shots live in [docs/screenshots](docs/screenshots/). Full feature docs: [docs/README.md](docs/README.md) and the [website features page](https://withnomi.app/features).

## Highlights

Nomi is your AI work companion: a desktop AI workspace that connects models, coding agents and external tools — with an animated, talking Nomi on your desktop. Use the cloud models you already have, local models, or both.

- **🧸 Desktop companion** — full-body Rive character with expressions and lip-sync; scalable, playful interactions, chat bubbles; drop a file on her for a quick summary
- **💬 AI chat** — streaming replies, image Q&A, `/` commands and first-run onboarding; themes and chat backgrounds
- **🧑‍💻 Coding agents** — Claude Code / Codex / Gemini / Grok / dsh in one window; permission modes; three-column workspace for diffs and changes (see [coding workspace](docs/features/coding-workspace.md))
- **🔑 Multi-model** — presets for OpenAI, Anthropic, DeepSeek, Kimi, Zhipu, Tongyi, Doubao, Ollama, and more; multi-key failover; keys stored in the OS keychain
- **📚 Knowledge & memory** — folder Q&A with clickable citations; chats distilled into long-term memory; profile exportable
- **🏠 Local models** — one-click small open-source models or Ollama management; run with local models only
- **🧩 MCP · skills · automation** — manage MCP / SKILL.md in the UI; controlled file access, browser, and code sandbox with a local audit log
- **🎙️ Voice · reminders · privacy** — local/cloud speech in and out; reminders and scheduled jobs; data is stored locally by default, secrets are protected before they leave, and you can let only local models read your files

## Download

Grab an installer from [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest):

| System                | Installer                  | Notes                  |
| --------------------- | -------------------------- | ---------------------- |
| macOS · Apple Silicon | `Nomi-<version>-arm64.dmg` | Drag into Applications |
| macOS · Intel         | `Nomi-<version>.dmg`       | Same as above          |
| Windows 10+ (x64)     | `Nomi-Setup-<version>.exe` | Run the installer      |
| Linux (x64)           | `Nomi-<version>.AppImage`  | `chmod +x`, then run   |

> **macOS says Nomi “is damaged”?** Builds are not Apple-notarized yet. Move Nomi into Applications, then:
>
> ```bash
> sudo xattr -dr com.apple.quarantine /Applications/Nomi.app
> ```
>
> **Windows SmartScreen?** Installers are not code-signed yet. After confirming the download is from this repo’s Releases, choose “More info → Run anyway”.

## Quick start

1. Install and open Nomi; finish onboarding (language, theme, character).
2. Under Settings → Models & providers, add a provider and API key — or download a local model in the Local models tab.
3. Click Nomi or press `Ctrl/⌘+N` to chat; `Ctrl/⌘+K` opens the command palette.

More detail: [Getting started](docs/getting-started.md).

## Build from source

Requires Node.js ≥ 22.12 and pnpm 9 (`corepack enable`).

```bash
git clone https://github.com/Cookieboty/nomi-ai.git && cd nomi-ai
corepack enable
pnpm install
pnpm dev          # development
pnpm test         # tests
pnpm package      # package → dist/
```

Run `pnpm run doctor` to check your environment. Packaging: [docs/RELEASE.md](docs/RELEASE.md). Dev guides: [docs/development](docs/development/).

## Contact

Scan with WeChat to add the authors:

<table>
  <tr>
    <td align="center"><img src="docs/contact/qr-author-yxf.png" alt="Author WeChat · 言萧凡" width="160"><br><sub>言萧凡</sub></td>
    <td align="center"><img src="docs/contact/qr-author.png" alt="Author WeChat · Tomo" width="160"><br><sub>Tomo</sub></td>
  </tr>
</table>

Bugs and ideas → [GitHub Issues](https://github.com/Cookieboty/nomi-ai/issues). PRs welcome.

## License & acknowledgments

[MIT](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Design credits (e.g. gateway): [CREDITS.md](CREDITS.md).

Built on Electron, React, Vite, Vercel AI SDK, MCP, whisper.cpp / llama.cpp, Rive, and other open-source projects.

## Links

- [Website](https://withnomi.app) · [Features](https://withnomi.app/features) · [Privacy](https://withnomi.app/privacy)
- [Docs](docs/README.md) · [Changelog](CHANGELOG.md) · [Website changelog](https://withnomi.app/changelog)
- [中文 README](README.md)
