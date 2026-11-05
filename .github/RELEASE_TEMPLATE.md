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

- **从旧版本升级**：应用内「重启更新」即可；从 Electron 版（≤ 2.0.4）升级时，首次启动会把旧数据复制过来（不改、不删原目录）。

## 已知问题

-

## 验收清单（发版前 checklist）

- [ ] `pnpm release:check` 全绿（typecheck / lint / 单元测试 / 契约漂移 / go vet）
- [ ] `pnpm changeset status` 无未消费 changeset
- [ ] `main` 上 [CI](workflows/ci.yml) 与 [desktop-go](workflows/desktop-go.yml) 全绿；tag 后 [desktop-go-package](workflows/desktop-go-package.yml) 三平台打包与安装验证全绿
- [ ] 手工验收危险工具确认弹窗同意路径（确认弹窗 → 同意 → 文件写入成功）
- [ ] `pnpm changelog:check` 通过，根目录 `CHANGELOG.md` 已包含本版本
- [ ] GitHub Releases 安装包上传完成
- [ ] Release notes 中的 SHA256 与产物大小已填写

## 致谢

感谢参与 alpha 招募的 XX 名内部用户。
