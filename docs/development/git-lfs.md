# Git LFS（大资源）

本仓库用 [Git LFS](https://git-lfs.com/) 跟踪体积较大的 Rive / 立绘源文件，**不重写历史**（无 `filter-repo`、无 force-push）。

## 跟踪规则（见仓库根 `.gitattributes`）

| 模式                              | 说明                                       |
| --------------------------------- | ------------------------------------------ |
| `*.riv`                           | Rive 运行时模型（含 `characters/*/rive/`） |
| `*.rml`                           | Rive 源工程                                |
| `rive/**/*.png` / `rive/**/*.svg` | `rive/` 下参考立绘与母版 SVG               |

## 贡献者设置

```bash
# 一次性（系统级）
git lfs install

# 克隆本仓库（会按 pointer 拉取 LFS 对象）
git clone git@github.com:Cookieboty/nomi-ai.git
# 若已克隆但缺少大文件：
git lfs pull
```

CI 的 `actions/checkout` 需 `lfs: true`，否则打包/测试读到的是 pointer 文本而非二进制。

## 运行时与打包

- 开发 / 测试：直接读 `characters/nomi/rive/character.riv`（Vitest；Vite 经角色包插件提供）。
- 生产：`packages/renderer/dist` → electron-builder `extraResources` 的 `renderer/`（**不在 asar 内**），无需 `asarUnpack`。
- 切勿对 LFS 文件做「历史 rewrite」；新增大文件时先确认已被 `.gitattributes` 覆盖，再 `git add`。

## 本地把已跟踪大文件转为 pointer（维护者）

```bash
git lfs install
# 已写好 .gitattributes 后：
git lfs migrate import --no-rewrite --include="*.riv,*.rml,rive/**/*.png,rive/**/*.svg"
# 然后普通 push（不要 force）
```
