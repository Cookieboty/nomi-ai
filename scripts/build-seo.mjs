// Generates the English pages under en/, the SEO <head> block of every page and sitemap.xml.
// The Chinese pages are both input and output: everything this script injects sits between
// <!-- seo:start --> and <!-- seo:end --> (or is rebuilt from scratch, like the language toggle),
// so running it again gives the same files. `--check` fails when any output is out of date;
// `--icons` also regenerates favicon.ico from favicon-96.png (macOS only, needs sips).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "https://withnomi.app";
const pages = ["index", "download", "docs", "changelog", "privacy"];
const langs = ["zh", "en"];
const hreflang = { zh: "zh-CN", en: "en" };
const ogLocale = { zh: "zh_CN", en: "en_US" };
const ogImage = { url: `${origin}/assets/brand/og-image.png`, width: 1200, height: 630 };
const checkOnly = process.argv.includes("--check");

const context = { document: { readyState: "loading", addEventListener() {} }, window: {} };
vm.runInNewContext(readFileSync(join(root, "js/i18n.js"), "utf8"), context);
const dict = context.window.NomiI18n.dict;

const version = readFileSync(join(root, "download.html"), "utf8").match(/releases\/download\/v(\d+\.\d+\.\d+)\//)?.[1];
if (!version) throw new Error("download.html: no release download link to read the version from");

function file(page, lang) {
  return `${lang === "en" ? "en/" : ""}${page}.html`;
}

/** Canonical URL: the home pages are / and /en/, the rest keep their .html name. */
function url(page, lang) {
  if (page === "index") return `${origin}/${lang === "en" ? "en/" : ""}`;
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
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
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

function schemas(page, lang) {
  const pageUrl = url(page, lang);
  const graph = [{ "@type": "WebPage", "@id": pageUrl, url: pageUrl, name: meta(page, lang).title, inLanguage: hreflang[lang], isPartOf: { "@id": `${origin}/#website` } }];
  if (page === "index") graph.push({ "@type": "Organization", "@id": `${origin}/#organization`, name: "Nomi·诺米", url: `${origin}/`, logo: `${origin}/assets/brand/favicon-96.png`, sameAs: ["https://github.com/Cookieboty/nomi-ai"] });
  if (page !== "index") graph.push({ "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: dict[lang]["nav.home"], item: url("index", lang) },
    { "@type": "ListItem", position: 2, name: dict[lang][`nav.${page}`] ?? meta(page, lang).title, item: pageUrl },
  ] });
  return [
    { "@context": "https://schema.org", "@graph": graph },
    { "@context": "https://schema.org", "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/`, name: "Nomi·诺米", inLanguage: ["zh-CN", "en"], publisher: { "@id": `${origin}/#organization` } },
    { "@context": "https://schema.org", "@type": "SoftwareApplication", "@id": `${origin}/#software`, name: "Nomi·诺米", url: url("index", lang), description: meta("index", lang).description, image: ogImage.url, applicationCategory: "ProductivityApplication", operatingSystem: ["Windows", "macOS", "Linux"], softwareVersion: version, license: "https://opensource.org/license/mit", codeRepository: "https://github.com/Cookieboty/nomi-ai", downloadUrl: url("download", lang), inLanguage: ["zh-CN", "en"], offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
  ].map((schema) => `  <script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>`).join("\n");
}

function seoBlock(page, lang) {
  const { title, description } = meta(page, lang);
  const other = lang === "en" ? "zh" : "en";
  return `  <!-- seo:start — generated by scripts/build-seo.mjs, do not edit by hand -->
  <link rel="canonical" href="${url(page, lang)}" />
  <link rel="alternate" hreflang="${hreflang[lang]}" href="${url(page, lang)}" />
  <link rel="alternate" hreflang="${hreflang[other]}" href="${url(page, other)}" />
  <link rel="alternate" hreflang="x-default" href="${url(page, "zh")}" />
  <meta name="robots" content="index,follow,max-image-preview:large" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escape(title)}" />
  <meta property="og:description" content="${escape(description)}" />
  <meta property="og:url" content="${url(page, lang)}" />
  <meta property="og:site_name" content="Nomi·诺米" />
  <meta property="og:locale" content="${ogLocale[lang]}" />
  <meta property="og:locale:alternate" content="${ogLocale[other]}" />
  <meta property="og:image" content="${ogImage.url}" />
  <meta property="og:image:alt" content="Nomi·诺米" />
  <meta property="og:image:width" content="${ogImage.width}" />
  <meta property="og:image:height" content="${ogImage.height}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escape(title)}" />
  <meta name="twitter:description" content="${escape(description)}" />
  <meta name="twitter:image" content="${ogImage.url}" />
  <meta name="twitter:image:alt" content="Nomi·诺米" />
${schemas(page, lang)}
  <!-- seo:end -->
`;
}

/** Rebuilds the 中 / EN toggle as links to the same page in each language (works on the old <button> form too). */
function languageLinks(html, page, lang) {
  return html.replace(/(<div class="lang-toggle"[^>]*>)[\s\S]*?(\n?[ \t]*<\/div>)/, (_, open, close) => {
    const indent = close.match(/\n([ \t]*)/)?.[1] ?? "";
    const links = langs.map((target) => {
      const href = target === lang ? `${page}.html` : lang === "en" ? `../${page}.html` : `en/${page}.html`;
      const active = target === lang ? ' class="lang-btn is-active" aria-current="true"' : ' class="lang-btn"';
      return `${indent}  <a${active} data-lang="${target}" href="${href}" hreflang="${hreflang[target]}" lang="${hreflang[target]}">${target === "en" ? "EN" : "中"}</a>`;
    });
    return `${open}\n${links.join("\n")}${close}`;
  });
}

/** Strips everything an earlier run injected, so the Chinese page is back to its hand-written form. */
function clean(html) {
  return html
    .replace(/[ \t]*<!-- seo:start[\s\S]*?<!-- seo:end -->\n?/g, "")
    .replace(/[ \t]*<link rel="canonical"[\s\S]*?(?=<meta name="theme-color")/, "") // first-run output, before markers
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
    `${indent}<link rel="icon" href="assets/brand/favicon.ico" sizes="48x48" />\n${line}\n${indent}<link rel="apple-touch-icon" href="assets/brand/favicon-96.png" />`);
  html = languageLinks(html, page, lang);
  if (lang === "en") html = html.replace(/(["'( ])(assets\/|css\/|js\/)/g, "$1../$2");
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

const outputs = {};
for (const page of pages) {
  const source = clean(readFileSync(join(root, `${page}.html`), "utf8").replace(/\u0000/g, ""));
  for (const lang of langs) outputs[file(page, lang)] = build(source, page, lang);
}

let changed = [];
for (const [name, html] of Object.entries(outputs)) {
  const path = join(root, name);
  if (existsSync(path) && readFileSync(path, "utf8") === html) continue;
  changed.push(name);
  if (!checkOnly) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  }
}

// lastmod is read after the pages are written, so a page this run changed counts as modified today.
const alternates = (page) => [...langs.map((l) => [hreflang[l], url(page, l)]), ["x-default", url(page, "zh")]]
  .map(([code, href]) => `    <xhtml:link rel="alternate" hreflang="${code}" href="${href}" />`).join("\n");
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${pages.flatMap((page) => {
  const date = lastmod(`${page}.html`, `en/${page}.html`);
  return langs.map((lang) => `  <url>\n    <loc>${url(page, lang)}</loc>\n    <lastmod>${date}</lastmod>\n${alternates(page)}\n  </url>`);
}).join("\n")}
</urlset>
`;
const sitemapPath = join(root, "sitemap.xml");
if (!existsSync(sitemapPath) || readFileSync(sitemapPath, "utf8") !== sitemap) {
  changed.push("sitemap.xml");
  if (!checkOnly) writeFileSync(sitemapPath, sitemap);
}

if (!checkOnly && process.argv.includes("--icons")) {
  // favicon-96.png is the brand mark (nomi-mark.svg) rendered at 96 px; the .ico is made from it.
  execFileSync("sips", ["-s", "format", "ico", "-z", "48", "48", "assets/brand/favicon-96.png", "--out", "assets/brand/favicon.ico"], { cwd: root, stdio: "ignore" });
}

if (checkOnly && changed.length) {
  console.error(`Out of date, run node scripts/build-seo.mjs: ${changed.join(", ")}`);
  process.exit(1);
}
console.log(changed.length ? `Updated: ${changed.join(", ")}` : "Up to date");
