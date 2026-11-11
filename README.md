# Nomi·诺米 官方网站

发布于 <https://withnomi.app>（`gh-pages` 分支根目录，`CNAME` = `withnomi.app`），纯静态站点；英文页与 SEO 标签由 `scripts/build-seo.mjs` 生成并提交，部署时无构建步骤。

- `index.html` — 首页（含下载区）
- `download.html` / `docs.html` / `changelog.html` / `privacy.html` — 下载、文档入口、更新日志、隐私（`features.html` 只跳回首页）
- `en/` — 独立英文静态页，供搜索引擎直接抓取；页头「中 / EN」是指向另一语言同一页的链接，不自动跳转
- `robots.txt`、`sitemap.xml` — 搜索爬虫入口；各页 `<head>` 里 `<!-- seo:start -->…<!-- seo:end -->` 之间的 canonical、hreflang、Open Graph、JSON-LD 都是生成的，不要手改
- `scripts/build-seo.mjs` — 按 `js/i18n.js` 的中英词典渲染中文页与 `en/` 英文页、`<head>` SEO 块和 sitemap（版本号读自 `download.html` 的下载链接）。改了中文页、词典或下载版本后，在站点根目录运行 `node scripts/build-seo.mjs`（可重复运行）；提交前 `node scripts/build-seo.mjs --check` 应通过。favicon 需要重做时加 `--icons`（仅 macOS）
- `css/site.css`、`js/site.js` — 样式（系统字体，无外部请求）与脚本（按系统预选下载、窄屏菜单、截图放大）
- `js/i18n.js` — 中英文词典，只给 `build-seo.mjs` 用（页面不加载）；zh 与 en 键必须一致
- `assets/` — 品牌、截图（`?v=` 参数随换图一起改）、OG 图 `assets/brand/og-image.png`（1200×630）
- 下载链接写死当前版本（发版后改 `download.html` / 首页里的版本号再跑 `build-seo.mjs`），页面加载时通过 GitHub API 自动指向最新 Release。
