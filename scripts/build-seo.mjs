// Generates the English pages at root (/), Chinese pages under zh/, legacy /en/ redirects,
// the SEO <head> block of every page, sitemap.xml, and llms.txt.
// `--check` fails when any output is out of date; `--icons` regenerates favicon.ico.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildDocs, docFile, syncDocs } from "./docs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://withnomi.app";
const pages = ["index", "features", "download", "changelog", "privacy"];
const langs = ["en", "zh"];
const hreflang = { zh: "zh-CN", en: "en" };
const ogLocale = { zh: "zh_CN", en: "en_US" };
const ogImage = { url: `${origin}/assets/brand/og-image.png`, width: 1200, height: 630 };
const siteName = (lang) => (lang === "zh" ? "Nomi·诺米" : "Nomi");
const checkOnly = process.argv.includes("--check");
const syncFrom = process.argv[process.argv.indexOf("--sync-docs") + 1];
if (process.argv.includes("--sync-docs")) {
  if (!syncFrom || !existsSync(join(syncFrom, "getting-started.md"))) throw new Error("--sync-docs <path to the repository's docs/>");
  console.log(`Copied ${syncDocs(root, syncFrom)} docs from ${syncFrom}`);
}

const context = { document: { readyState: "loading", addEventListener() {} }, window: {} };
vm.runInNewContext(readFileSync(join(root, "js/i18n.js"), "utf8"), context);
const dict = context.window.NomiI18n.dict;

for (const k of Object.keys(dict.zh)) {
  if (!(k in dict.en)) throw new Error(`i18n.js: key "${k}" missing in en`);
}
for (const k of Object.keys(dict.en)) {
  if (!(k in dict.zh)) throw new Error(`i18n.js: key "${k}" missing in zh`);
}

const version = readFileSync(join(root, "download.html"), "utf8").match(/releases\/download\/v(\d+\.\d+\.\d+)\//)?.[1];
if (!version) throw new Error("download.html: no release download link to read the version from");

function file(page, lang) {
  return `${lang === "zh" ? "zh/" : ""}${page}.html`;
}

/** Canonical URL: English is at / (default) and /<page>.html; Chinese is at /zh/ and /zh/<page>.html. */
function url(page, lang) {
  if (page === "index") return `${origin}/${lang === "zh" ? "zh/" : ""}`;
  return `${origin}/${file(page, lang)}`;
}

function meta(page, lang) {
  const prefix = page === "index" ? "home" : page;
  const title = dict[lang][`meta.${prefix}.title`];
  const description = dict[lang][`meta.${prefix}.desc`];
  if (!title || !description) throw new Error(`i18n.js: missing meta.${prefix}.title / desc for ${lang}`);
  return { title, description };
}

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function assertKeysExist(html, sourceName) {
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
    const key = m[1];
    if (!(key in dict.zh) || !(key in dict.en)) {
      throw new Error(`${sourceName}: missing i18n key "${key}"`);
    }
  }
}

/** Page body in one language: every data-i18n(-html) element gets its text, every data-i18n-<attr> its attribute. */
function translate(html, lang) {
  html = html.replace(/<[^>]+data-i18n-[a-z-]+="[^"]+"[^>]*>/g, (tag) => {
    for (const attr of ["aria-label", "alt", "placeholder", "title"]) {
      const key = tag.match(new RegExp(`data-i18n-${attr}="([^"]+)"`))?.[1];
      if (!key || dict[lang][key] == null) continue;
      const value = escape(dict[lang][key]);
      tag = new RegExp(`\\s${attr}="[^"]*"`).test(tag)
        ? tag.replace(new RegExp(`\\s${attr}="[^"]*"`), () => ` ${attr}="${value}"`)
        : tag.replace(/\s*\/?>$/, (end) => ` ${attr}="${value}"${end}`);
    }
    return tag;
  });
  return html.replace(/<([a-z0-9]+)([^>]*\sdata-i18n(?:-html)?="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>/gi, (whole, name, attrs, key) =>
    dict[lang][key] == null ? whole : `<${name}${attrs}>${dict[lang][key]}</${name}>`);
}

function featureListFor(lang) {
  return lang === "zh"
    ? [
        "Agent 并行看板（Claude Code、Codex、Gemini CLI、Grok、dsh、Kimi Code、MiniMax Code）",
        "统一工作区按会话直选本机官方 CLI，不改全局配置",
        "四协议本地统一模型网关（Anthropic Messages / OpenAI Responses / Chat Completions / Gemini）",
        "可按需展开的多标签侧边工作区（并排 Diff、内置分屏终端、运行轨迹与原生浏览器）",
        "本地文件夹知识库问答与可编辑长期记忆",
        "macOS 系统沙箱与外部内容污点保护",
      ]
    : [
        "Parallel Agent Board for Claude Code, Codex, Gemini CLI, Grok, dsh, Kimi Code & MiniMax Code",
        "Unified workspace with per-conversation official CLI selection without modifying global config",
        "Local 4-protocol unified model gateway (Anthropic Messages, OpenAI Responses, Chat Completions, Gemini)",
        "On-demand multi-tab side workspace with side-by-side Diff, built-in split terminal, run traces & native browser",
        "Local folder knowledge base with cited Q&A and editable memory",
        "macOS system sandbox and external-content taint protection",
      ];
}

function schemas({ lang, title, description, pageUrl, crumbs, isHome, isDownload, isDocArticle, docMeta, docItems }) {
  const brandName = siteName(lang);
  const webPageNode = {
    "@type": docItems ? ["WebPage", "CollectionPage"] : "WebPage",
    "@id": pageUrl,
    url: pageUrl,
    name: title,
    description,
    inLanguage: hreflang[lang],
    isPartOf: { "@id": `${origin}/#website` },
  };
  if (docItems) {
    webPageNode.mainEntity = {
      "@type": "ItemList",
      itemListElement: docItems.map(([name, item], i) => ({
        "@type": "ListItem",
        position: i + 1,
        name,
        url: item,
      })),
    };
  }
  const graph = [
    {
      "@type": "Organization",
      "@id": `${origin}/#organization`,
      name: brandName,
      alternateName: ["Nomi", "Nomi·诺米"],
      url: `${origin}/`,
      logo: `${origin}/assets/brand/favicon-96.png`,
      sameAs: ["https://github.com/Cookieboty/nomi-ai"],
    },
    {
      "@type": "WebSite",
      "@id": `${origin}/#website`,
      url: `${origin}/`,
      name: brandName,
      inLanguage: ["en", "zh-CN"],
      publisher: { "@id": `${origin}/#organization` },
    },
    webPageNode,
  ];

  if (crumbs) {
    graph.push({
      "@type": "BreadcrumbList",
      itemListElement: crumbs.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
    });
  }

  if (isHome || isDownload) {
    graph.push({
      "@type": "SoftwareApplication",
      "@id": `${origin}/#software`,
      name: brandName,
      url: url("index", lang),
      description: meta("index", lang).description,
      image: ogImage.url,
      screenshot: [
        `${origin}/assets/screenshots/agent-board-hero.webp`,
        `${origin}/assets/screenshots/workspace.webp`,
        `${origin}/assets/screenshots/models-gateway.webp`,
      ],
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "AI Agent Workbench",
      operatingSystem: ["Windows 10", "Windows 11", "macOS 12+", "Linux x86_64"],
      softwareVersion: version,
      fileSize: "25MB",
      isAccessibleForFree: true,
      license: "https://opensource.org/license/mit",
      codeRepository: "https://github.com/Cookieboty/nomi-ai",
      downloadUrl: url("download", lang),
      releaseNotes: url("changelog", lang),
      inLanguage: ["en", "zh-CN"],
      featureList: featureListFor(lang),
      publisher: { "@id": `${origin}/#organization` },
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    });
  }

  if (isHome) {
    const mainEntity = [];
    for (let i = 1; i <= 6; i++) {
      mainEntity.push({
        "@type": "Question",
        name: dict[lang][`faq.${i}.q`],
        acceptedAnswer: { "@type": "Answer", text: dict[lang][`faq.${i}.a`] },
      });
    }
    graph.push({ "@type": "FAQPage", "@id": `${pageUrl}#faq`, mainEntity });
  }

  if (isDocArticle) {
    const article = {
      "@type": "TechArticle",
      "@id": `${pageUrl}#article`,
      mainEntityOfPage: { "@id": pageUrl },
      headline: title,
      description,
      url: pageUrl,
      image: ogImage.url,
      inLanguage: hreflang[lang],
      author: { "@id": `${origin}/#organization` },
      publisher: { "@id": `${origin}/#organization` },
      isPartOf: { "@id": `${origin}/#website` },
    };
    if (docMeta?.section) article.articleSection = docMeta.section;
    if (docMeta?.dateModified) article.dateModified = docMeta.dateModified;
    if (docMeta?.wordCount) article.wordCount = docMeta.wordCount;
    graph.push(article);
  }

  return `  <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2)}</script>`;
}

/** The generated <head> block. `urls` maps each language to that page's canonical URL. */
function seoHead({ lang, title, description, urls, crumbs, isHome = false, isDownload = false, isDocArticle = false, docMeta = null, docItems = null, indexable = true, hasEn = true }) {
  const other = lang === "en" ? "zh" : "en";
  const brandName = siteName(lang);
  const robots = indexable ? "index,follow,max-image-preview:large" : "noindex,follow";
  const alternates = [];
  if (hasEn) alternates.push(`  <link rel="alternate" hreflang="en" href="${urls.en}" />`);
  alternates.push(`  <link rel="alternate" hreflang="zh-CN" href="${urls.zh}" />`);
  alternates.push(`  <link rel="alternate" hreflang="x-default" href="${hasEn ? urls.en : urls.zh}" />`);

  return `  <!-- seo:start — generated by scripts/build-seo.mjs, do not edit by hand -->
  <link rel="canonical" href="${urls[lang]}" />
${alternates.join("\n")}
  <meta name="robots" content="${robots}" />
  <meta property="og:type" content="${isDocArticle ? "article" : "website"}" />
  <meta property="og:title" content="${escape(title)}" />
  <meta property="og:description" content="${escape(description)}" />
  <meta property="og:url" content="${urls[lang]}" />
  <meta property="og:site_name" content="${escape(brandName)}" />
  <meta property="og:locale" content="${ogLocale[lang]}" />
  <meta property="og:locale:alternate" content="${ogLocale[other]}" />
  <meta property="og:image" content="${ogImage.url}" />
  <meta property="og:image:alt" content="${escape(brandName)}" />
  <meta property="og:image:width" content="${ogImage.width}" />
  <meta property="og:image:height" content="${ogImage.height}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escape(title)}" />
  <meta name="twitter:description" content="${escape(description)}" />
  <meta name="twitter:image" content="${ogImage.url}" />
  <meta name="twitter:image:alt" content="${escape(brandName)}" />
${schemas({ lang, title, description, pageUrl: urls[lang], crumbs, isHome, isDownload, isDocArticle, docMeta, docItems })}
  <!-- seo:end -->
`;
}

function seoBlock(page, lang) {
  const { title, description } = meta(page, lang);
  const urls = { zh: url(page, "zh"), en: url(page, "en") };
  const crumbs = page === "index" ? null : [[dict[lang]["nav.home"], url("index", lang)], [dict[lang][`nav.${page}`] ?? title, urls[lang]]];
  return seoHead({ lang, title, description, urls, crumbs, isHome: page === "index", isDownload: page === "download" });
}

/** Rebuilds the EN / 中 toggle as canonical links to the same page in each language. */
function languageLinks(html, page, lang) {
  return html.replace(/(<div class="lang-toggle"[^>]*>)[\s\S]*?(\n?[ \t]*<\/div>)/, (_, open, close) => {
    const indent = close.match(/\n([ \t]*)/)?.[1] ?? "";
    const links = langs.map((target) => {
      const href = page === "index"
        ? (target === lang ? "./" : lang === "zh" ? "../" : "zh/")
        : (target === lang ? `${page}.html` : lang === "zh" ? `../${page}.html` : `zh/${page}.html`);
      const active = target === lang ? ' class="lang-btn is-active" aria-current="true"' : ' class="lang-btn"';
      return `${indent}  <a${active} data-lang="${target}" href="${href}" hreflang="${hreflang[target]}" lang="${hreflang[target]}">${target === "en" ? "EN" : "中"}</a>`;
    });
    return `${open}\n${links.join("\n")}${close}`;
  });
}

/** Strips everything an earlier run injected, so the template returns to its hand-written form. */
function clean(html) {
  return html
    .replace(/[ \t]*<!-- seo:start[\s\S]*?<!-- seo:end -->\n?/g, "")
    .replace(/[ \t]*<link rel="canonical"[\s\S]*?(?=<meta name="theme-color")/, "")
    .split("\n")
    .filter((line) => !/<meta (property="og:|name="twitter:)|<link rel="apple-touch-icon"|<link rel="icon" href="assets\/brand\/favicon\.ico"/.test(line))
    .join("\n")
    .replace(/\n[ \t]*<meta name="theme-color"/, '\n  <meta name="theme-color"');
}

function build(source, page, lang) {
  let html = translate(source, lang);
  html = html.replace(/<html lang="[^"]+">/, `<html lang="${hreflang[lang]}">`);
  html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${meta(page, lang).title}</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${escape(meta(page, lang).description)}" />`);
  html = html.replace(/[ \t]*<meta name="theme-color"/, (tag) => `${seoBlock(page, lang)}${tag}`);
  html = html.replace(/([ \t]*)<link rel="icon" href="assets\/brand\/nomi-mark\.svg" type="image\/svg\+xml" \/>/, (line, indent) =>
    `${indent}<link rel="icon" href="assets/brand/favicon.ico" sizes="48x48" />\n${line}\n${indent}<link rel="apple-touch-icon" sizes="180x180" href="assets/brand/apple-touch-icon.png" />`);
  html = languageLinks(html, page, lang);
  if (lang === "zh") html = html.replace(/(["'( ])(assets\/|css\/|js\/)/g, "$1../$2");
  return html;
}

const today = new Date().toISOString().slice(0, 10);
function lastmod(...files) {
  try {
    if (execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8" }).trim()) return today;
    const date = execFileSync("git", ["log", "-1", "--format=%cs", "--", ...files], { cwd: root, encoding: "utf8" }).trim();
    return date || today;
  } catch {
    return today;
  }
}

const assetVersion = readFileSync(join(root, "index.html"), "utf8").match(/css\/site\.css\?v=(\w+)/)?.[1] ?? "1";
const outputs = {};
for (const page of pages) {
  const source = clean(readFileSync(join(root, `${page}.html`), "utf8").replace(/\u0000/g, ""));
  assertKeysExist(source, `${page}.html`);
  for (const lang of langs) outputs[file(page, lang)] = build(source, page, lang);
}

/* ---------- Docs: pages generated from content/docs, wrapped in the home page's header and footer ---------- */

const indexSource = clean(readFileSync(join(root, "index.html"), "utf8"));

/** Header and footer of the home page in `lang`, with links fixed up for a page at `file`. */
function chrome(lang, file, langHrefs) {
  const html = translate(indexSource, lang);
  let header = html.match(/[ \t]*<header class="site-header">[\s\S]*?<\/header>/)[0];
  let footer = html.match(/[ \t]*<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
  const inSubdir = file.includes("docs/");
  const pagePrefix = inSubdir ? "../" : "";
  const assetPrefix = pagePrefix + (lang === "zh" ? "../" : "");
  const fix = (part) => part.replace(/\s(href|src)="(?!https?:|#|\/|mailto:)([^"]+)"/g, (_, attr, value) => {
    if (value === "./") return ` ${attr}="${pagePrefix || "./"}"`;
    return ` ${attr}="${/^(assets|css|js)\//.test(value) ? assetPrefix : pagePrefix}${value}"`;
  });
  header = fix(header.replace(/\saria-current="page"/g, "")).replace(/(<a href="[^"]*docs\.html")/, '$1 aria-current="page"');
  header = header.replace(/(<div class="lang-toggle"[^>]*>)[\s\S]*?(\n?[ \t]*<\/div>)/, (_, open, close) => {
    const indent = close.match(/\n([ \t]*)/)?.[1] ?? "";
    return `${open}\n${langs.map((target) => `${indent}  <a class="lang-btn${target === lang ? ' is-active" aria-current="true' : ""}" data-lang="${target}" href="${langHrefs[target]}" hreflang="${hreflang[target]}" lang="${hreflang[target]}">${target === "en" ? "EN" : "中"}</a>`).join("\n")}${close}`;
  });
  return { header, footer: fix(footer), assetPrefix };
}

/** Relative link from one site file to another. */
function relative(from, to) {
  return posix.relative(posix.dirname(from), to);
}

const docsByLang = Object.fromEntries(langs.map((lang) => [lang, buildDocs(root, lang)]));
const enTranslatedSlugs = new Set(docsByLang.en.pages.filter((p) => p.translated).map((p) => p.slug));
const docsOutputs = {};
const docsSitemap = [];

for (const lang of langs) {
  const { pages: docPages, searchIndex, searchFile } = docsByLang[lang];
  const docItems = docPages
    .filter((p) => p.slug)
    .map((p) => [p.title, `${origin}/${docFile(p.slug, lang)}`]);
  docsOutputs[searchFile] = `${searchIndex}\n`;
  for (const page of docPages) {
    const files = { en: page.slug ? docFile(page.slug, "en") : "docs.html", zh: page.slug ? docFile(page.slug, "zh") : "zh/docs.html" };
    const urls = { en: `${origin}/${files.en}`, zh: `${origin}/${files.zh}` };
    const langHrefs = { en: relative(page.file, files.en), zh: relative(page.file, files.zh) };
    const { header, footer, assetPrefix } = chrome(lang, page.file, langHrefs);
    const docsTitle = dict[lang]["nav.docs"];
    const title = page.slug ? `${page.title} — ${docsTitle} — ${siteName(lang)}` : meta("docs", lang).title;
    const description = page.slug ? (page.seoDescription || page.description) : meta("docs", lang).description;
    const crumbs = [[dict[lang]["nav.home"], url("index", lang)], [docsTitle, `${origin}/${lang === "zh" ? "zh/" : ""}docs.html`]];
    if (page.slug) crumbs.push([page.title, urls[lang]]);

    const hasEn = !page.slug || enTranslatedSlugs.has(page.slug);
    const indexable = lang === "zh" || page.translated;
    const docMeta = page.slug
      ? {
          section: page.group,
          wordCount: page.wordCount,
          dateModified: page.sourceFile ? lastmod(page.sourceFile) : undefined,
        }
      : null;

    docsOutputs[page.file] = `<!doctype html>
<html lang="${hreflang[lang]}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(description)}" />
${seoHead({ lang, title, description, urls, crumbs, isDocArticle: Boolean(page.slug), docMeta, docItems: page.slug ? null : docItems, indexable, hasEn })}  <meta name="theme-color" content="#14110F" />
  <link rel="icon" href="${assetPrefix}assets/brand/favicon.ico" sizes="48x48" />
  <link rel="icon" href="${assetPrefix}assets/brand/nomi-mark.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" sizes="180x180" href="${assetPrefix}assets/brand/apple-touch-icon.png" />
  <link rel="stylesheet" href="${assetPrefix}css/site.css?v=${assetVersion}" />
</head>
<body class="docs-page">
  <a class="skip" href="#main">${dict[lang]["s.skip"]}</a>
${header}
  <main id="main">
    ${page.body}
  </main>
${footer}
  <script src="${assetPrefix}js/site.js?v=${assetVersion}" defer></script>
  <script src="${assetPrefix}js/docs.js?v=${assetVersion}" defer></script>
</body>
</html>
`;
    if (lang === "zh") docsSitemap.push({ slug: page.slug, files, urls, hasEn });
  }
}
Object.assign(outputs, docsOutputs);

/* ---------- Legacy /en/* & directory index redirects -> canonical URLs ---------- */
// Do NOT add `noindex` on redirect stubs: Google treats 0-second meta refresh as a permanent
// redirect and consolidates signals to the canonical URL; mixing `noindex` with redirects sends
// conflicting signals.
function redirectStub(relTarget, canonicalUrl, title = "Nomi", lang = "en") {
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <title>${escape(title)}</title>
  <link rel="canonical" href="${canonicalUrl}" />
  <meta http-equiv="refresh" content="0; url=${relTarget}" />
  <script>window.location.replace(${JSON.stringify(relTarget)});</script>
</head>
<body><p>Redirecting to <a href="${relTarget}">${escape(title)}</a>…</p></body>
</html>
`;
}

const redirectSpecs = [
  ["en/index.html", "../", `${origin}/`, "Nomi", "en"],
  ["en/features.html", "../features.html", `${origin}/features.html`, "Nomi — Features", "en"],
  ["en/download.html", "../download.html", `${origin}/download.html`, "Nomi — Download", "en"],
  ["en/changelog.html", "../changelog.html", `${origin}/changelog.html`, "Nomi — Changelog", "en"],
  ["en/privacy.html", "../privacy.html", `${origin}/privacy.html`, "Nomi — Privacy", "en"],
  ["en/docs.html", "../docs.html", `${origin}/docs.html`, "Nomi — Docs", "en"],
  ...docsByLang.en.pages
    .filter((p) => p.slug)
    .map((p) => [
      `en/docs/${p.slug}.html`,
      `../../docs/${p.slug}.html`,
      `${origin}/docs/${p.slug}.html`,
      `${p.title} — Docs — Nomi`,
      "en",
    ]),
  // GitHub Pages redirects `/docs` -> `/docs/` when both `docs.html` and `docs/` exist;
  // providing directory index redirects avoids 404 on `/docs/` and `/zh/docs/`.
  ["docs/index.html", "../docs.html", `${origin}/docs.html`, "Nomi — Docs", "en"],
  ["zh/docs/index.html", "../docs.html", `${origin}/zh/docs.html`, "Nomi·诺米 — 文档", "zh-CN"],
];
for (const [stubFile, relTarget, canonicalUrl, title, lang] of redirectSpecs) {
  outputs[stubFile] = redirectStub(relTarget, canonicalUrl, title, lang);
}

/* ---------- GEO: llms.txt for AI search engines & assistants ---------- */
const enDocList = docsByLang.en.pages
  .filter((p) => p.slug)
  .map((p) => `- [${p.title}](${origin}/${p.file}): ${p.description}`)
  .join("\n");

outputs["llms.txt"] = `# Nomi

> Open-source, local-first AI agent workbench with a unified 4-protocol model gateway, built on Go + Wails v3 + React (~25 MB native installer, MIT license).

- Website (EN, Default): ${origin}/
- Website (ZH): ${origin}/zh/
- Features: ${origin}/features.html (${origin}/zh/features.html)
- Download (v${version}): ${origin}/download.html (${origin}/zh/download.html)
- Changelog: ${origin}/changelog.html (${origin}/zh/changelog.html)
- Privacy & Security: ${origin}/privacy.html (${origin}/zh/privacy.html)
- Repository: https://github.com/Cookieboty/nomi-ai

## Core Capabilities
- **Parallel Agent Board**: Monitor Nomi chats, background sub-tasks, dispatched agents, and external terminal/IDE sessions (read-only) in one place, with automatic memory-pressure pause & resume.
- **Unified Workspace & Direct CLI Base**: Manage all projects and agent endpoints in one unified sidebar, and pick installed official CLIs (Claude Code, Codex, Gemini CLI, etc.) per conversation in main chat.
- **Multi-Tab Side Workspace**: Expand on demand with side-by-side Diff review, per-turn undo, run traces (graph/timeline/thinking), integrated split terminal, native embedded browser, and side chat.
- **Models & Agents + Local Unified Gateway**: Configure task & cost routing, official accounts, third-party providers (4-protocol loopback translation across Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, and Gemini generateContent), and local models (llama.cpp / Ollama) in one place; retries stay on the same model.
- **Local-First Privacy & Sandbox**: No Nomi cloud account required. Chats, memories, and knowledge-base indexes stay local; API keys are stored in OS keychain; macOS system sandbox shields SSH/Git credentials and .env files.
- **Optional Desktop Character**: Off by default on fresh installs; every workbench capability works identically with it off.

## Installers (v${version})
- Windows (64-bit): https://github.com/Cookieboty/nomi-ai/releases/download/v${version}/Nomi-Setup-${version}.exe
- macOS (Apple silicon): https://github.com/Cookieboty/nomi-ai/releases/download/v${version}/Nomi-${version}-arm64.dmg
- macOS (Intel): https://github.com/Cookieboty/nomi-ai/releases/download/v${version}/Nomi-${version}.dmg
- Linux (AppImage): https://github.com/Cookieboty/nomi-ai/releases/download/v${version}/Nomi-${version}.AppImage
- Linux (Debian/Ubuntu .deb): https://github.com/Cookieboty/nomi-ai/releases/download/v${version}/nomi_${version}_amd64.deb

## Documentation Index
- [Docs Home (EN)](${origin}/docs.html) / [Docs Home (ZH)](${origin}/zh/docs.html)
${enDocList}
`;

let changed = [];
for (const [name, content] of Object.entries(outputs)) {
  const path = join(root, name);
  if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
  changed.push(name);
  if (!checkOnly) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

// lastmod is read after the pages are written, so a page this run changed counts as modified today.
const alternates = (page) => [...langs.map((l) => [hreflang[l], url(page, l)]), ["x-default", url(page, "en")]]
  .map(([code, href]) => `    <xhtml:link rel="alternate" hreflang="${code}" href="${href}" />`).join("\n");
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages.flatMap((page) => {
  const date = lastmod(`${page}.html`, `zh/${page}.html`);
  return langs.map((lang) => `  <url>\n    <loc>${url(page, lang)}</loc>\n    <lastmod>${date}</lastmod>\n${alternates(page)}\n  </url>`);
}).concat(docsSitemap.flatMap(({ files, urls, hasEn }) => {
  const date = lastmod(...(hasEn ? [files.en, files.zh] : [files.zh]));
  const altLines = [];
  if (hasEn) altLines.push(`    <xhtml:link rel="alternate" hreflang="en" href="${urls.en}" />`);
  altLines.push(`    <xhtml:link rel="alternate" hreflang="zh-CN" href="${urls.zh}" />`);
  altLines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${hasEn ? urls.en : urls.zh}" />`);
  const alt = altLines.join("\n");
  const entryLangs = hasEn ? langs : ["zh"];
  return entryLangs.map((lang) => `  <url>\n    <loc>${urls[lang]}</loc>\n    <lastmod>${date}</lastmod>\n${alt}\n  </url>`);
})).join("\n")}
</urlset>
`;
const sitemapPath = join(root, "sitemap.xml");
if (!existsSync(sitemapPath) || readFileSync(sitemapPath, "utf8") !== sitemap) {
  changed.push("sitemap.xml");
  if (!checkOnly) writeFileSync(sitemapPath, sitemap);
}

if (!checkOnly && process.argv.includes("--icons")) {
  execFileSync("sips", ["-s", "format", "ico", "-z", "48", "48", "assets/brand/favicon-96.png", "--out", "assets/brand/favicon.ico"], { cwd: root, stdio: "ignore" });
}

if (checkOnly && changed.length) {
  console.error(`Out of date, run node scripts/build-seo.mjs: ${changed.join(", ")}`);
  process.exit(1);
}
console.log(changed.length ? `Updated: ${changed.join(", ")}` : "Up to date");
