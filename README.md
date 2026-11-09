# Nomi·诺米 官方网站

发布于 <https://withnomi.app>（`gh-pages` 分支根目录，`CNAME` = `withnomi.app`），纯静态站点；英文页与 SEO 标签由 `scripts/build-seo.mjs` 生成并提交，部署时无构建步骤。

- `index.html` — 首页（含下载区）
- `features.html` / `download.html` / `docs.html` / `privacy.html` — 功能、下载、文档、隐私
- `changelog.html` — 更新日志（新版本发布后在此追加）
- `en/` — 独立英文静态页，供搜索引擎直接抓取；页头「中 / EN」是指向另一语言同一页的链接，不自动跳转，浏览器语言不同时右下角提示可切换
- `robots.txt`、`sitemap.xml` — 搜索爬虫入口；各页 `<head>` 里 `<!-- seo:start -->…<!-- seo:end -->` 之间的 canonical、hreflang、Open Graph、JSON-LD 都是生成的，不要手改
- `scripts/build-seo.mjs` — 按 `js/i18n.js` 的中英词典渲染中文页与 `en/` 英文页、`<head>` SEO 块和 sitemap（版本号读自 `download.html` 的下载链接）。改了中文页、词典或下载版本后，在站点根目录运行 `node scripts/build-seo.mjs`（可重复运行）；提交前 `node scripts/build-seo.mjs --check` 应通过。favicon 需要重做时加 `--icons`（仅 macOS）
- `css/`、`js/`、`assets/` — 样式、脚本（`i18n.js` 中英文词典，zh 与 en 键必须一致）、品牌与截图
- `assets/fonts/` — 自托管 Nunito 子集（无外部字体请求）
- 图片为 WebP（及 OG 用 JPG）；原始大图不放在站点中。
- 下载按钮默认指向 v1.0.3 资源，页面加载时通过 GitHub API 自动指向最新 Release（首页与下载页均生效）。
