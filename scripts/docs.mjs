// The on-site docs: renders content/docs/**/*.md (a copy of the repository's docs/, refreshed with
// `node scripts/build-seo.mjs --sync-docs <repo>/docs`) into docs/<slug>.html and en/docs/<slug>.html,
// plus the docs home (docs.html, en/docs.html) and a search index per language. build-seo.mjs calls
// buildDocs() and adds the SEO head block and the sitemap entries; nothing here runs in the browser.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const REPO = "https://github.com/Cookieboty/nomi-ai";

/** Sidebar order. `src` is relative to docs/ in the repository; titles and blurbs follow docs/README.md. */
export const GROUPS = [
  {
    zh: "开始",
    en: "Get started",
    pages: [
      { slug: "getting-started", src: "getting-started.md", zh: ["快速上手", "安装、首次引导、开编程助手会话、添加模型、常用快捷键"], en: ["Getting started", "Install, onboarding, open a coding-agent session, add a model, shortcuts"] },
    ],
  },
  {
    zh: "Agent 工作台",
    en: "Agent workbench",
    pages: [
      { slug: "coding-agents", src: "features/coding-agents.md", zh: ["编程助手", "Claude Code / Codex / Gemini CLI 等：账号与第三方供应商、权限模式、工坊、会话"], en: ["Coding agents", "Claude Code / Codex / Gemini CLI and more: accounts, providers, permission modes, workbench"] },
      { slug: "agent-board", src: "development/agent-board.md", zh: ["Agent 看板", "谁在干活、做到哪了、内存与 CPU；内存守护自动暂停 / 恢复"], en: ["Agent board", "Who is working, how far along, memory and CPU; the memory guard pauses and resumes"] },
      { slug: "agent-monitor", src: "features/agent-monitor.md", zh: ["编程助手监视", "本机编程工具的进度提醒"], en: ["Coding-agent monitor", "Progress notices for local coding tools"] },
      { slug: "slash-commands", src: "features/slash-commands.md", zh: ["斜杠命令", "输入 / 弹出命令，内置命令在界面里执行，其余转给 CLI"], en: ["Slash commands", "The / palette; built-ins run in the UI, the rest go to the CLI"] },
      { slug: "privacy-security", src: "features/privacy-security.md", zh: ["隐私与安全", "数据位置、仅本地模式、外发保护、权限确认、导出与清除"], en: ["Privacy & security", "Data location, local-only mode, outbound masking, prompts, export"] },
    ],
  },
  {
    zh: "模型与工具",
    en: "Models & tools",
    pages: [
      { slug: "providers", src: "features/providers.md", zh: ["第三方供应商与模型", "给对话和各编程助手分配模型，多 Key，失败不换模型"], en: ["Providers & models", "Assign models to chat and each coding agent, multiple keys, no model switch on failure"] },
      { slug: "local-models", src: "features/local-models.md", zh: ["本地模型", "一键运行开源小模型、Ollama、离线模式"], en: ["Local models", "One-click small models, Ollama, offline mode"] },
      { slug: "mcp-skills", src: "features/mcp-skills.md", zh: ["MCP 与技能", "MCP 服务器、SKILL.md 技能、从其他工具导入"], en: ["MCP & skills", "MCP servers, SKILL.md packs, importing from other tools"] },
      { slug: "automation", src: "features/automation.md", zh: ["自动化与桌面能力", "文件、命令、提醒与剪贴板、代码沙箱、工具权限、操作记录"], en: ["Automation", "Files, commands, reminders, clipboard, code sandbox, tool permissions"] },
    ],
  },
  {
    zh: "Nomi",
    en: "Nomi",
    pages: [
      { slug: "chat", src: "features/chat.md", zh: ["AI 对话", "对话与工坊、图片与文件、生成图片与素材库、命令面板"], en: ["AI chat", "Assistant and workbench, images and files, image generation, command palette"] },
      { slug: "knowledge-base", src: "features/knowledge-base.md", zh: ["知识库", "基于你的文件夹回答，并给出引用"], en: ["Knowledge base", "Answers from your folders, with citations"] },
      { slug: "memory", src: "features/memory.md", zh: ["长期记忆", "Nomi 记得什么、怎么想起、怎么管理"], en: ["Long-term memory", "What Nomi remembers and how to manage it"] },
      { slug: "scheduling", src: "features/scheduling-calendar.md", zh: ["日程与任务", "提醒、定时任务、主动聊天、免打扰、持续任务"], en: ["Schedule & tasks", "Reminders, jobs, proactive chat, do-not-disturb, persistent tasks"] },
      { slug: "mascot", src: "features/mascot.md", zh: ["桌面角色", "可选，可随时关掉：动作、显示方式、工具栏、大小与互动"], en: ["Desktop character", "Optional, close it any time: actions, display, toolbar, size, settings"] },
      { slug: "voice", src: "features/voice.md", zh: ["语音", "语音输入、唤醒词、角色的声音"], en: ["Voice", "Speech input, wake word, the character's voice"] },
      { slug: "dynamic-island", src: "features/dynamic-island.md", zh: ["灵动岛通知", "macOS 刘海处的通知"], en: ["Dynamic Island", "Notch-style notices on macOS"] },
    ],
  },
  {
    zh: "应用",
    en: "App",
    pages: [
      { slug: "personalization", src: "features/personalization.md", zh: ["个性化", "主题、应用图标、侧栏、快捷键、语言、无障碍"], en: ["Personalization", "Themes, app icons, sidebar, shortcuts, language, accessibility"] },
      { slug: "auto-update", src: "features/auto-update.md", zh: ["自动更新", "后台下载，确认后原地安装并重启"], en: ["Auto-update", "Background download; installs in place and relaunches when you confirm"] },
    ],
  },
  {
    zh: "角色包与接入",
    en: "Character packs & integrations",
    pages: [
      { slug: "character-pack", src: "character-pack/README.md", zh: ["角色包", "单角色整包换肤：校验、构建、运行时覆盖"], en: ["Character packs", "One complete character per build: validate, build, runtime override"] },
      { slug: "character-pack-replacing", src: "character-pack/REPLACING.md", zh: ["替换官方角色", "第三方与 Fork：新建包、校验、构建、远程素材"], en: ["Replacing the character", "For forks: new pack, validation, build, remote assets"] },
      { slug: "character-pack-contract", src: "character-pack/CONTRACT.md", zh: ["角色包契约", "manifest、persona、mapping 的结构与校验"], en: ["Character pack contract", "The manifest, persona and mapping schema"] },
      { slug: "character-pack-checklist", src: "character-pack/designer-checklist.md", zh: ["设计师交付检查表", "交付角色素材前逐项核对"], en: ["Designer checklist", "What to check before handing over character assets"] },
      { slug: "provider-link", src: "integrations/provider-link.md", zh: ["供应商链接接入", "中转站 / 模型平台的「添加到 Nomi」按钮"], en: ["Provider links", "The “Add to Nomi” button for relays and model platforms"] },
    ],
  },
  {
    zh: "开发",
    en: "Development",
    pages: [
      { slug: "architecture", src: "development/architecture.md", zh: ["架构概览", "Go 内核、Wails 外壳与视图怎么分工"], en: ["Architecture", "How the Go core, the Wails shell and the views fit together"] },
      { slug: "contract", src: "development/contract.md", zh: ["应用契约", "视图与内核之间的过程、事件与传输"], en: ["App contract", "Procedures, events and transport between the views and the core"] },
      { slug: "gateway", src: "development/gateway.md", zh: ["统一网关", "四种协议互转、路由、供应商与模型"], en: ["Unified gateway", "Four protocols, routing, providers and models"] },
      { slug: "dev-coding-agents", src: "development/coding-agents.md", zh: ["编程助手接入", "插件、会话驱动、编排器、权限档位"], en: ["Coding-agent integration", "Plugins, session drivers, the orchestrator, permission levels"] },
      { slug: "security", src: "development/security.md", zh: ["安全边界", "路径授权、命令审核、代码沙箱、网络与密钥"], en: ["Security boundaries", "Path grants, command review, code sandbox, network and keys"] },
      { slug: "building", src: "development/building.md", zh: ["构建与运行", "开发环境、打包与本机运行"], en: ["Building", "Dev setup, packaging and running locally"] },
      { slug: "testing", src: "development/testing.md", zh: ["测试", "单元、Go 与端到端测试"], en: ["Testing", "Unit, Go and end-to-end tests"] },
      { slug: "ci", src: "development/ci.md", zh: ["CI", "各 workflow 的触发规则与重试"], en: ["CI", "Workflow triggers and retries"] },
      { slug: "i18n", src: "development/i18n.md", zh: ["多语言", "界面文案与翻译的规范"], en: ["i18n", "Rules for UI strings and translations"] },
      { slug: "frontend-standards", src: "development/frontend-standards.md", zh: ["前端工程规范", "令牌、组件与样式约定"], en: ["Frontend standards", "Tokens, components and styling rules"] },
    ],
  },
];

const PAGES = GROUPS.flatMap((group) => group.pages.map((page) => ({ ...page, group })));
const BY_SRC = new Map(PAGES.map((page) => [page.src, page]));

const UI = {
  zh: {
    docs: "文档", search: "搜索文档", searchHint: "搜索文档…", noResults: "没有找到相关内容", onThisPage: "本页内容",
    prev: "上一篇", next: "下一篇", edit: "在 GitHub 上编辑此页", menu: "文档目录", close: "关闭目录", backTop: "回到顶部",
    copy: "复制", copied: "已复制", homeTitle: "Nomi·诺米 文档", homeLead: "从安装到派出第一个编程助手，再到接模型、管权限、做角色包。每一篇都随版本更新。",
    startHere: "从这里开始", allTopics: "全部主题", pages: "篇", zhOnly: "",
  },
  en: {
    docs: "Docs", search: "Search docs", searchHint: "Search docs…", noResults: "Nothing found", onThisPage: "On this page",
    prev: "Previous", next: "Next", edit: "Edit this page on GitHub", menu: "Docs menu", close: "Close menu", backTop: "Back to top",
    copy: "Copy", copied: "Copied", homeTitle: "Nomi docs", homeLead: "From installing to your first coding agent, then models, permissions and character packs. Every page follows the latest release.",
    startHere: "Start here", allTopics: "All topics", pages: "pages", zhOnly: "This page has not been translated yet, so it is shown in Chinese.",
  },
};

const FEATURED = ["getting-started", "coding-agents", "providers"];

/* ---------- Markdown ---------- */

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const CJK = /[　-〿㐀-鿿＀-￯]/;
function joinLines(lines) {
  return lines.reduce((out, line) => {
    if (!out) return line;
    const glue = CJK.test(out.at(-1)) && CJK.test(line[0]) ? "" : " ";
    return out + glue + line;
  }, "");
}

const ALLOWED_TAGS = /^<\/?(br|kbd|sup|sub|details|summary|b|strong|em|code)\s*\/?>$/i;

/** Renders one Markdown document. `link(href)` maps a relative href to the site, `image(src)` the same for images. */
export function renderMarkdown(source, { link, image }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const headings = [];
  const ids = new Map();

  function inline(text) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) =>
      hold(`<img src="${escapeHtml(image(src))}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`));
    text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_, href) => hold(`<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`));
    text = text.replace(/<\/?[a-z]+\s*\/?>/gi, (tag) => (ALLOWED_TAGS.test(tag) ? hold(tag) : tag));
    // Links: the label may itself hold code or an image (already held), so only match up to the closing bracket.
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
      const target = link(href);
      const external = /^https?:/.test(target) && !target.startsWith("https://withnomi.app");
      return hold(`<a href="${escapeHtml(target)}"${external ? ' rel="noopener"' : ""}>`) + label + hold("</a>");
    });
    text = escapeHtml(text);
    text = text.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]).replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
  }

  function heading(level, text) {
    const plain = text.replace(/`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "");
    let id = githubSlug(plain) || "section";
    const n = ids.get(id) ?? 0;
    ids.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    if (level === 2 || level === 3) headings.push({ level, id, text: plain });
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inline(text)}</h${level}>`;
  }

  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  function blocks(start, end, baseIndent = 0) {
    const out = [];
    let i = start;
    while (i < end) {
      const raw = lines[i];
      const line = raw.slice(Math.min(baseIndent, raw.length - raw.trimStart().length));
      if (!line.trim()) { i++; continue; }

      const fence = line.match(/^(\s*)(```+|~~~+)\s*([\w+-]*)/);
      if (fence) {
        const body = [];
        i++;
        while (i < end && !lines[i].trim().startsWith(fence[2])) body.push(lines[i++].slice(fence[1].length + baseIndent));
        i++;
        const lang = fence[3] ? ` data-lang="${escapeHtml(fence[3])}"` : "";
        out.push(`<div class="code"${lang}><pre><code>${escapeHtml(body.join("\n"))}</code></pre></div>`);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { out.push(heading(h[1].length, h[2])); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (line.trim().startsWith("|") && i + 1 < end && isTableSep(lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
        i += 2;
        const rows = [];
        while (i < end && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
        const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(`<div class="table"><table><thead><tr>${head.map((c, j) => td("th", c, j)).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, j) => td("td", r[j] ?? "", j)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < end && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        const inner = renderMarkdown(quote.join("\n"), { link, image });
        out.push(`<blockquote class="callout">${inner.html}</blockquote>`);
        continue;
      }
      const item = line.match(listItem);
      if (item) {
        const indent = item[1].length;
        const ordered = /\d/.test(item[2]);
        const first = ordered ? parseInt(item[2], 10) : 1;
        const items = [];
        while (i < end) {
          const m = lines[i].slice(baseIndent).match(listItem);
          if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
          const contentIndent = baseIndent + indent + m[2].length + 1;
          const text = [m[3]];
          let j = i + 1;
          // Continuation lines of the item's first paragraph.
          while (j < end && lines[j].trim() && !lines[j].slice(baseIndent).match(listItem) && !/^\s*(```|~~~|\|)/.test(lines[j]) && lines[j].length - lines[j].trimStart().length > indent) text.push(lines[j++].trim());
          // Nested blocks: anything indented deeper than the marker, blank lines allowed in between.
          let k = j;
          let last = j;
          while (k < end) {
            if (!lines[k].trim()) { k++; continue; }
            if (lines[k].length - lines[k].trimStart().length - baseIndent > indent) { last = ++k; continue; }
            break;
          }
          const nested = last > j ? blocks(j, last, Math.min(contentIndent, baseIndent + indent + 2)) : "";
          items.push(`<li>${inline(joinLines(text))}${nested}</li>`);
          i = last > j ? last : j;
          while (i < end && !lines[i].trim() && i + 1 < end && lines[i + 1].slice(baseIndent).match(listItem)?.[1].length === indent) i++;
        }
        out.push(ordered ? `<ol${first !== 1 ? ` start="${first}"` : ""}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      if (/^\s*<(p|div|details|table|picture|img)\b/i.test(line)) {
        // Raw HTML blocks from the repository (language switchers, centred images): dropped on the site.
        while (i < end && lines[i].trim()) i++;
        continue;
      }
      const para = [];
      while (i < end) {
        const l = lines[i];
        if (!l.trim() || /^\s*(#{1,6}\s|```|~~~|>|\|)/.test(l) || (para.length && l.slice(baseIndent).match(listItem))) break;
        para.push(l.trim());
        i++;
      }
      if (para.length) out.push(`<p>${inline(joinLines(para))}</p>`);
      else i++;
    }
    return out.join("\n");
  }

  return { html: blocks(0, lines.length), headings };
}

/** Splits a bilingual file (## 中文 … ## English …) into its two halves, one heading level up. */
function splitLanguages(markdown) {
  const zhAt = markdown.search(/^## 中文\s*$/m);
  const enAt = markdown.search(/^## English\s*$/m);
  if (zhAt < 0 || enAt < 0) return null;
  const promote = (text) => text.replace(/^(#{3,6})(\s)/gm, (_, hashes, space) => hashes.slice(1) + space).replace(/^\s*---\s*$/gm, "");
  const zh = markdown.slice(zhAt, enAt).replace(/^## 中文\s*$/m, "");
  const en = markdown.slice(enAt).replace(/^## English\s*$/m, "");
  return { zh: promote(zh), en: promote(en) };
}

/* ---------- Pages ---------- */

function sourceFor(root, page, lang) {
  const markdown = readFileSync(join(root, "content/docs", page.src), "utf8");
  const body = markdown.replace(/^#\s+.*\n/, "");
  const halves = splitLanguages(body);
  if (halves) return { markdown: halves[lang], translated: true };
  return { markdown: body, translated: lang === "zh" };
}

export function docFile(slug, lang) {
  return `${lang === "en" ? "en/" : ""}docs/${slug}.html`;
}

/**
 * Builds every docs page for one language. `chrome(lang, { depth, langHref })` returns the page header and footer;
 * the result is [{ file, title, description, body, crumbs, depth, lang, other }] for build-seo.mjs to wrap.
 */
export function buildDocs(root, lang) {
  const ui = UI[lang];
  const otherLang = lang === "en" ? "zh" : "en";
  const pages = [];
  const searchIndex = [];

  for (const [index, page] of PAGES.entries()) {
    const dir = posix.dirname(page.src);
    const { markdown, translated } = sourceFor(root, page, lang);
    const link = (href) => {
      if (/^(https?:|mailto:|#)/.test(href)) return href;
      const [path, hash = ""] = href.split("#");
      const resolved = posix.normalize(posix.join(dir, path));
      const target = BY_SRC.get(resolved);
      if (target) return `${target.slug}.html${hash ? `#${hash}` : ""}`;
      if (resolved === "README.md") return `../docs.html`;
      if (resolved.startsWith("releases/")) return `../changelog.html`;
      // Everything else (source files, release and brand guides) lives in the repository.
      const repoPath = posix.normalize(posix.join("docs", resolved));
      const kind = /\.[a-z0-9]+$/i.test(repoPath) ? "blob" : "tree";
      return `${REPO}/${kind}/main/${repoPath}${hash ? `#${hash}` : ""}`;
    };
    const image = (src) => {
      if (/^https?:/.test(src)) return src;
      const name = posix.basename(src);
      return `${lang === "en" ? "../../" : "../"}assets/docs/${name}`;
    };
    const { html, headings } = renderMarkdown(markdown, { link, image });
    const [title, description] = page[lang];
    const prev = PAGES[index - 1];
    const next = PAGES[index + 1];

    const toc = headings.length
      ? `<nav class="docs-toc" aria-label="${ui.onThisPage}"><p class="docs-toc-title">${ui.onThisPage}</p><ul>${headings
          .map((h) => `<li class="lv${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("")}</ul><a class="docs-toc-top" href="#top">${ui.backTop} ↑</a></nav>`
      : `<nav class="docs-toc" aria-hidden="true"></nav>`;

    const pager = `<nav class="docs-pager" aria-label="${ui.prev} / ${ui.next}">${
      prev ? `<a class="prev" href="${prev.slug}.html"><small>← ${ui.prev}</small><span>${escapeHtml(prev[lang][0])}</span></a>` : "<span></span>"}${
      next ? `<a class="next" href="${next.slug}.html"><small>${ui.next} →</small><span>${escapeHtml(next[lang][0])}</span></a>` : "<span></span>"}</nav>`;

    const body = `<div class="docs-shell wrap-wide">
${sidebar(lang, page.slug, "")}
      <article class="docs-main" id="top">
        <nav class="crumbs" aria-label="breadcrumb"><a href="../docs.html">${ui.docs}</a><span aria-hidden="true">/</span><span>${escapeHtml(page.group[lang])}</span></nav>
        <h1>${escapeHtml(title)}</h1>
        <p class="docs-desc">${escapeHtml(description)}</p>
        ${translated ? "" : `<p class="docs-note" role="note">${ui.zhOnly}</p>`}
        <div class="doc">
${html}
        </div>
        <p class="docs-edit"><a href="${REPO}/edit/main/docs/${page.src}" rel="noopener">${ui.edit}</a></p>
        ${pager}
      </article>
      ${toc}
    </div>`;

    pages.push({ file: docFile(page.slug, lang), slug: page.slug, title, description, body, group: page.group[lang], inSubdir: true });
    searchIndex.push({
      u: `${page.slug}.html`,
      t: title,
      g: page.group[lang],
      d: description,
      h: headings.map((h) => [h.id, h.text]),
      x: html.replace(/<(pre|div class="code")[\s\S]*?<\/pre>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim(),
    });
  }

  // Docs home.
  const featured = FEATURED.map((slug) => PAGES.find((p) => p.slug === slug));
  const homeBody = `<div class="docs-shell docs-shell--home wrap-wide">
${sidebar(lang, "", "docs/")}
      <article class="docs-main docs-home" id="top">
        <p class="eyebrow">${ui.docs}</p>
        <h1>${ui.homeTitle}</h1>
        <p class="docs-desc">${ui.homeLead}</p>
        <button class="docs-search-trigger docs-search-trigger--big" type="button" data-search-open><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>${ui.searchHint}</span><kbd>/</kbd></button>
        <h2 class="docs-home-h">${ui.startHere}</h2>
        <div class="docs-featured">${featured
          .map((p, n) => `<a class="docs-feature" href="docs/${p.slug}.html"><span class="num">0${n + 1}</span><strong>${escapeHtml(p[lang][0])}</strong><span>${escapeHtml(p[lang][1])}</span></a>`).join("")}</div>
        <h2 class="docs-home-h">${ui.allTopics}</h2>
        <div class="docs-groups">${GROUPS.map((group) => `<section class="docs-group"><h3>${escapeHtml(group[lang])}<small>${group.pages.length} ${ui.pages}</small></h3><ul>${group.pages
          .map((p) => `<li><a href="docs/${p.slug}.html"><strong>${escapeHtml(p[lang][0])}</strong><span>${escapeHtml(p[lang][1])}</span></a></li>`).join("")}</ul></section>`).join("")}</div>
      </article>
    </div>`;
  pages.unshift({ file: `${lang === "en" ? "en/" : ""}docs.html`, slug: "", title: ui.homeTitle, description: ui.homeLead, body: homeBody, inSubdir: false });

  return { pages, searchIndex: JSON.stringify(searchIndex), searchFile: `${lang === "en" ? "en/" : ""}docs/search.json`, otherLang };
}

function sidebar(lang, current, prefix) {
  const ui = UI[lang];
  return `      <aside class="docs-sidebar" id="docs-sidebar" aria-label="${ui.menu}" data-search-url="${prefix}search.json" data-search-base="${prefix}" data-ui='${escapeHtml(JSON.stringify({ noResults: ui.noResults, copy: ui.copy, copied: ui.copied }))}'>
        <div class="docs-sidebar-head"><button class="docs-search-trigger" type="button" data-search-open><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>${ui.searchHint}</span><kbd>/</kbd></button><button class="docs-sidebar-close" type="button" data-docs-close aria-label="${ui.close}">×</button></div>
        <nav class="docs-nav">${GROUPS.map((group) => `<div class="docs-nav-group"><p>${escapeHtml(group[lang])}</p><ul>${group.pages
          .map((p) => `<li><a href="${prefix}${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ""}>${escapeHtml(p[lang][0])}</a></li>`).join("")}</ul></div>`).join("")}</nav>
      </aside>
      <button class="docs-menu-btn" type="button" aria-controls="docs-sidebar" aria-expanded="false" data-docs-open><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h16"/></svg><span>${ui.menu}</span></button>
      <div class="docs-search" role="dialog" aria-modal="true" aria-label="${ui.search}" hidden><div class="docs-search-panel"><label class="docs-search-field"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" placeholder="${ui.searchHint}" aria-label="${ui.search}" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></label><ul class="docs-search-results" role="listbox"></ul></div></div>`;
}

/** Copies the docs from a checkout of the repository into content/docs, with the screenshots they use. */
export function syncDocs(root, repoDocs) {
  const images = new Set();
  for (const page of PAGES) {
    const from = join(repoDocs, page.src);
    const to = join(root, "content/docs", page.src);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    for (const [, src] of readFileSync(from, "utf8").matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      if (!/^https?:/.test(src)) images.add(posix.normalize(posix.join(posix.dirname(page.src), src)));
    }
  }
  mkdirSync(join(root, "assets/docs"), { recursive: true });
  for (const image of images) {
    const from = join(repoDocs, image);
    if (existsSync(from)) copyFileSync(from, join(root, "assets/docs", posix.basename(image)));
    else console.warn(`docs: missing image ${image}`);
  }
  return PAGES.length;
}
