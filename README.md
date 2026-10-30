<p align="center"><img src="docs/brand/nomi-wordmark.svg" alt="Nomi" width="320"></p>

<h1 align="center">Nomi·诺米</h1>

<p align="center"><b>One place. Every AI capability.</b></p>

<p align="center">
  <b>让每一种 AI 能力，都为你所用。</b><br>
  多家模型、编程助手与外部工具，都接到一处，由诺米陪你调度。
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
  <a href="https://withnomi.app">官网</a> ·
  <a href="https://github.com/Cookieboty/nomi-ai/releases/latest">下载</a> ·
  <a href="https://withnomi.app/features">功能</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="https://withnomi.app/changelog">更新日志</a> ·
  <a href="https://withnomi.app/privacy">隐私</a>
</p>

<p align="center"><b>中文</b> · <a href="README.en.md">English</a></p>

## 截图

<table>
  <tr>
    <td align="center" colspan="2">
      <img src="docs/screenshots/v1.2.0-workspace.webp" alt="三栏工作区" width="49%">
      <img src="docs/screenshots/coding-agent.webp" alt="编程助手对话" width="49%"><br>
      <sub>三栏工作区 · 编程助手</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="33%"><img src="docs/screenshots/mascot.webp" alt="桌面伙伴"><br><sub>桌面伙伴</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/chat.webp" alt="对话窗口"><br><sub>AI 对话</sub></td>
    <td align="center" width="33%"><img src="docs/screenshots/knowledge.webp" alt="知识库"><br><sub>知识库</sub></td>
  </tr>
  <tr>
    <td align="center" colspan="3">
      <img src="docs/screenshots/settings-providers.webp" alt="供应商与模型" width="32%">
      <img src="docs/screenshots/local-models.webp" alt="本地模型" width="32%">
      <img src="docs/screenshots/permission-modes.webp" alt="权限模式" width="32%"><br>
      <sub>供应商与模型 · 本地模型 · 权限模式</sub>
    </td>
  </tr>
</table>

更多界面见 [docs/screenshots](docs/screenshots/)，完整功能说明见 [文档](docs/README.md) 与 [官网功能页](https://withnomi.app/features)。

## 核心能力

Nomi·诺米 是你的 AI 工作伙伴：一个运行在你电脑上的桌面 AI 工作台，把模型、编程助手和外部工具接到一处；还有一位会动、会说话的 Nomi 陪在桌面上。云端大模型和本地模型都可以接。

- **🧸 桌面伙伴** — 全身 2D 立绘（也可切换 Rive 动画），表情与口型同步；可缩放、拖拽互动、气泡回复；拖文件给她直接总结
- **💬 AI 对话** — 流式输出、图片提问、`/` 命令与首次引导；主题与聊天背景可定制
- **🧑‍💻 编程助手** — 一个窗口并行 Claude Code / Codex / Gemini / Grok / dsh；权限模式一键切换；三栏工作区看 Diff 与改动（详见 [编程工作台](docs/features/coding-workspace.md)）
- **🔑 多模型** — OpenAI、Anthropic、DeepSeek、Kimi、智谱、通义、豆包、Ollama 等预设；多 Key 自动切换；密钥存系统钥匙串
- **📚 知识库与记忆** — 文件夹问答带可点击引用；对话自动整理成长期记忆，档案可导出
- **🏠 本地模型** — 一键下载开源小模型或管理 Ollama，也能只用本地模型
- **🧩 MCP · 技能 · 自动化** — 图形化管理 MCP / SKILL.md；受控读文件、浏览器与代码沙箱，操作有审计日志
- **🎙️ 语音 · 提醒 · 隐私** — 本地/云端语音输入与播报；提醒与定时任务；数据默认保存在本机，外发前对密钥做保护，也可只让本地模型读取文件

## 下载安装

前往 [GitHub Releases](https://github.com/Cookieboty/nomi-ai/releases/latest) 按系统下载：

| 系统               | 安装包                  | 说明              |
| ------------------ | ----------------------- | ----------------- |
| macOS · Apple 芯片 | `Nomi-<版本>-arm64.dmg` | 拖进「应用程序」  |
| macOS · Intel      | `Nomi-<版本>.dmg`       | 同上              |
| Windows 10+（x64） | `Nomi-Setup-<版本>.exe` | 运行安装向导      |
| Linux（x64）       | `Nomi-<版本>.AppImage`  | `chmod +x` 后运行 |

> **macOS 提示「已损坏」？** 当前包尚未公证。拖到「应用程序」后执行：
>
> ```bash
> sudo xattr -dr com.apple.quarantine /Applications/Nomi.app
> ```
>
> **Windows 弹出 SmartScreen？** 当前包尚未代码签名。确认来自本仓库 Releases 后，选「更多信息 → 仍要运行」。

## 快速开始

1. 安装并打开 Nomi，完成首次引导（语言、主题、角色）。
2. 在「设置 → 模型与供应商」添加供应商与 API Key，或在「本机模型」下载本地模型。
3. 点击 Nomi 或 `Ctrl/⌘+N` 开始对话；`Ctrl/⌘+K` 打开命令面板。

更细的步骤见 [快速上手](docs/getting-started.md)。

## 从源码构建

需要 Node.js ≥ 22.12 与 pnpm 9（`corepack enable`）。

```bash
git clone https://github.com/Cookieboty/nomi-ai.git && cd nomi-ai
corepack enable
pnpm install
pnpm dev          # 开发模式
pnpm test         # 测试
pnpm package      # 打包到 dist/
```

`pnpm run doctor` 可检查开发环境。打包与发布见 [docs/RELEASE.md](docs/RELEASE.md)；开发指南见 [docs/development](docs/development/)。

## 联系与交流

微信扫码添加作者：

<table>
  <tr>
    <td align="center"><img src="docs/contact/qr-author-yxf.png" alt="作者微信 · 言萧凡" width="160"><br><sub>言萧凡</sub></td>
    <td align="center"><img src="docs/contact/qr-author.png" alt="作者微信 · Tomo" width="160"><br><sub>Tomo</sub></td>
  </tr>
</table>

问题与建议请提 [GitHub Issues](https://github.com/Cookieboty/nomi-ai/issues)。欢迎 PR。

## 许可证与致谢

[MIT](LICENSE)。第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；网关等设计参考致谢见 [CREDITS.md](CREDITS.md)。

构建于 Go、Wails、Electron、React、Vite、Vercel AI SDK、MCP、whisper.cpp / llama.cpp、Rive 等开源项目之上。

## 链接

- [官网](https://withnomi.app) · [功能](https://withnomi.app/features) · [隐私](https://withnomi.app/privacy)
- [文档](docs/README.md) · [更新日志](CHANGELOG.md) · [官网更新日志](https://withnomi.app/changelog)
- [English README](README.en.md)
