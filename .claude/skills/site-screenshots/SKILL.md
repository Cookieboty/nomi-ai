---
name: site-screenshots
description: 重拍官网 / README 用的应用截图（演示数据、隔离环境、2 倍像素，导出 640 / 1280 / 2560 三档 WebP）。发新版本、界面改版、或用户说「截图太旧」「重新截图」「更新官网配图」时使用。
---

# 官网截图

> **2.2.0 起暂时不可用**：脚本靠 `pnpm dev:web`（Node 内核 + 浏览器里的视图）出图，Node 内核已随 Electron 版删除。
> 要重拍得先把 `run.mjs` 改成驱动 Go 版（`apps/desktop-go`，可借 `NOMI_POC_CTL` 控制口与 `NOMI_DEV_VIEWS`）；改好之前别用这个技能，
> 直接告诉用户需要先移植。

一条命令从零重拍：`pnpm screenshots:site`。脚本在 `scripts/site-screenshots/`：

| 文件          | 作用                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `run.mjs`     | 隔离环境、启动模拟模型与 `dev:web`、逐个场景截图、隐私检查、导出 WebP                      |
| `scenes.mjs`  | 场景清单（`SCENES`）与操作函数（`createHelpers`）；`--explore` 的页面结构导出               |
| `mock-llm.mjs`| OpenAI 兼容的模拟模型，按关键词返回写好的演示回复（「演示 DeepSeek」供应商）               |

## 步骤

1. 先构建：`pnpm build`（与 `pnpm dev:web` 相同的前提；改过内核源码要重新构建）。
2. 拍全部：`pnpm screenshots:site`，输出到 `.site-shots/`（已忽略）。
   - 只拍几张：`pnpm screenshots:site -- --only chat,tasks`（数据准备场景照跑）。
   - 指定目录 / 保留临时数据排查：`-- --out <dir> --keep`。
3. 逐张看一遍（尤其新加的场景），再拷到官网：`gh-pages` 分支的 `assets/screenshots/`。
   每张有 `<name>-640.webp`、`<name>.webp`（1280）、`<name>-2x.webp`（2560）；页面 `srcset` 写三档，例如
   `srcset="assets/screenshots/chat-640.webp 640w, assets/screenshots/chat.webp 1280w, assets/screenshots/chat-2x.webp 2560w"`。
   官网改了图片要把 `?v=` 版本参数一起改，避免缓存旧图。

## 隐私（不能破）

- 脚本把 `HOME` 换成临时目录、PATH 里在真实 HOME 下的目录换成符号链接、Mock CLI 拷进临时 HOME（`NOMI_MOCK_CLI_DIR`）。
  否则工作台会列出本机 `~/.claude` / `~/.codex` 的真实会话，用量页会导入真实用量，设置页会显示 `/Users/<你>/…` 路径。
- 每张截图前检查页面文字（含输入框与 title），出现本机用户名或真实 HOME 就不保存、该场景记为失败。**不要为了通过检查而放宽它**，
  去找泄露来源并在隔离环境里堵上。
- 编程助手一律用 Mock CLI（`NOMI_USE_MOCK_CLI=1`），模型一律用 `mock-llm.mjs`，不调用任何真实服务、不花额度。

## 新增 / 修改场景

- 先跑 `pnpm screenshots:site -- --explore`：把每个设置栏、入口页和几个交互状态的无障碍结构（`.txt`）与截图写到
  `.site-shots/explore/`，照着里面的名称写选择器。
- 选择器只用无障碍名称（`getByRole(..., { name })`）；界面文案改了，场景里跟着改。
- 需要数据的画面，在前面加 `seed: true` 的场景造数据（seed 只造数据不出图，`--only` 时也会跑）。
- 场景名与官网 `assets/screenshots/` 的文件名一致，导出后直接覆盖；新名字要同时在官网页面里引用。
- 模拟模型的回复按关键词匹配（`mock-llm.mjs` 的 `SCRIPTS`）：场景里发的话要能命中，截图内容才稳定。

## 已知限制（dev:web 与 Electron 的差异）

- 素材库缩略图用 Electron 的 `chat-asset://` 协议，浏览器里没有：`h.inlineChatAssets()` 截图前把它换成 data URL。
- 系统对话框（选目录 / 选文件）在无界面宿主里用预设答案（`run.mjs` 里的 `ports.dialogs`）：知识库加入演示文档，附件用演示图片。
- 桌面角色（`mascot`）拍的是 renderer 页面的透明背景，没有真实的透明窗口与桌面。
- 只覆盖 Node 内核；Go 版界面相同（共用视图），不需要另拍。
