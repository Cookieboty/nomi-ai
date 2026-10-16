/**
 * Nomi·诺米 site i18n — lightweight data-i18n + localStorage
 * Default: zh, or browser language if en*
 */
(function () {
  var STORAGE_KEY = "nomi-lang";

  var dict = {
    zh: {
      "meta.home.title": "Nomi·诺米 — 你的桌面 AI 伙伴",
      "meta.home.desc": "Nomi·诺米 — 你的桌面 AI 伙伴。住在桌面，懂你所想，帮你做到。本地优先，Windows / macOS / Linux。",
      "meta.features.title": "功能 — Nomi·诺米",
      "meta.features.desc": "Nomi·诺米核心能力：桌面伙伴与语音、对话与屏幕问答、知识库与记忆、自动化与 MCP、本地优先与模型自由。",
      "meta.download.title": "下载 — Nomi·诺米",
      "meta.download.desc": "下载 Nomi·诺米最新版：Linux AppImage、Windows 安装包与 macOS DMG。",
      "meta.docs.title": "文档 — Nomi·诺米",
      "meta.docs.desc": "Nomi·诺米文档中心：快速开始、功能说明、品牌规范与发布说明。",
      "meta.privacy.title": "隐私 — Nomi·诺米",
      "meta.privacy.desc": "Nomi·诺米隐私承诺：本地优先，对话与记忆只保存在你的电脑上。",

      "nav.home": "首页",
      "nav.features": "功能",
      "nav.download": "下载",
      "nav.docs": "文档",
      "nav.privacy": "隐私",
      "nav.cta": "下载 Nomi",
      "nav.ctaReleases": "前往 Releases",
      "nav.openMenu": "打开菜单",
      "nav.main": "主导航",
      "nav.lang": "语言",
      "logo.home": "Nomi·诺米 首页",

      "hero.badge": "本地优先 · Windows / macOS / Linux",
      "hero.title": "Nomi·诺米",
      "hero.slogan": "你的桌面 AI 伙伴",
      "hero.promise": "住在桌面，懂你所想，帮你做到。",
      "hero.download": "立即下载",
      "hero.github": "在 GitHub 查看",
      "hero.meta.mit": "MIT 开源",
      "hero.meta.bilingual": "中文 / English",
      "hero.meta.models": "云端模型 + 本地模型",
      "hero.quote": "「我在这里，陪你把每一个任务都变成小小的成就。」",
      "hero.avatarAlt": "Nomi·诺米 官方品牌立绘",

      "pillars.label": "三大支柱",
      "pillars.title": "任务管理 · 智能执行 · 情感陪伴",
      "pillars.lead": "Nomi 首先要有用：每一句暖心的话旁边，都要有一件真正帮上忙的事。",
      "pillars.tasks.title": "任务管理",
      "pillars.tasks.desc": "日程、提醒与主动简报，帮你把想法排进每一天。",
      "pillars.exec.title": "智能执行",
      "pillars.exec.desc": "读文件、看屏幕、管知识库，把想法真正变成行动。",
      "pillars.care.title": "情感陪伴",
      "pillars.care.desc": "会动、会说话的桌面伙伴，记得你，也陪你完成小成就。",

      "features.label": "功能亮点",
      "features.title": "桌面上的完整 AI 工作台",
      "features.lead": "从对话到自动化，从云端到完全离线——按你的方式使用。",
      "features.mascot.title": "桌面伙伴",
      "features.mascot.desc": "会眨眼、会呼吸的分层立绘；摸头互动、对话气泡、拖文件总结。",
      "features.chat.title": "AI 对话",
      "features.chat.desc": "流式输出、会话列表、框选屏幕提问，干净好用的对话窗口。",
      "features.providers.title": "多供应商",
      "features.providers.desc": "OpenAI、Anthropic、DeepSeek、Ollama 等一键切换；Key 加密保存在本机。",
      "features.knowledge.title": "知识库与记忆",
      "features.knowledge.desc": "基于你的文件夹与笔记回答，并标出引用；长期记忆可看可改可删。",
      "features.screen.title": "屏幕问答",
      "features.screen.desc": "框选屏幕直接提问；可选本机屏幕记忆，问「刚才那个页面说了什么」。",
      "features.local.title": "本地模型",
      "features.local.desc": "一键下载开源小模型本机运行，完全离线也能聊天与知识库问答。",
      "features.auto.title": "自动化与 MCP",
      "features.auto.desc": "受控读写文件、浏览器与代码沙箱；图形界面管理 MCP 与技能包。",
      "features.voice.title": "语音与个性化",
      "features.voice.desc": "本地语音输入、TTS 播报与口型同步；主题、图标、快捷键与中英文。",

      "showcase.label": "产品一览",
      "showcase.title": "看看 Nomi 长什么样",
      "showcase.lead": "深色界面住在奶油色世界里——陪伴感，而不是冷冰冰的工具感。",
      "gallery.mascot": "桌面伙伴",
      "gallery.chat": "对话窗口",
      "gallery.palette": "命令面板（Ctrl/⌘+K）",
      "gallery.providers": "供应商与模型",
      "gallery.knowledge": "本地知识库",
      "gallery.tools": "工具权限",
      "gallery.localModels": "本机小模型",
      "gallery.mascotAlt": "桌面伙伴 Nomi 的立绘、对话气泡与语音工具栏",
      "gallery.chatAlt": "Nomi 对话窗口：左侧是会话列表，右侧是整理今日待办的对话",
      "gallery.paletteAlt": "命令面板（Ctrl/⌘+K）：搜索并执行新对话、设置、记忆等命令",
      "gallery.providersAlt": "AI 供应商面板：DeepSeek、OpenAI、Anthropic、Gemini 与本地 Ollama",
      "gallery.knowledgeAlt": "本地知识库检索：按关键词命中文件夹里的笔记，并标出来源文档",
      "gallery.toolsAlt": "桌面工具权限：只读工具默认允许，写入需确认，删除需逐次确认",
      "gallery.localModelsAlt": "本机小模型列表：按内存推荐模型，可一键下载并离线运行",

      "privacy.band.title": "隐私是品牌的一部分",
      "privacy.band.desc": "对话、记忆、知识库与日程都只保存在你的电脑上。可开启「仅本地模型」，敏感内容不发往云端。",
      "privacy.band.cta": "了解隐私承诺",

      "cta.title": "准备好认识 Nomi 了吗？",
      "cta.lead": "安装后跟着引导选语言、主题和模型，几分钟就能开始对话。",
      "cta.download": "前往下载",
      "cta.releases": "GitHub Releases",

      "footer.tagline": "你的桌面 AI 伙伴。住在桌面，懂你所想，帮你做到。",
      "footer.product": "产品",
      "footer.community": "社区",
      "footer.copy": "© Nomi·诺米 · MIT",
      "page.features.label": "功能",
      "page.features.title": "Nomi 能帮你做什么",
      "page.features.lead": "会动、会说话的桌面伙伴，记得你，也能动手帮你。",
      "page.features.ctaTitle": "想亲自试试？",
      "page.features.ctaLead": "从 GitHub Releases 下载对应平台安装包即可。",
      "page.features.ctaDocs": "阅读文档",
      "page.features.noteHub": "文档中心",
      "ft.local.3": "数据留在本机，API Key 加密保存。",
      "ft.local.2": "可完全离线：本机小模型，或「仅本地模型」。",
      "ft.local.1": "OpenAI、Anthropic、Gemini、DeepSeek、Ollama 等一键切换。",
      "ft.local.t": "本地优先，模型自由",
      "ft.tools.3": "敏感操作先确认，删除可撤销，全程有审计日志。",
      "ft.tools.2": "图形界面管理 MCP 服务器与 SKILL.md 技能包。",
      "ft.tools.1": "授权后读取、搜索、总结本机文件。",
      "ft.tools.t": "自动化与 MCP",
      "ft.memory.3": "记忆与个人档案，可看、可改、可删。",
      "ft.memory.2": "支持 PDF、Word、Markdown，图片文字本地 OCR。",
      "ft.memory.1": "基于你的文件夹与笔记回答，引用可点击。",
      "ft.memory.t": "知识库与长期记忆",
      "ft.chat.3": "可选屏幕记忆（默认关闭），本机识别文字。",
      "ft.chat.2": "Ctrl/⌘+Alt+A 框选屏幕，直接带图提问。",
      "ft.chat.1": "流式对话，会话与侧栏清爽不打扰。",
      "ft.chat.t": "对话与屏幕问答",
      "ft.companion.3": "本地离线语音输入，或接入自己的 TTS。",
      "ft.companion.2": "摸头、点击各有反应，可导入 VRM 换形象。",
      "ft.companion.1": "会眨眼、会呼吸，口型随语音同步。",
      "ft.companion.t": "桌面伙伴与语音",
      "ft.more.update": "自动更新",
      "ft.more.theme": "主题与快捷键",
      "ft.more.island": "灵动岛",
      "ft.more.agent": "编程助手监视",
      "ft.more.skills": "技能包",
      "ft.more.cal": "系统日历",
      "ft.more.sched": "日程与提醒",
      "ft.more.all": "全部文档 →",
      "ft.more.lead": "按需开启，详情见文档。",
      "ft.more.title": "更多能力",
      "ft.tabs.aria": "核心能力",

      "page.download.label": "下载",
      "page.download.title": "安装 Nomi·诺米",
      "page.download.lead": "最新版本：Linux、Windows 与 macOS 均可下载。",
      "dl.windows.req": "Windows 10 及以上",
      "dl.mac.req": "Apple Silicon / Intel",
      "dl.linux.req": "x64 AppImage",
      "dl.latest": "GitHub 最新 Release",
      "dl.goto": "前往 Releases",
      "dl.download": "下载安装包",
      "dl.coming": "即将提供",
      "dl.note": "Linux、Windows 与 macOS 安装包均可下载。也可打开",
      "dl.quick.label": "快速开始",
      "dl.quick.title": "三步开始对话",
      "dl.quick.lead": "装好之后，跟着引导选好语言和模型就行。",
      "dl.step1.t": "安装并打开",
      "dl.step1.d": "安装对应平台的安装包，打开 Nomi，跟着首次引导选择语言、主题和角色。",
      "dl.step2.t": "接上模型",
      "dl.step2.d": "在「供应商与模型」里添加一个供应商（填入 API Key），或在「本机管理」里下载一个本地模型。",
      "dl.step3.t": "开始聊天",
      "dl.step3.d": "点击 Nomi 或按 Ctrl/⌘+N 开始对话；按 Ctrl/⌘+K 浏览全部功能。",
      "dl.build.title": "更想从源码构建？",
      "dl.build.desc": "需要 Node.js ≥ 22.12 与 pnpm 9。克隆仓库后 pnpm install && pnpm dev 即可开发模式运行。",
      "dl.build.cta": "打开仓库",
      "page.docs.label": "文档",
      "page.docs.title": "文档中心",
      "page.docs.lead": "本页汇总仓库内文档入口；详细内容在 GitHub 上维护，不在此复制全文。",

      "docs.getting.title": "入门与规范",
      "docs.getting.lead": "安装、配置与品牌规范。",
      "docs.features.title": "功能文档",
      "docs.features.lead": "每一项能力的详细说明（链接至仓库）。",
      "docs.dev.title": "开发",
      "docs.dev.lead": "从源码构建、测试与了解架构。",
      "docs.gs.title": "快速开始",
      "docs.gs.desc": "安装、首次引导、接模型与开始对话。",
      "docs.index.title": "文档索引",
      "docs.index.desc": "功能说明、开发与测试文档总览。",
      "docs.brand.title": "品牌规范",
      "docs.brand.desc": "名称、口号、语气、色彩、字体与桌面伙伴使用规范。",
      "docs.release.title": "发布说明",
      "docs.release.desc": "打包与发布流程。",
      "docs.f.mascot": "桌面伙伴",
      "docs.f.mascot.d": "立绘、互动与透明穿透。",
      "docs.f.chat": "对话",
      "docs.f.chat.d": "对话窗口、截图提问与命令。",
      "docs.f.providers": "供应商",
      "docs.f.providers.d": "模型预设、Key 管理与切换。",
      "docs.f.kb": "知识库",
      "docs.f.kb.d": "文件夹索引、引用与 OCR。",
      "docs.f.memory": "记忆",
      "docs.f.memory.d": "长期记忆与个人档案。",
      "docs.f.schedule": "日程与日历",
      "docs.f.schedule.d": "提醒、定时任务与系统日历。",
      "docs.f.screen": "屏幕问答",
      "docs.f.screen.d": "框选提问与屏幕记忆。",
      "docs.f.mcp": "MCP 与技能",
      "docs.f.mcp.d": "MCP 服务器与 SKILL.md。",
      "docs.f.local": "本地模型",
      "docs.f.local.d": "本机小模型与 Ollama。",
      "docs.f.auto": "自动化",
      "docs.f.auto.d": "文件、浏览器与代码沙箱。",
      "docs.f.voice": "语音",
      "docs.f.voice.d": "语音输入与 TTS 播报。",
      "docs.f.agent": "编程助手监视",
      "docs.f.agent.d": "发现本机助手并气泡提醒。",
      "docs.f.island": "灵动岛",
      "docs.f.island.d": "macOS 灵动岛与顶部胶囊。",
      "docs.f.personal": "个性化",
      "docs.f.personal.d": "主题、图标、快捷键与语言。",
      "docs.f.update": "自动更新",
      "docs.f.update.d": "后台检查与确认后安装。",
      "docs.f.privacy": "隐私与安全",
      "docs.f.privacy.d": "本地存储、导出与仅本地模型。",
      "docs.d.arch": "架构",
      "docs.d.arch.d": "项目结构与模块说明。",
      "docs.d.build": "构建",
      "docs.d.build.d": "从源码构建与打包。",
      "docs.d.test": "测试",
      "docs.d.test.d": "测试方式与约定。",
      "page.privacy.label": "隐私",
      "page.privacy.title": "隐私是品牌的一部分",
      "page.privacy.lead": "放心，我们的对话和记忆都只留在这台电脑上。",

      "priv.h1": "本地优先",
      "priv.p1": "Nomi 把数据留在你自己的电脑上。对话、记忆、知识库与日程默认保存在本机，而不是上传到 Nomi 的服务器（本项目也不运营这样的云端账户体系）。",
      "priv.h2": "你可以掌控的",
      "priv.li1": "一键导出：可导出全部本地数据。",
      "priv.li2": "记忆可改可删：个人档案（称呼、偏好）随时可看、可改、可删、可导出。",
      "priv.li3": "仅本地模型：可开启「仅本地模型」，敏感内容不发往云端。",
      "priv.li4": "API Key 加密：供应商密钥用系统钥匙串加密，界面只显示掩码。",
      "priv.li5": "敏感操作确认：MCP 敏感工具、文件写入等会在执行前请你确认；删除进回收站可撤销。",
      "priv.h3": "云端模型时会发生什么",
      "priv.p3": "当你选择连接 OpenAI、Anthropic、DeepSeek 等云端供应商时，对话内容会按该供应商的隐私政策发往对应服务——这是你主动配置的连接。Nomi 不会替你向第三方「偷偷上传」。若希望内容完全留在本机，请使用本地模型或「仅本地模型」模式。",
      "priv.h4": "可选能力默认关闭",
      "priv.p4": "例如主动聊天、屏幕记忆、剪贴板历史等默认关闭；开启后仍在本机处理，并支持排除应用与自动清理等控制项。",
      "priv.h5": "了解更多",
      "priv.p5a": "完整说明见仓库文档：",
      "priv.p5b": "。品牌层面的表述见",
      "priv.p5c": "。",
      "priv.cta": "下载 Nomi",

      "spot.companion.title": "住在桌面的伙伴",
      "spot.companion.desc": "分层立绘会眨眼、呼吸、说话。摸头互动，拖文件总结——她就站在你工作区的边角。",
      "spot.companion.cta": "了解桌面伙伴 →",
      "spot.local.title": "本地优先，随你掌控",
      "spot.local.desc": "对话与记忆留在本机；Key 加密；可开启仅本地模型。有用之外，还要让你安心。",
      "spot.local.cta": "阅读隐私承诺 →",
      "cl.label": "更新日志",
      "cl.title": "更新日志",
      "cl.lead": "Nomi·诺米 每个版本的更新内容，最新版本在前。",
      "cl.release": "查看 GitHub Release →",
      "meta.changelog.title": "更新日志 — Nomi·诺米",
      "meta.changelog.desc": "Nomi·诺米各版本更新日志：v1.0.1、v1.0.0。",
      "nav.changelog": "更新日志",
      "cl.v101.title": "v1.0.1 — 补丁版本",
      "cl.v101.i1": "修复 Windows 上脚本类 CLI 的编码助手接入：启动时设置 ELECTRON_RUN_AS_NODE，不再因此无法启动。",
      "cl.v101.i2": "补齐语音（本地 sherpa TTS）与编码助手界面的英文文案。",
      "cl.v101.i3": "提升 Windows 上自动化测试的稳定性（离线 TTS 不再拖垮测试环境，对话气泡等待更可靠）。",
      "cl.v100.title": "v1.0.0 — 首个正式版",
      "cl.v100.i1": "首个正式版：Windows / macOS（Apple Silicon 与 Intel）/ Linux 官方安装包均由 GitHub Actions 构建发布。",
      "cl.v100.i2": "编码助手：Nomi、Claude Code、Codex 作为可切换的接入端点；对话标签页可并发运行（默认并行上限 3，超出排队），每个标签页有独立会话与工作目录；可检测、安装并更新各 CLI 版本。",
      "cl.v100.i3": "本地 CLI 路由：在 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 与 Gemini 之间转换流式与非流式回复，包含工具调用、停止原因与用量。",
      "cl.v100.i4": "对话：普通 / 开发者模式、按端点隔离的会话、会话模糊搜索（Cmd/Ctrl+F）、会话行重命名与删除、分叉为新对话、可随时停止生成。",
      "cl.v100.i5": "桌面伙伴：Nomi 拥有 41 个命名动作，并锁定品牌形象；任务结果、思考、工具调用与文件拖入会触发合适的动作，并尊重“减少动态效果”设置。",
      "cl.v100.i6": "效率：Cmd/Ctrl+K 命令面板，新建对话、聚焦输入框、设置等快捷键均可在设置中查看与重新绑定。",
      "cl.v100.i7": "体验与可访问性：对话框焦点管理、统一的空 / 错误 / 加载状态（含重试）、首次使用引导、设置页与侧边面板按需加载。",
      "cl.v100.i8": "安全：CSP 同样作用于打包后的 file:// 页面，私有地址检查更严格，TTS 下载防 DNS 重绑定，加固 IPC、本地 CLI 路由、浏览器与 MCP 连接。"
    },

    en: {
      "meta.home.title": "Nomi — Your desktop AI companion",
      "meta.home.desc": "Nomi — Your desktop AI companion. Lives on your desktop, gets what you mean, and gets it done. Local-first. Windows / macOS / Linux.",
      "meta.features.title": "Features — Nomi",
      "meta.features.desc": "Nomi core capabilities: desktop companion & voice, chat & screen Q&A, knowledge & memory, automation & MCP, local-first with any model.",
      "meta.download.title": "Download — Nomi",
      "meta.download.desc": "Download the latest Nomi for Linux, Windows, and macOS.",
      "meta.docs.title": "Docs — Nomi",
      "meta.docs.desc": "Nomi docs hub: getting started, feature guides, brand guidelines, and release notes.",
      "meta.privacy.title": "Privacy — Nomi",
      "meta.privacy.desc": "Nomi privacy promise: local-first. Chats and memory stay on your computer.",

      "nav.home": "Home",
      "nav.features": "Features",
      "nav.download": "Download",
      "nav.docs": "Docs",
      "nav.privacy": "Privacy",
      "nav.cta": "Download Nomi",
      "nav.ctaReleases": "Go to Releases",
      "nav.openMenu": "Open menu",
      "nav.main": "Main navigation",
      "nav.lang": "Language",
      "logo.home": "Nomi home",

      "hero.badge": "Local-first · Windows / macOS / Linux",
      "hero.title": "Nomi·诺米",
      "hero.slogan": "Your desktop AI companion",
      "hero.promise": "Lives on your desktop, gets what you mean, and gets it done.",
      "hero.download": "Download now",
      "hero.github": "View on GitHub",
      "hero.meta.mit": "MIT open source",
      "hero.meta.bilingual": "中文 / English",
      "hero.meta.models": "Cloud + local models",
      "hero.quote": "“I’m here — turning every task into a little win with you.”",
      "hero.avatarAlt": "Nomi official brand portrait",

      "pillars.label": "Three pillars",
      "pillars.title": "Tasks · Execution · Companionship",
      "pillars.lead": "Nomi has to be useful first: every warm line sits next to something that actually helps.",
      "pillars.tasks.title": "Task management",
      "pillars.tasks.desc": "Schedules, reminders, and proactive briefs — get ideas into your day.",
      "pillars.exec.title": "Smart execution",
      "pillars.exec.desc": "Read files, see the screen, tap your knowledge base — turn ideas into action.",
      "pillars.care.title": "Warm companionship",
      "pillars.care.desc": "A living, talking desktop companion who remembers you and celebrates small wins.",

      "features.label": "Highlights",
      "features.title": "A full AI workbench on your desktop",
      "features.lead": "From chat to automation, cloud to fully offline — use it your way.",
      "features.mascot.title": "Desktop companion",
      "features.mascot.desc": "Layered art that blinks and breathes; head pats, speech bubbles, drag files to summarize.",
      "features.chat.title": "AI chat",
      "features.chat.desc": "Streaming replies, session list, screen-region questions — a clean chat window.",
      "features.providers.title": "Multi-provider",
      "features.providers.desc": "OpenAI, Anthropic, DeepSeek, Ollama, and more. Keys encrypted on your machine.",
      "features.knowledge.title": "Knowledge & memory",
      "features.knowledge.desc": "Answers from your folders and notes with citations; long-term memory you can view, edit, or delete.",
      "features.screen.title": "Screen Q&A",
      "features.screen.desc": "Select any screen region and ask; optional local screen memory for “what did that page say?”",
      "features.local.title": "Local models",
      "features.local.desc": "One-click download of small open models. Chat and RAG fully offline.",
      "features.auto.title": "Automation & MCP",
      "features.auto.desc": "Controlled file I/O, browser, and code sandbox; GUI for MCP servers and skill packs.",
      "features.voice.title": "Voice & personalization",
      "features.voice.desc": "Local voice input, TTS with lip sync; themes, icons, shortcuts, and zh/en UI.",

      "showcase.label": "Product tour",
      "showcase.title": "See what Nomi looks like",
      "showcase.lead": "Dark UI living in a cream world — companionship, not cold tooling.",
      "gallery.mascot": "Desktop companion",
      "gallery.chat": "Chat window",
      "gallery.palette": "Command palette (Ctrl/⌘+K)",
      "gallery.providers": "Providers & models",
      "gallery.knowledge": "Local knowledge base",
      "gallery.tools": "Tool permissions",
      "gallery.localModels": "Local models",
      "gallery.mascotAlt": "Nomi the desktop companion with a chat bubble and the voice toolbar",
      "gallery.chatAlt": "Nomi chat window: conversation list on the left, a conversation about today's to-dos on the right",
      "gallery.paletteAlt": "Command palette (Ctrl/⌘+K) for new chat, settings, memory and more",
      "gallery.providersAlt": "AI providers panel: DeepSeek, OpenAI, Anthropic, Gemini and local Ollama",
      "gallery.knowledgeAlt": "Local knowledge base search: matching passages from your folder, with source documents",
      "gallery.toolsAlt": "Desktop tool permissions: read-only tools allowed, writes need confirmation, deletes always ask",
      "gallery.localModelsAlt": "Local models list: memory-based recommendation, one-click download, runs offline",

      "privacy.band.title": "Privacy is part of the brand",
      "privacy.band.desc": "Chats, memory, knowledge base, and schedules stay on your computer. Enable local-only mode so sensitive content never leaves.",
      "privacy.band.cta": "Read our privacy promise",

      "cta.title": "Ready to meet Nomi?",
      "cta.lead": "Follow the setup for language, theme, and model — chatting in minutes.",
      "cta.download": "Go to download",
      "cta.releases": "GitHub Releases",

      "footer.tagline": "Your desktop AI companion. Lives on your desktop, gets what you mean, and gets it done.",
      "footer.product": "Product",
      "footer.community": "Community",
      "footer.copy": "© Nomi·诺米 · MIT",
      "page.features.label": "Features",
      "page.features.title": "What Nomi can do for you",
      "page.features.lead": "A living desktop companion that remembers you and gets things done.",
      "page.features.ctaTitle": "Want to try it yourself?",
      "page.features.ctaLead": "Grab the installer for your platform from GitHub Releases.",
      "page.features.ctaDocs": "Read the docs",
      "page.features.noteHub": "docs hub",
      "ft.local.3": "Data stays on your machine; API keys are encrypted.",
      "ft.local.2": "Go fully offline with local models or “local-only” mode.",
      "ft.local.1": "Switch OpenAI, Anthropic, Gemini, DeepSeek, Ollama, and more.",
      "ft.local.t": "Local-first, any model",
      "ft.tools.3": "Sensitive actions ask first; deletes are undoable and audited.",
      "ft.tools.2": "Manage MCP servers and SKILL.md skill packs in a GUI.",
      "ft.tools.1": "Read, search, and summarize files you authorize.",
      "ft.tools.t": "Automation & MCP",
      "ft.memory.3": "Memories and profile you can view, edit, and delete.",
      "ft.memory.2": "PDF, Word, Markdown, and on-device OCR for images.",
      "ft.memory.1": "Answers from your folders and notes, with clickable citations.",
      "ft.memory.t": "Knowledge & memory",
      "ft.chat.3": "Optional screen memory (off by default), OCR on-device.",
      "ft.chat.2": "Press Ctrl/⌘+Alt+A to select the screen and ask.",
      "ft.chat.1": "Streaming chat in a calm, uncluttered window.",
      "ft.chat.t": "Chat & screen Q&A",
      "ft.companion.3": "Offline voice input, or plug in your own TTS.",
      "ft.companion.2": "Reacts to taps and pats; import a VRM to change looks.",
      "ft.companion.1": "Blinks and breathes, with lip-sync to speech.",
      "ft.companion.t": "Companion & voice",
      "ft.more.update": "Auto-update",
      "ft.more.theme": "Themes & shortcuts",
      "ft.more.island": "Dynamic island",
      "ft.more.agent": "Coding-agent monitor",
      "ft.more.skills": "Skill packs",
      "ft.more.cal": "System calendar",
      "ft.more.sched": "Scheduling & reminders",
      "ft.more.all": "All docs →",
      "ft.more.lead": "Use what you need — details are in the docs.",
      "ft.more.title": "More",
      "ft.tabs.aria": "Core capabilities",

      "page.download.label": "Download",
      "page.download.title": "Install Nomi",
      "page.download.lead": "Latest release: Linux, Windows, and macOS available.",
      "dl.windows.req": "Windows 10 and later",
      "dl.mac.req": "Apple Silicon / Intel",
      "dl.linux.req": "x64 AppImage",
      "dl.latest": "the latest GitHub Release",
      "dl.goto": "Go to Releases",
      "dl.download": "Download",
      "dl.coming": "Coming soon",
      "dl.note": "Installers for Linux, Windows, and macOS are available. Or open",
      "dl.quick.label": "Quick start",
      "dl.quick.title": "Chat in three steps",
      "dl.quick.lead": "After install, follow the guide for language and model.",
      "dl.step1.t": "Install & open",
      "dl.step1.d": "Install for your platform, open Nomi, and pick language, theme, and character in onboarding.",
      "dl.step2.t": "Connect a model",
      "dl.step2.d": "Add a provider under Providers & models (API key), or download a local model in Local management.",
      "dl.step3.t": "Start chatting",
      "dl.step3.d": "Click Nomi or press Ctrl/⌘+N to chat; Ctrl/⌘+K to browse everything.",
      "dl.build.title": "Prefer building from source?",
      "dl.build.desc": "Needs Node.js ≥ 22.12 and pnpm 9. Clone, then pnpm install && pnpm dev for development mode.",
      "dl.build.cta": "Open the repo",
      "page.docs.label": "Docs",
      "page.docs.title": "Documentation hub",
      "page.docs.lead": "Entry points into the repo docs. Full text lives on GitHub — we don’t duplicate it here.",

      "docs.getting.title": "Getting started & guidelines",
      "docs.getting.lead": "Install, configure, and follow the brand guidelines.",
      "docs.features.title": "Feature docs",
      "docs.features.lead": "Detailed guides for each capability (links into the repo).",
      "docs.dev.title": "Development",
      "docs.dev.lead": "Build from source, run tests, and learn the architecture.",
      "docs.gs.title": "Getting started",
      "docs.gs.desc": "Install, onboarding, connect a model, start chatting.",
      "docs.index.title": "Docs index",
      "docs.index.desc": "Overview of feature, development, and testing docs.",
      "docs.brand.title": "Brand guidelines",
      "docs.brand.desc": "Name, slogan, tone, colors, type, and mascot usage.",
      "docs.release.title": "Release notes",
      "docs.release.desc": "Packaging and release process.",
      "docs.f.mascot": "Desktop companion",
      "docs.f.mascot.d": "Art, interaction, and click-through transparency.",
      "docs.f.chat": "Chat",
      "docs.f.chat.d": "Chat window, screen capture, and commands.",
      "docs.f.providers": "Providers",
      "docs.f.providers.d": "Model presets, key management, switching.",
      "docs.f.kb": "Knowledge base",
      "docs.f.kb.d": "Folder indexing, citations, OCR.",
      "docs.f.memory": "Memory",
      "docs.f.memory.d": "Long-term memory and personal profile.",
      "docs.f.schedule": "Scheduling & calendar",
      "docs.f.schedule.d": "Reminders, timed tasks, system calendars.",
      "docs.f.screen": "Screen Q&A",
      "docs.f.screen.d": "Region select and screen memory.",
      "docs.f.mcp": "MCP & skills",
      "docs.f.mcp.d": "MCP servers and SKILL.md.",
      "docs.f.local": "Local models",
      "docs.f.local.d": "On-device small models and Ollama.",
      "docs.f.auto": "Automation",
      "docs.f.auto.d": "Files, browser, and code sandbox.",
      "docs.f.voice": "Voice",
      "docs.f.voice.d": "Voice input and TTS playback.",
      "docs.f.agent": "Coding-agent monitor",
      "docs.f.agent.d": "Discover local agents and bubble alerts.",
      "docs.f.island": "Dynamic Island",
      "docs.f.island.d": "macOS island and top capsule.",
      "docs.f.personal": "Personalization",
      "docs.f.personal.d": "Themes, icons, shortcuts, language.",
      "docs.f.update": "Auto-update",
      "docs.f.update.d": "Background check and confirm-to-install.",
      "docs.f.privacy": "Privacy & security",
      "docs.f.privacy.d": "Local storage, export, local-only models.",
      "docs.d.arch": "Architecture",
      "docs.d.arch.d": "Project structure and modules.",
      "docs.d.build": "Building",
      "docs.d.build.d": "Build and package from source.",
      "docs.d.test": "Testing",
      "docs.d.test.d": "Test approach and conventions.",
      "page.privacy.label": "Privacy",
      "page.privacy.title": "Privacy is part of the brand",
      "page.privacy.lead": "Relax — our chats and memories stay on this computer.",

      "priv.h1": "Local-first",
      "priv.p1": "Nomi keeps data on your own machine. Chats, memory, knowledge base, and schedules default to local storage — not uploaded to a Nomi cloud (this project doesn’t run that kind of account system).",
      "priv.h2": "You’re in control",
      "priv.li1": "One-click export: export all local data.",
      "priv.li2": "Editable memory: profile (name, preferences) — view, edit, delete, or export anytime.",
      "priv.li3": "Local-only models: enable so sensitive content never goes to the cloud.",
      "priv.li4": "Encrypted API keys: stored in the system keychain; UI shows masks only.",
      "priv.li5": "Confirm sensitive actions: MCP tools, file writes, and more ask first; deletes go to trash and can be undone.",
      "priv.h3": "What happens with cloud models",
      "priv.p3": "When you connect OpenAI, Anthropic, DeepSeek, or similar, chat content goes to that provider under their privacy policy — a connection you configured. Nomi doesn’t silently upload to third parties. For fully on-device content, use local models or local-only mode.",
      "priv.h4": "Optional features default off",
      "priv.p4": "Proactive chat, screen memory, clipboard history, and similar stay off by default; when enabled they still process locally, with app exclusions and auto-clean controls.",
      "priv.h5": "Learn more",
      "priv.p5a": "Full details in the repo docs:",
      "priv.p5b": ". Brand-level wording in",
      "priv.p5c": ".",
      "priv.cta": "Download Nomi",

      "spot.companion.title": "A companion on your desktop",
      "spot.companion.desc": "Layered art that blinks, breathes, and speaks. Head pats, drag-to-summarize — she lives at the edge of your workspace.",
      "spot.companion.cta": "Explore the companion →",
      "spot.local.title": "Local-first, under your control",
      "spot.local.desc": "Chats and memory stay on-device; keys encrypted; local-only mode available. Useful — and trustworthy.",
      "spot.local.cta": "Read the privacy promise →",
      "cl.label": "Changelog",
      "cl.title": "Changelog",
      "cl.lead": "What changed in each Nomi release, newest first.",
      "cl.release": "View on GitHub Release →",
      "meta.changelog.title": "Changelog — Nomi",
      "meta.changelog.desc": "Nomi release notes: v1.0.1 and v1.0.0.",
      "nav.changelog": "Changelog",
      "cl.v101.title": "v1.0.1 — patch release",
      "cl.v101.i1": "Fixed coding-assistant takeover for script-based CLIs on Windows: ELECTRON_RUN_AS_NODE is now set when launching them, so they start correctly.",
      "cl.v101.i2": "Added missing English strings for local sherpa TTS and the coding-assistant UI.",
      "cl.v101.i3": "Made automated tests more reliable on Windows (offline TTS no longer starves the test runners; chat-bubble waits are more robust).",
      "cl.v100.title": "v1.0.0 — first stable release",
      "cl.v100.i1": "First stable release: official installers for Windows, macOS (Apple Silicon and Intel) and Linux, built and published by GitHub Actions.",
      "cl.v100.i2": "Coding assistants: Nomi, Claude Code and Codex as switchable endpoints; chat tabs run concurrently (default limit 3, extra runs queue), each with its own session and working directory; detect, install and update each CLI version.",
      "cl.v100.i3": "Local CLI route: converts streaming and non-streaming replies between Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini, including tool calls, stop reasons and usage.",
      "cl.v100.i4": "Chat: normal / dev mode, per-endpoint conversation isolation, fuzzy conversation search (Cmd/Ctrl+F), rename and delete from the conversation row, fork as a new chat, and stop generation at any time.",
      "cl.v100.i5": "Desktop companion: Nomi has 41 named actions on a brand-locked rig; task results, thinking, tool use and file drops trigger fitting actions, and reduced-motion is respected.",
      "cl.v100.i6": "Productivity: a Cmd/Ctrl+K command palette; shortcuts for new chat, focus input and settings, all listed in Settings and rebindable.",
      "cl.v100.i7": "Polish and accessibility: dialog focus handling, unified empty / error / loading states with retry, first-run onboarding, and route-split settings and side panels.",
      "cl.v100.i8": "Security: CSP also applies to packaged file:// pages, stricter private-address checks, DNS-rebinding mitigation for TTS downloads, and hardened IPC, local CLI route, browser and MCP connections."
    }
  };

  function detectLang() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch (e) {}
    var nav = (navigator.language || navigator.userLanguage || "zh").toLowerCase();
    if (nav.indexOf("en") === 0) return "en";
    return "zh";
  }

  function t(lang, key) {
    var pack = dict[lang] || dict.zh;
    if (pack[key] != null) return pack[key];
    if (dict.zh[key] != null) return dict.zh[key];
    return key;
  }

  function apply(lang) {
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.documentElement.setAttribute("data-lang", lang);

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (!key) return;
      var val = t(lang, key);
      if (val === key) return; // unknown key: keep the authored fallback text, never render a raw key
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.value = val;
      } else {
        el.textContent = val;
      }
    });

    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-html");
      if (!key) return;
      var html = t(lang, key);
      if (html !== key) el.innerHTML = html;
    });

    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-aria-label"), v = t(lang, k);
      if (v !== k) el.setAttribute("aria-label", v);
    });

    document.querySelectorAll("[data-i18n-alt]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-alt"), v = t(lang, k);
      if (v !== k) el.setAttribute("alt", v);
    });

    document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-title"), v = t(lang, k);
      if (v !== k) el.setAttribute("title", v);
    });

    var page = document.body.getAttribute("data-page") || "home";
    var titleKey = "meta." + page + ".title";
    var descKey = "meta." + page + ".desc";
    if (dict.zh[titleKey]) document.title = t(lang, titleKey);
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && dict.zh[descKey]) metaDesc.setAttribute("content", t(lang, descKey));
    var ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && dict.zh[titleKey]) ogTitle.setAttribute("content", t(lang, titleKey));
    var ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc && dict.zh[descKey]) ogDesc.setAttribute("content", t(lang, descKey));

    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      var active = btn.getAttribute("data-lang") === lang;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.classList.toggle("is-active", active);
    });

    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
  }

  function setLang(lang) {
    if (lang !== "zh" && lang !== "en") lang = "zh";
    apply(lang);
  }

  function init() {
    var lang = detectLang();
    apply(lang);

    document.querySelectorAll(".lang-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setLang(btn.getAttribute("data-lang"));
      });
    });
  }

  window.NomiI18n = {
    dict: dict,
    t: function (key) {
      return t(detectLang(), key);
    },
    setLang: setLang,
    getLang: detectLang,
    init: init
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
