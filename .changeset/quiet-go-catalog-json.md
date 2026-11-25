---
---

fix(cli-catalog): `gen:go` 生成 Go 内核清单时按仓库 prettier 规则格式化，并与清单核对一次

- 生成 `apps/desktop-go/internal/cliplugins/catalog/catalog.json` 后先用仓库根 `.prettierrc` 格式化（短数组压成一行），输出与提交的格式逐字一致，不用再手工重排；写完再单独跑一次一致检查
- 单文件跑不满整包覆盖率阈值，生成时关掉覆盖率，`gen:go` 在全部检查通过后退出码为 0
- 重新生成包含各底座 `branding.modelBrand` 的 `catalog.json`（只新增 7 处 `branding`），与清单同步
