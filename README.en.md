<p align="center"><img src="docs/brand/nomi-wordmark.svg" alt="Nomi" width="320"></p>

<h1 align="center">Nomi</h1>

<p align="center">
  <b>An AI companion on your desktop: bring any model, let it do the work, and let it hand specialist jobs to specialist AIs.</b><br>
  Models, coding agents, MCP and local tools in one place, coordinated by Nomi.
</p>

<p align="center">macOS · Windows · Linux　|　Go + Wails core, 39 MB installer　|　MIT</p>

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
  <img src="docs/screenshots/chat.webp" alt="Chatting with Nomi" width="44%">
  <img src="docs/screenshots/v1.2.0-workspace.webp" alt="Three-column coding workspace" width="54%">
</p>

## Why Nomi

### 1. Connect a model once, every AI can use it

Add a provider once (pick a preset or enter a URL, paste a key) and Nomi itself plus Claude Code, Codex, Gemini CLI, Grok and dsh can all use any of its models, or switch everything to local models.
The local gateway detects and translates between **Anthropic Messages / OpenAI Responses / OpenAI Chat Completions / Gemini generateContent**; streaming, tool calls, reasoning, images and context compaction keep working, so you can use DeepSeek, GLM, Kimi or Qwen right inside Claude Code.
Third-party routing applies only to the process Nomi launches; it never edits the CLI's global config or touches official sign-ins.
Third-party providers can also put an "Add to Nomi" link on their own site: one-click import of the endpoint and key, or web authorization (OAuth + PKCE, so the key never appears in a link). Either way, nothing is saved until you confirm in Nomi.
→ [Unified gateway design](docs/development/gateway.md) · [Third-party provider links](docs/integrations/provider-link.md)

### 2. Nomi is an agent itself

It reads and writes files, runs commands, drives a browser, calls MCP servers and skills, remembers what you've told it (long-term memory), answers from your folders with clickable citations, and draws, edits images and sets reminders.
Tools are offered on demand: small talk sends about 2K tokens of tool definitions, and more open up only when the chat needs them.
→ [Docs](docs/README.md)

### 3. Specialist jobs go to specialist AIs

For coding, Nomi delegates to Claude Code, Codex and other coding agents, and you can open or stop each subtask's full conversation. You can also open a coding-agent session directly: five CLIs connect through four session drivers (ACP, stream-json, Codex app-server, exec), many sessions run in parallel, and the three-column workspace shows the diff and lets you commit or undo; sessions started in a terminal or IDE carry on here too.
Coding agents are the strongest kind of specialist today; the connection layer is a plugin system, so more can join.
→ [Coding agents](docs/features/coding-agents.md) · [Coding-agent integration](docs/development/coding-agents.md)

### 4. Let it work, keep the boundaries

Before a command runs, a helper model rates its risk: low risk runs, high risk asks you, and **once a turn has read external content (web pages, MCP results, skill files), medium-risk commands ask you too**, so a prompt injection can't use Nomi to run commands.
Chats, memory and the knowledge base stay on your machine by default; secrets are hidden before anything reaches a third-party model; API keys live in the system keychain.
→ [Privacy and security](docs/features/privacy-security.md)

### 5. Light: a Go core on the native WebView

A Go core on [Wails v3](https://v3.wails.io) with no bundled Chromium (there is no Electron build from 2.2.0 on). Compared with the Electron build of the same version, macOS, Apple silicon:

|                                 | Go build    | Electron build |
| ------------------------------- | ----------- | -------------- |
| DMG                             | **24.5 MB** | 138.4 MB       |
| Installed size                  | **49 MiB**  | 315 MiB        |
| Memory 30 s after launch        | **177 MiB** | 284 MiB        |
| Idle CPU (one core)             | **3.2%**    | 8.2%           |
| Launch until the window appears | **0.55 s**  | 0.82 s         |

Sizes are measured from the v2.1.2 arm64 installers of both builds; memory, CPU and launch time come from a same-machine comparison of v2.0.5 and 2.0.4.

## Architecture

```mermaid
flowchart LR
  subgraph View["View (React 19)"]
    Chat["Chat / coding workspace"]
    Mascot["Desktop character"]
  end
  subgraph Core["Core (Go)"]
    Contract["Typed contract<br/>(surfaces / dangerous checks)"]
    Agents["Coding-agent drivers<br/>ACP · stream-json · app-server · exec"]
    Tools["Tools: files · commands · browser · MCP · skills<br/>command risk review + external-content taint"]
    Mem["Memory · knowledge base · schedule · images"]
    GW["Unified gateway<br/>Messages ⇄ Responses ⇄ Chat ⇄ Gemini"]
  end
  CLI["Claude Code · Codex · Gemini CLI · Grok · dsh"]
  Up["OpenAI · Anthropic · DeepSeek · GLM · Kimi · Qwen<br/>· relays · Ollama / local models"]
  View -- "loopback WebSocket + one-time token" --> Contract
  Contract --> Agents & Tools & Mem
  Agents --> CLI
  CLI -- "third-party requests" --> GW
  Tools -- "delegates subtasks" --> Agents
  Tools & Mem --> GW
  GW --> Up
```

The view talks to the core through one typed contract instead of ad-hoc IPC channels; which windows may call which procedures, and which ones are dangerous, is declared in the contract. See [Architecture](docs/development/architecture.md) and [the app contract](docs/development/contract.md).

## Features at a glance

- **Models**: presets for OpenAI, Anthropic, DeepSeek, Kimi, Zhipu, Qwen, Doubao, Ollama and more; automatic multi-key rotation; usage and cost recorded per upstream request
- **Third-party provider links**: relays and model platforms add themselves to Nomi with `nomi://provider/import` (one-click import) or `nomi://provider/connect` (web authorization); Cherry Studio's import format also works. See [Third-party provider integration](#third-party-provider-integration) below
- **Local models**: one-click open-source models (llama.cpp) or Ollama; run local-only, or let only local models read your files
- **Images**: draw, edit and use reference images right in a Nomi chat, with an image model matched to the chat model's vendor; an asset library keeps every generated image
- **Knowledge base and memory**: ask questions over a folder with clickable citations; chats turn into exportable long-term memory
- **MCP and skills**: manage MCP servers and `SKILL.md` skills in the UI; tool calls are audit-logged
- **Voice and reminders**: local whisper.cpp or cloud speech input, read-aloud replies; reminders and scheduled tasks
- **Desktop character**: Nomi lives on your desktop as 2D art or a Rive animation with expressions and lip sync; drop a file on it to get a summary; swap the character with a [character pack](docs/character-pack/README.md)

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/coding-agent.webp" alt="Coding agent chat"><br><sub>Coding agents</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/settings-providers.webp" alt="Providers and models"><br><sub>Providers and models</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/mascot.webp" alt="Desktop character"><br><sub>Desktop character</sub></td>
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

1. Open Nomi and finish onboarding (language, theme, character).
2. Add a provider and API key in Settings → Models & providers, or download a local model under Local models if you'd rather not use a key.
3. Chat with Nomi: `Ctrl/⌘+N` for a new chat, `Ctrl/⌘+K` for the command palette.
4. Use a coding agent: open a Claude Code / Codex session, pick a working folder, and use your official account or the third-party model from step 2.

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

Relays and model platforms can put an "Add to Nomi" button on their own site so users add them in one click. There are two ways; **both end in a confirmation dialog in Nomi, and nothing is saved until the user confirms**. Full spec: [docs/integrations/provider-link.md](docs/integrations/provider-link.md).

### Option A: direct import (a few lines of template)

```
nomi://provider/import?v=1&data=<base64url(UTF-8 JSON)>
```

```jsonc
{
  "name": "Example AI", // required, up to 64 characters
  "homepage": "https://example.com", // optional, shown in the dialog
  "urls": {
    // at least one; the gateway's four protocols
    "chat": "https://api.example.com/v1", // OpenAI Chat Completions
    "responses": "https://api.example.com/v1", // OpenAI Responses
    "messages": "https://api.example.com", // Anthropic Messages
    "gemini": "https://api.example.com/gemini", // Gemini
  },
  "key": "sk-…", // required
  "models": ["gpt-5", "claude-sonnet-5-5"], // optional, prefilled models
}
```

- `data` is base64url (`+/` become `-_`, `=` padding optional); standard base64 also works.
- Cherry Studio's flat shape `{ "name", "baseUrl", "apiKey", "type"? }` is accepted: `type` `anthropic` maps to `messages`, `gemini` to `gemini`, anything else to `chat`. Templates such as New API's chat links only need the scheme changed to `nomi://provider/import`.
- The key travels in the link; use option B to avoid that.

### Option B: web authorization (the key never enters a link)

1. Link to `nomi://provider/connect?v=1&issuer=https://example.com` (`issuer` must be an https origin with no path); users can also enter your domain under Nomi's Settings → Models & providers → Authorize on web.
2. Serve `https://example.com/.well-known/nomi-provider.json`:

   ```jsonc
   {
     "version": 1,
     "name": "Example AI",
     "urls": { "chat": "https://api.example.com/v1", "messages": "https://api.example.com" },
     "models": ["…"], // optional
     "authorization_endpoint": "https://example.com/nomi/authorize",
     "token_endpoint": "https://example.com/api/nomi/token",
   }
   ```

   Both endpoints must be https on the `issuer` host or one of its subdomains.

3. After the user confirms in Nomi, Nomi opens
   `{authorization_endpoint}?response_type=code&client_id=nomi&redirect_uri=nomi://provider/callback&state=…&code_challenge=…&code_challenge_method=S256` in the browser.
4. Once the user signs in and approves on your page, redirect to `nomi://provider/callback?code=…&state=…` (or `error=access_denied&state=…` if they decline).
5. Nomi sends `POST application/x-www-form-urlencoded` to `token_endpoint`:
   `grant_type=authorization_code&code=…&redirect_uri=nomi://provider/callback&client_id=nomi&code_verifier=…`,
   and you return `{ "api_key": "sk-…", "name"?: "…", "urls"?: {…}, "models"?: […] }` (`key` / `access_token` also work; returned `urls` override the manifest's for the same protocol).
6. The same confirmation dialog as option A appears; the provider is saved once the user confirms.

### How Nomi handles links

- **Always confirmed first**: the dialog shows the name, the source (option A: "web link, the originating site can't be verified"; option B: the issuer domain), each endpoint, the masked key and the model count. Option B also asks before opening the browser.
- **Endpoints**: `https` only, no username or password, not this computer or the local network (add local services manually in Settings). Authorization and key-exchange requests don't follow redirects.
- **Same endpoint means update**: if a third-party provider already has one of the endpoints (ignoring a trailing `/`), Nomi updates it instead of creating another: it adds the new key (skipping a key it already has) and any missing endpoints and models.
- **Limits**: the whole link ≤ 16 KB; keys are 8–512 printable characters; up to 200 models; at most 5 links waiting for confirmation, each expiring after 10 minutes; each authorization `state` is valid for 10 minutes and can be used once.
- **No traces**: logs record only the link type, never the link itself; the key stays in the core, the UI only sees it masked, and it's stored in the system keychain.
- **Cold start**: a link clicked while Nomi isn't running is kept and shown once the chat window opens.

## Contact

Questions and ideas go to [GitHub Issues](https://github.com/Cookieboty/nomi-ai/issues). To reach the authors on WeChat:

<table>
  <tr>
    <td align="center"><img src="docs/contact/qr-author-yxf.png" alt="Author WeChat · 言萧凡" width="160"><br><sub>言萧凡</sub></td>
    <td align="center"><img src="docs/contact/qr-author.png" alt="Author WeChat · Tomo" width="160"><br><sub>Tomo</sub></td>
  </tr>
</table>

## Acknowledgements

- **Sponsor**: [Amux AI](https://amux.ai) sponsors Nomi's development.
- **Community**: [Linux.do](https://linux.do), whose members have shared a great deal of feedback and ideas.

Nomi is built on Go, Wails, React, Vite, Vercel AI SDK, MCP, whisper.cpp / llama.cpp, Rive and other open-source projects; design credits are in [CREDITS.md](CREDITS.md).

## License

[MIT](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
