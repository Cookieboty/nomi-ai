# Nomi·诺米 官方营销网站

静态多页站点，面向 [Cookieboty/nomi-ai](https://github.com/Cookieboty/nomi-ai)。品牌规范来自仓库 `docs/BRAND.md`。

部署目标：`gh-pages` 分支 → GitHub Pages。下载页已接 v1.0.1 Linux / Windows / macOS 官方 Release 资源。

## 本地预览

```bash
cd /path/to/nomi-website
python3 -m http.server 8080
# 浏览器打开 http://127.0.0.1:8080/
```

相对路径已写好，无需构建步骤。Nunito 标题字体从 Google Fonts 加载；其余资源在 `assets/` 本地。

## 目录结构

```
nomi-website/
├── index.html          # 首页
├── features.html       # 完整功能
├── download.html       # 下载与快速开始
├── docs.html           # 文档枢纽（外链到 GitHub docs）
├── privacy.html        # 隐私摘要
├── css/styles.css
├── js/
│   ├── i18n.js         # 中英文字典 + language toggle
│   └── main.js         # 移动端导航
├── assets/
│   ├── brand/          # wordmark / mark / nomi-brand-avatar.png
│   └── screenshots/    # mascot / chat / command-palette / settings-*
└── README.md
```

## 国际化（i18n）

- 全站中英双语；页眉 pill 切换 **中文 | EN**。
- 实现：`data-i18n` / `data-i18n-alt` / `data-i18n-aria-label` + `js/i18n.js` 字典。
- 选择写入 `localStorage`（键 `nomi-lang`）；默认中文，若浏览器语言为 `en*` 则默认英文。
- 切换不刷新页面。

## 品牌素材

- 主视觉立绘：`assets/brand/nomi-brand-avatar.png`（首页 hero 与品牌肖像位）。
- 旧方头像 `nomi-avatar.png` 保留在仓库中，首页已不再使用。

## 部署到 GitHub Pages

### 方案 A：放到 `nomi-ai` 仓库的 `/docs`

1. 将本目录内容复制到 `nomi-ai` 仓库的 `docs/website/`（注意不要覆盖现有 `docs/*.md`）。
2. 若坚持用 GitHub 的「Deploy from `/docs` folder」，需先把现有 Markdown 迁走。
3. 站点将出现在 `https://<user>.github.io/nomi-ai/`。

**注意：** 当前 `nomi-ai` 的 `docs/` 已有产品文档。不要未经沟通直接覆盖。推荐方案 B。

### 方案 B：`gh-pages` 分支（推荐）

```bash
cd nomi-website
git init
git checkout -b gh-pages
git add .
git commit -m "Publish Nomi marketing site"
git remote add origin https://github.com/Cookieboty/nomi-ai.git
git push -u origin gh-pages
```

然后在仓库 Settings → Pages → Source: 选择 `gh-pages` 分支、根目录 `/`。

也可作为独立仓库开启 Pages。

### 自定义域名（可选）

在站点根目录加 `CNAME` 文件，内容为一行域名；并在 DNS 按 GitHub Pages 文档配置。

## 占位与约定

- 下载页：Linux / Windows / macOS 链到 Release v1.0.1 真实资源（Actions 产物）。
- 文档页只做枢纽，正文链到 GitHub `docs/`。
- 未编造星标数或用户评价。
- 橙色按钮上的文字使用墨色，不用白色。

## 品牌色速查

| Token | Hex |
|-------|-----|
| Nomi 橙 | `#FB9466` |
| 悬停 | `#F17F4E` |
| 奶油底 | `#FCEFE1` |
| 墨色文字 | `#33291F` |
| 暖灰 | `#6E5F4E` |
