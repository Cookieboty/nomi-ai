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
      "features.more": "查看完整功能列表 →",

      "showcase.label": "产品一览",
      "showcase.title": "看看 Nomi 长什么样",
      "showcase.lead": "深色界面住在奶油色世界里——陪伴感，而不是冷冰冰的工具感。",
      "gallery.mascot": "桌面伙伴",
      "gallery.chat": "对话窗口",
      "gallery.palette": "命令面板（Ctrl/⌘+K）",
      "gallery.providers": "供应商与模型",
      "gallery.mascotAlt": "桌面伙伴 Nomi 立绘界面",
      "gallery.chatAlt": "Nomi 对话窗口",
      "gallery.paletteAlt": "命令面板 Ctrl/⌘+K",
      "gallery.providersAlt": "供应商与模型设置",

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


      "fg.mascot": "桌面伙伴",
      "fg.mascot.1.t": "会呼吸的角色",
      "fg.mascot.1.d": "分层立绘驱动的伪 3D：眨眼、视线跟随、呼吸、头发摆动、说话口型同步。",
      "fg.mascot.2.t": "表情与互动",
      "fg.mascot.2.d": "表情随对话与任务切换；摸头、单击、双击各有反应；可沿屏幕底边散步，支持多显示器。",
      "fg.mascot.3.t": "透明不挡事",
      "fg.mascot.3.d": "只有角色本身可点击，其余区域鼠标穿透；回复以气泡显示在身边。",
      "fg.mascot.4.t": "换形象与拖文件",
      "fg.mascot.4.d": "可导入 VRM 模型；把文件拖到 Nomi 身上直接总结。",

      "fg.chat": "对话",
      "fg.chat.1.t": "简洁对话窗口",
      "fg.chat.1.d": "平静简洁的布局，流式输出，会话列表与可收起侧栏。",
      "fg.chat.2.t": "图片与截图提问",
      "fg.chat.2.d": "Ctrl/⌘+Alt+A 框选屏幕任意区域，直接带图提问。",
      "fg.chat.3.t": "快捷命令与引导",
      "fg.chat.3.d": "输入框按 / 打开命令；首次引导完成语言、主题、角色、模型与隐私设置。",

      "fg.providers": "供应商",
      "fg.providers.1.t": "一键切换",
      "fg.providers.1.d": "在对话工具栏或托盘直接切换供应商与模型，立即生效。",
      "fg.providers.2.t": "内置预设",
      "fg.providers.2.d": "OpenAI、Anthropic、Gemini、DeepSeek、Kimi、智谱、通义、豆包、Ollama、LM Studio 等，也可自定义。",
      "fg.providers.3.t": "多 Key 与加密",
      "fg.providers.3.d": "主备 Key 自动切换；API Key 用系统钥匙串加密，界面只显示掩码。",
      "fg.providers.4.t": "按任务分配模型",
      "fg.providers.4.d": "对话、工具调用、摘要可分别指定不同供应商与模型。",

      "fg.knowledge": "知识库",
      "fg.knowledge.1.t": "文件夹与笔记",
      "fg.knowledge.1.d": "基于你选的文件夹或笔记回答，并标出可点击的引用来源。",
      "fg.knowledge.2.t": "多格式与 OCR",
      "fg.knowledge.2.d": "支持 txt、Markdown、PDF、Word，以及图片里的文字（本地 OCR）。",
      "fg.knowledge.3.t": "增量索引",
      "fg.knowledge.3.d": "增量更新；可选本地或云端向量模型提升检索效果。",

      "fg.memory": "记忆",
      "fg.memory.1.t": "长期记忆",
      "fg.memory.1.d": "对话结束后自动整理成记忆，相关话题时自然想起。",
      "fg.memory.2.t": "个人档案",
      "fg.memory.2.d": "称呼与偏好随时可看、可改、可删、可导出。",

      "fg.schedule": "日程",
      "fg.schedule.1.t": "提醒与定时任务",
      "fg.schedule.1.d": "支持重复规则；错过的提醒下次启动补上；可做每日简报等。",
      "fg.schedule.2.t": "主动聊天",
      "fg.schedule.2.d": "默认关闭；按频率、活跃时段与免打扰偶尔搭话。",
      "fg.schedule.3.t": "系统日历",
      "fg.schedule.3.d": "连接 macOS / Windows / Linux 日历，或导入 .ics、订阅链接、CalDAV。",

      "fg.screen": "屏幕问答",
      "fg.screen.1.t": "框选提问",
      "fg.screen.1.d": "框选屏幕直接提问。",
      "fg.screen.2.t": "屏幕记忆",
      "fg.screen.2.d": "默认关闭；定时截屏并本机识别文字，之后可问刚才看过的内容；可排除应用与自动清理。",

      "fg.mcp": "MCP 与技能",
      "fg.mcp.1.t": "MCP 服务器",
      "fg.mcp.1.d": "图形界面添加、连接、管理；敏感工具调用前会请你确认。",
      "fg.mcp.2.t": "技能包",
      "fg.mcp.2.d": "支持 SKILL.md：启用、编辑、新建，或从文件夹导入。",

      "fg.local": "本地模型",
      "fg.local.1.t": "一键本机运行",
      "fg.local.1.d": "下载开源小模型并在本机运行，自动注册为可用供应商。",
      "fg.local.2.t": "Ollama 管理",
      "fg.local.2.d": "列出、拉取、删除本机 Ollama 模型；完全离线也能聊天与知识库问答。",

      "fg.automation": "自动化",
      "fg.automation.1.t": "桌面文件",
      "fg.automation.1.d": "授权后可列出、搜索、阅读、总结；写入需确认，删除进回收站可撤销。",
      "fg.automation.2.t": "受控浏览器与沙箱",
      "fg.automation.2.d": "独立无痕窗口浏览公开网页；隔离目录运行 JS / Python 片段。",
      "fg.automation.3.t": "审计日志",
      "fg.automation.3.d": "所有操作都有本地审计日志。",

      "fg.voice": "语音",
      "fg.voice.1.t": "语音输入",
      "fg.voice.1.d": "本地离线识别，或使用你配置的在线服务；支持免按键对话。",
      "fg.voice.2.t": "语音播报",
      "fg.voice.2.d": "系统语音或自建 TTS（支持参考音频克隆）；口型随声音同步。",

      "fg.coding": "编程助手监视",
      "fg.coding.1.t": "发现本机助手",
      "fg.coding.1.d": "自动发现 Claude Code、Codex、Cursor、Aider、Cline、Continue 等。",
      "fg.coding.2.t": "气泡提醒",
      "fg.coding.2.d": "任务完成或需要你操作时用气泡提醒；只读本机已有日志与会话文件。",

      "fg.island": "灵动岛",
      "fg.island.1.t": "macOS 灵动岛",
      "fg.island.1.d": "消息、编程助手进度与提醒以刘海处样式出现；其他平台以顶部胶囊显示。",

      "fg.personalization": "个性化",
      "fg.personalization.1.t": "主题与图标",
      "fg.personalization.1.d": "暖墨、石墨、纸白、冷雾；多款应用图标，窗口与托盘即时更新。",
      "fg.personalization.2.t": "快捷键",
      "fg.personalization.2.d": "Ctrl/⌘+K 命令面板等全部可改键，并提示冲突。",
      "fg.personalization.3.t": "中英文与无障碍",
      "fg.personalization.3.d": "界面可跟随系统；完整键盘操作，尊重「减少动态效果」。",

      "fg.update": "自动更新",
      "fg.update.1.t": "后台检查",
      "fg.update.1.d": "安装版后台检查并下载新版本，经你确认后才重启安装。",

      "fg.privacy": "隐私",
      "fg.privacy.1.t": "本地优先",
      "fg.privacy.1.d": "对话、记忆、知识库、日程都保存在本机；可一键导出全部本地数据。",
      "fg.privacy.2.t": "仅本地模型",
      "fg.privacy.2.d": "可开启「仅本地模型」，敏感内容不发往云端。",

      "page.download.label": "下载",
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

      "docs.getting.title": "入门与规范",
      "docs.features.title": "功能文档",
      "docs.features.lead": "每一项能力的详细说明（链接至仓库）。",
      "docs.dev.title": "开发",
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
      "features.more": "See all features →",

      "showcase.label": "Product tour",
      "showcase.title": "See what Nomi looks like",
      "showcase.lead": "Dark UI living in a cream world — companionship, not cold tooling.",
      "gallery.mascot": "Desktop companion",
      "gallery.chat": "Chat window",
      "gallery.palette": "Command palette (Ctrl/⌘+K)",
      "gallery.providers": "Providers & models",
      "gallery.mascotAlt": "Nomi desktop companion view",
      "gallery.chatAlt": "Nomi chat window",
      "gallery.paletteAlt": "Command palette Ctrl/⌘+K",
      "gallery.providersAlt": "Provider and model settings",

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


      "fg.mascot": "Desktop companion",
      "fg.mascot.1.t": "A character that breathes",
      "fg.mascot.1.d": "Pseudo-3D layered art: blinks, gaze follow, breathing, hair sway, lip sync while speaking.",
      "fg.mascot.2.t": "Expression & interaction",
      "fg.mascot.2.d": "Expressions follow chat and tasks; head pats, click, double-click; walks along the screen edge; multi-monitor.",
      "fg.mascot.3.t": "Transparent, never in the way",
      "fg.mascot.3.d": "Only the character is clickable; the rest passes clicks through. Replies appear as bubbles nearby.",
      "fg.mascot.4.t": "Avatars & drag-to-summarize",
      "fg.mascot.4.d": "Import VRM models; drop files onto Nomi to summarize them.",

      "fg.chat": "Chat",
      "fg.chat.1.t": "Calm chat window",
      "fg.chat.1.d": "A calm, focused layout with streaming output, a session list, and a collapsible sidebar.",
      "fg.chat.2.t": "Images & screen capture",
      "fg.chat.2.d": "Ctrl/⌘+Alt+A to select any screen region and ask with the image attached.",
      "fg.chat.3.t": "Commands & onboarding",
      "fg.chat.3.d": "Type / in the input for commands; first-run guides language, theme, character, model, and privacy.",

      "fg.providers": "Providers",
      "fg.providers.1.t": "One-click switch",
      "fg.providers.1.d": "Switch provider and model from the chat toolbar or tray — takes effect immediately.",
      "fg.providers.2.t": "Built-in presets",
      "fg.providers.2.d": "OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Zhipu, Tongyi, Doubao, Ollama, LM Studio, and custom endpoints.",
      "fg.providers.3.t": "Multi-key & encryption",
      "fg.providers.3.d": "Primary/backup keys auto-failover; API keys encrypted in the system keychain; UI shows masks only.",
      "fg.providers.4.t": "Per-task models",
      "fg.providers.4.d": "Assign different providers/models for chat, tool calls, and summarization.",

      "fg.knowledge": "Knowledge base",
      "fg.knowledge.1.t": "Folders & notes",
      "fg.knowledge.1.d": "Answers from folders or notes you choose, with clickable citations.",
      "fg.knowledge.2.t": "Formats & OCR",
      "fg.knowledge.2.d": "txt, Markdown, PDF, Word, plus text in images via local OCR.",
      "fg.knowledge.3.t": "Incremental indexing",
      "fg.knowledge.3.d": "Incremental updates; optional local or cloud embedding models for better retrieval.",

      "fg.memory": "Memory",
      "fg.memory.1.t": "Long-term memory",
      "fg.memory.1.d": "After chats, memories are distilled and recalled naturally on related topics.",
      "fg.memory.2.t": "Personal profile",
      "fg.memory.2.d": "Name and preferences — view, edit, delete, or export anytime.",

      "fg.schedule": "Scheduling",
      "fg.schedule.1.t": "Reminders & timed tasks",
      "fg.schedule.1.d": "Recurrence rules; missed reminders catch up on next launch; daily briefs and more.",
      "fg.schedule.2.t": "Proactive chat",
      "fg.schedule.2.d": "Off by default; occasional check-ins by frequency, active hours, and do-not-disturb.",
      "fg.schedule.3.t": "System calendar",
      "fg.schedule.3.d": "Connect macOS / Windows / Linux calendars, or import .ics, feeds, CalDAV.",

      "fg.screen": "Screen Q&A",
      "fg.screen.1.t": "Region select & ask",
      "fg.screen.1.d": "Select any screen region and ask about it.",
      "fg.screen.2.t": "Screen memory",
      "fg.screen.2.d": "Off by default; timed screenshots with local OCR so you can ask about what you just saw; exclude apps and auto-clean.",

      "fg.mcp": "MCP & skills",
      "fg.mcp.1.t": "MCP servers",
      "fg.mcp.1.d": "Add, connect, and manage in a GUI; sensitive tools ask for confirmation first.",
      "fg.mcp.2.t": "Skill packs",
      "fg.mcp.2.d": "SKILL.md support: enable, edit, create, or import from a folder.",

      "fg.local": "Local models",
      "fg.local.1.t": "One-click on-device",
      "fg.local.1.d": "Download small open models and run locally — auto-registered as a provider.",
      "fg.local.2.t": "Ollama management",
      "fg.local.2.d": "List, pull, and delete local Ollama models; chat and RAG fully offline.",

      "fg.automation": "Automation",
      "fg.automation.1.t": "Desktop files",
      "fg.automation.1.d": "With permission: list, search, read, summarize; writes need confirm; deletes go to trash and can be undone.",
      "fg.automation.2.t": "Browser & sandbox",
      "fg.automation.2.d": "Isolated private window for public pages; JS / Python snippets in a sandboxed directory.",
      "fg.automation.3.t": "Audit log",
      "fg.automation.3.d": "Every action is logged locally.",

      "fg.voice": "Voice",
      "fg.voice.1.t": "Voice input",
      "fg.voice.1.d": "Local offline recognition or your configured online service; hands-free conversation supported.",
      "fg.voice.2.t": "Voice playback",
      "fg.voice.2.d": "System voice or self-hosted TTS (reference-audio cloning); lips sync to audio.",

      "fg.coding": "Coding-agent monitor",
      "fg.coding.1.t": "Discover local agents",
      "fg.coding.1.d": "Finds Claude Code, Codex, Cursor, Aider, Cline, Continue, and more.",
      "fg.coding.2.t": "Bubble alerts",
      "fg.coding.2.d": "Bubbles when a task finishes or needs you; read-only access to existing local logs and sessions.",

      "fg.island": "Dynamic Island",
      "fg.island.1.t": "macOS Dynamic Island",
      "fg.island.1.d": "Messages, agent progress, and reminders in the notch style; other platforms use a top capsule.",

      "fg.personalization": "Personalization",
      "fg.personalization.1.t": "Themes & icons",
      "fg.personalization.1.d": "Warm Ink, Graphite, Paper White, Cool Mist; multiple app icons update window and tray instantly.",
      "fg.personalization.2.t": "Shortcuts",
      "fg.personalization.2.d": "Ctrl/⌘+K command palette and more — all remappable with conflict hints.",
      "fg.personalization.3.t": "Language & a11y",
      "fg.personalization.3.d": "UI can follow the system; full keyboard use; respects Reduce Motion.",

      "fg.update": "Auto-update",
      "fg.update.1.t": "Background checks",
      "fg.update.1.d": "Installed builds check and download updates in the background; restart only after you confirm.",

      "fg.privacy": "Privacy",
      "fg.privacy.1.t": "Local-first",
      "fg.privacy.1.d": "Chats, memory, knowledge base, and schedules stay on-device; one-click export of all local data.",
      "fg.privacy.2.t": "Local-only models",
      "fg.privacy.2.d": "Enable local-only mode so sensitive content never goes to the cloud.",

      "page.download.label": "Download",
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

      "docs.getting.title": "Getting started & guidelines",
      "docs.features.title": "Feature docs",
      "docs.features.lead": "Detailed guides for each capability (links into the repo).",
      "docs.dev.title": "Development",
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
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.value = val;
      } else {
        el.textContent = val;
      }
    });

    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-html");
      if (!key) return;
      el.innerHTML = t(lang, key);
    });

    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) {
      el.setAttribute("aria-label", t(lang, el.getAttribute("data-i18n-aria-label")));
    });

    document.querySelectorAll("[data-i18n-alt]").forEach(function (el) {
      el.setAttribute("alt", t(lang, el.getAttribute("data-i18n-alt")));
    });

    document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      el.setAttribute("title", t(lang, el.getAttribute("data-i18n-title")));
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
