# CI 触发规则 / CI triggers

Workflow：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)。

## 触发矩阵

| 事件                            | quality                       | changeset status | e2e-headless / e2e-headed / dev-smoke | build-electron（打包）          |
| ------------------------------- | ----------------------------- | ---------------- | ------------------------------------- | ------------------------------- |
| push `main`                     | Ubuntu / macOS / Windows      | —                | ✓                                     | 三平台，未签名 artifact         |
| push tag `v*`                   | Ubuntu / macOS / Windows      | —                | ✓                                     | 三平台，签名门控 + 发布 Release |
| push `feat/**` 等其它分支       | 不触发                        | 不触发           | 不触发                                | 不触发                          |
| PR → `main` / `feat/**`         | **仅 Ubuntu**                 | ✓                | —                                     | —                               |
| PR 带 `ci:full` 标签            | Ubuntu / macOS / Windows      | ✓                | ✓                                     | 三平台，未签名 artifact         |
| `merge_group`（启用合并队列时） | Ubuntu / macOS / Windows      | —                | ✓                                     | 三平台，未签名 artifact         |
| `workflow_dispatch`             | 三平台（`package_only` 跳过） | —                | ✓（`package_only` 跳过）              | 按 `platforms` 过滤             |

- quality = 许可检查、check:i18n、check:frontend、typecheck / lint / 单元测试 / 构建、根脚本测试。
- PR 的触发类型：`opened`、`synchronize`、`reopened`、`ready_for_review`、`labeled`。给 PR 加 `ci:full` 会立刻跑完整矩阵，之后每次推送也一直跑完整矩阵，直到去掉标签。加其它标签不跑任何 job。
- PR 只改 `docs/**`、`*.md`、`.changeset/**` 时整个 workflow 不跑（`paths-ignore`，只对 PR 生效；push main / tag 总是完整 CI）。
- 并发：同一 PR 的新 run 会取消旧 run；main、tag、合并队列和手动触发的 run 不会被取消。

## 什么时候加 `ci:full`

改动涉及 Windows / macOS 平台差异、Electron 主进程、窗口 / 看板娘、打包脚本，或想在合并前看到 headed e2e 和安装包时。合并进 `main` 后 push 也会跑一次完整 CI。

## 分支保护

目前 `main` 没有分支保护 / 必需检查（`gh api repos/Cookieboty/nomi-ai/branches/main/protection` → 404，也没有 ruleset），所以 `paths-ignore` 跳过整个 workflow 不会卡住合并。以后若给 `main` 加必需检查，要把 `paths-ignore` 改成 paths-filter job（让必需的 job 以 success / skipped 结束），否则只改文档的 PR 会一直等待必需检查。

---

**English summary:** pushes to `main` and `v*` tags run the full CI and packaging (tags sign and publish). Pushes to `feat/**` no longer trigger CI. PRs into `main` or `feat/**` run only the fast Linux `quality` job plus `changeset status`. Add the `ci:full` label (or use the merge queue / manual dispatch) to run the Windows / macOS matrix, headless and headed e2e, dev-smoke and installer builds. Docs-only and changeset-only PRs skip CI. Newer PR runs cancel older ones; main and tag runs are never cancelled.
