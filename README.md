# Nomi·诺米 官方网站

发布于 <https://withnomi.app>（`gh-pages` 分支根目录，`CNAME` = `withnomi.app`），纯静态站点，无构建步骤。

- `index.html` — 首页（含下载区）
- `features.html` / `download.html` / `docs.html` / `privacy.html` — 功能、下载、文档、隐私
- `changelog.html` — 更新日志（新版本发布后在此追加）
- `css/`、`js/`、`assets/` — 样式、脚本（`i18n.js` 中英文词典，zh 与 en 键必须一致）、品牌与截图
- `assets/fonts/` — 自托管 Nunito 子集（无外部字体请求）
- 图片为 WebP（及 OG 用 JPG）；原始大图不放在站点中。
- 下载按钮默认指向 v1.0.1 资源，页面加载时通过 GitHub API 自动指向最新 Release（首页与下载页均生效）。
