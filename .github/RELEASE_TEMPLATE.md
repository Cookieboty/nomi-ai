# Release Notes · {{VERSION}}

> 发布流程：[docs/RELEASE.md](../docs/RELEASE.md)

## 摘要

- 版本：`{{VERSION}}`（通道：alpha / beta / stable —— 三选一）
- 日期：{{DATE}}
- Git 范围：`{{PREV_TAG}}...{{VERSION}}`

## 平台产物

| 平台              | 安装包                                                              | 大小 | SHA256 |
| ----------------- | ------------------------------------------------------------------- | ---- | ------ |
| macOS (x64/arm64) | `Nomi-{{VERSION}}.dmg`                                              |      |        |
| macOS 自动更新    | `Nomi-{{VERSION}}-mac.zip`（x64）· `Nomi-{{VERSION}}-arm64-mac.zip` |      |        |
| Windows (x64)     | `Nomi Setup {{VERSION}}.exe`                                        |      |        |
| Linux (x64)       | `Nomi-{{VERSION}}.AppImage`                                         |      |        |

## 变更

> 逐条从根目录 [CHANGELOG.md](../CHANGELOG.md) 的本版本条目复制，按分类：

### Added

-

### Changed

-

### Deprecated

-

### Removed

-

### Fixed

-

### Security

-

## 升级指南

- **从旧版本升级**：
  - 首次启动会自动执行 [migrate-config](../scripts/migrate-config.ts) / [migrate-history](../scripts/migrate-history.ts) / [migrate-user-profile](../scripts/migrate-user-profile.ts)；
  - 原文件保留为 `<原名>.legacy.json`，回滚只需删除 `userData/keys/` 与相关 session log；
- **SDK 消费方**：如引用 `@ig-live/ai-sdk` / `@ig-live/ai-runtime` / `@ig-live/ai-sdk-client`，遵循 fixed-group（同版本号）；参考 [.changeset/README.md](../.changeset/README.md)。

## 已知问题

-

## 验收清单（发版前 checklist）

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` 全绿
- [ ] `xvfb-run -a pnpm test:e2e:headed` 全绿
- [ ] `pnpm changeset status` 无未消费 changeset
- [ ] 三平台 CI matrix build 全绿（[ci.yml · build-electron](workflows/ci.yml)）
- [ ] 手工验收危险工具确认弹窗同意路径（确认弹窗 → 同意 → 文件写入成功）
- [ ] `pnpm changelog:check` 通过，根目录 `CHANGELOG.md` 已包含本版本
- [ ] GitHub Releases 安装包上传完成
- [ ] Release notes 中的 SHA256 与产物大小已填写

## 致谢

感谢参与 alpha 招募的 XX 名内部用户。
