# CI 触发规则 / CI triggers

| Workflow                                                                   | 内容                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`ci.yml`](../../.github/workflows/ci.yml)                                 | 视图、共享包与仓库脚本：quality（许可、i18n、角色名扫描、typecheck / lint / 测试 / 构建）、changeset status  |
| [`desktop-go.yml`](../../.github/workflows/desktop-go.yml)                 | Go 内核：三平台 `go vet` / `go test -race`、契约漂移检查、构建与体积、macOS 透明窗口验证、内存实测（只报告） |
| [`desktop-go-package.yml`](../../.github/workflows/desktop-go-package.yml) | 安装包：三平台打包 + 安装 / 启动 / 签名验证 + `latest-go.json`；tag 上 draft → 自动发布 Release              |

## `ci.yml` 触发矩阵

| 事件                            | quality                  | changeset status |
| ------------------------------- | ------------------------ | ---------------- |
| push `main`                     | Ubuntu / macOS / Windows | —                |
| push `feat/**` 等其它分支       | 不触发                   | 不触发           |
| PR → `main` / `feat/**`         | **仅 Ubuntu**            | ✓                |
| PR 带 `ci:full` 标签            | Ubuntu / macOS / Windows | ✓                |
| `merge_group`（启用合并队列时） | Ubuntu / macOS / Windows | —                |
| `workflow_dispatch`             | Ubuntu / macOS / Windows | —                |

- quality = 许可检查、check:i18n、check:character-leak、角色包契约、check:frontend、typecheck / lint / 单元测试 / 构建、根脚本测试。
- PR 的触发类型：`opened`、`synchronize`、`reopened`、`ready_for_review`、`labeled`。给 PR 加 `ci:full` 会立刻跑完整矩阵，之后每次推送也一直跑完整矩阵，直到去掉标签。加其它标签不跑任何 job。
- PR 只改 `docs/**`、`*.md`、`.changeset/**` 时整个 workflow 不跑（`paths-ignore`，只对 PR 生效）。
- 并发：同一 PR 的新 run 会取消旧 run；main、合并队列和手动触发的 run 不会被取消。

## Go workflows

| Workflow                 | 触发                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| `desktop-go.yml`         | push `main`；PR → `main`（改到 `apps/desktop-go`、`packages`、契约生成脚本时） |
| `desktop-go-package.yml` | PR 带 `ci:full`；push tag `v*`（≥ v2.0.5，不重跑测试）；手动                   |

`desktop-go.yml` 分成两个并行 job：`test`（契约漂移检查、`go vet` / `go test -race`）与 `build`（构建、体积、macOS 透明窗口验证、内存实测；内存实测只报告）。PR 上新提交取消旧 run。

## 什么时候加 `ci:full`

改动涉及 Windows / macOS 平台差异、窗口 / 桌面角色、打包脚本，或想在合并前看到三平台 quality 和安装包时。合并进 `main` 后 push 也会跑一次。

## 分支保护

目前 `main` 没有分支保护 / 必需检查（`gh api repos/Cookieboty/nomi-ai/branches/main/protection` → 404，也没有 ruleset），所以 `paths-ignore` 跳过整个 workflow 不会卡住合并。以后若给 `main` 加必需检查，要把 `paths-ignore` 改成 paths-filter job（让必需的 job 以 success / skipped 结束），否则只改文档的 PR 会一直等待必需检查。

## 重试规则 / Retries

只重试与代码无关的偶发失败，并且**重试过的一定看得见**；两次都失败才算失败。

| 地方                                       | 规则                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Go 测试（`apps/desktop-go/ci/go-test.sh`） | 失败的包只重跑一次。重试通过：`::warning::` + job summary 列出测试名；编译 / vet 失败不重试 |
| 上传产物                                   | 失败等 30 秒再传一次（GitHub 侧的 `ENOTFOUND` 等）                                          |

重试后才通过的测试仍要修：看 job summary 的 ⚠️ 段落。quality 的 turbo 用 `--continue=dependencies-successful`：一个包失败不停掉其它包，一轮报出全部失败。发版前本地先跑 `pnpm release:check`（见 [RELEASE.md](../RELEASE.md)）。

---

**English summary:** `ci.yml` checks the views, shared packages and repo scripts; `desktop-go.yml` runs the Go tests and builds; `desktop-go-package.yml` builds and verifies installers and publishes Releases on `v*` tags. Pushes to `main` run the full matrix. PRs into `main` or `feat/**` run only the Linux `quality` job plus `changeset status`; add the `ci:full` label for the Windows / macOS matrix and installer builds. Docs-only and changeset-only PRs skip `ci.yml`. Newer PR runs cancel older ones; main runs are never cancelled.
