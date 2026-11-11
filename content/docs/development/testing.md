# 测试

| 层级     | 位置                                   | 运行                                  | 跑什么                                                                                                                                             |
| -------- | -------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 视图单测 | `packages/*/{src,tests}/**`            | `pnpm test`                           | 视图与共享包（Vitest）；跑完各包再跑脚本测试                                                                                                       |
| 脚本测试 | `scripts/__tests__`                    | `pnpm test:root`                      | 仓库级规则：changelog / changeset、发布与签名、turbo 输入、品牌名与 appId、角色名扫描、语义事件名、体积预算                                        |
| Go 测试  | `apps/desktop-go/**/*_test.go`         | `cd apps/desktop-go && go test ./...` | Go 内核与 Wails 壳；macOS 加 `-tags private_mac_apis`，Linux 加 `-tags gtk3`                                                                       |
| 安装验证 | `apps/desktop-go/ci/verify-*.{sh,ps1}` | CI（`desktop-go-package.yml`）        | 三平台安装包：安装、启动、桌面角色窗口；Windows 另验应用内更新的静默覆盖安装；mac 打包后用真实 `-mac.zip` 跑一次原地替换（`TestVerifyMacAppReal`） |

2.2.0 起 Electron 版与 Node 内核已删除，跑在它们上面的无界面 E2E（`e2e/`）、真实应用 E2E（`e2e-headed/`）、
浏览器冒烟（`dev:web` / `smoke:web`）、真实 CLI 一致性测试（`e2e-cli/`）以及 Go 版与 TS 内核的 parity 比对一并去掉了。

## 视图单测里的异步：等「做完」，不等时间

视图（`packages/ai-chat/tests`）的用例不要用 `await waitFor(() => …)` / `findBy*` 等界面出结果：它们按时间轮询，
默认 1 秒就放弃，CI 机器一慢就翻车（2.1.2 的 `historySidebar` 在 Windows 上就是这样挂的）。改用
`tests/helpers/fakeApi.ts` 的 `await untilIdle()`：等假内核没有还没返回的调用、界面也更新完（按轮数判定，不设超时），
之后同步断言。界面里有延时发请求的（如本机历史挂载 120ms 后才读），用例开 `vi.useFakeTimers()`，`untilIdle`
每一轮直接执行已排上的定时器。存量用例还有很多 `waitFor`，改到哪个文件就顺手换掉。

视图不在 Nomi 窗口里时（测试、浏览器预览）`services/api.ts` 的 `hasTransport()` 为 false，契约调用以
`BRIDGE_MISSING` 失败；要假内核的用例用 `tests/helpers/fakeApi.ts`，或在 `@nomi-ai/ai-sdk-client` 的测试里用
`installSharedTransport(createFakeServer().connect())`。

## Go 测试

- 测试里通往仓库其它位置的路径用 `internal/repotest` 的 `RepoPath`（往上找 `pnpm-workspace.yaml`），不数 `..`；
  环境缺失（tzdata、node 等）用 `repotest.SkipOrFail`：本地跳过，CI（`CI=true`）里失败。
- 假模型在 `internal/mockllm`；编程助手的假 CLI 在仓库根目录 `scripts/mock-cli`（`NOMI_USE_MOCK_CLI=1` 时
  `cli.MockCliBin` 从当前目录往上找到它们，用来代替真实 CLI）。
- 等子进程 / 异步落盘里发生的事要按条件等（带说明的超时），不要数固定次数的轮询或断言墙钟耗时。
- CI 用 `apps/desktop-go/ci/go-test.sh`：先 `go vet`，再 `go test -race`；失败的包重跑一次，第二次通过记为不稳定
  （`::warning::` + job summary），两次都失败才算失败。

改了 `packages/contract` 要同步 Go 侧生成的契约：

```bash
pnpm --filter @nomi-ai/contract build
node scripts/go-contract/gen.mjs          # 写入；--check 只检查（CI 在 Linux 上跑）
```

`packages/i18n` 的词典改了要复制到 `apps/desktop-go/internal/core/i18n/locales`（`dict_test.go` 比对两份）。

## 角色名扫描

`pnpm check:character-leak`（`scripts/check-character-leak.mjs`，CI 的 quality 里跑）静态扫描源码、界面文案、
`packages/*/index.html` 与 `packages/*/public`、Go 版各平台打包模板、非官方角色包，指桌面角色的地方不得写死官方角色名
（规则在 `scripts/lib/characterLeak.mjs`），允许清单里每一项都要写理由且必须命中。

## 体积预算

```bash
pnpm build
node scripts/check-bundle-budget.mjs [--strict]   # 首屏 JS / CSS 体积预算（scripts/bundle-budgets.json）
```

体积预算按 `dist/index.html` 的入口 script + modulepreload + stylesheet 统计，并禁止语法高亮器出现在首屏 chunk。CI 里只报告（`::warning` 注解 + job summary，`continue-on-error`），不会变红；加 `--strict` 才失败。调高预算要在 PR 里写明原因。

## CI

什么事件跑哪些 job 见 [CI 触发规则](ci.md)。

- `ci.yml`：`quality`（普通 PR 只在 Ubuntu，带 `ci:full` 与 push `main` 时三平台）：许可、i18n、角色名扫描、角色包契约、
  前端规范、typecheck、lint、单元测试、构建、脚本测试；Ubuntu 上追加首屏体积预算报告（不阻塞）。PR 上另跑 `changeset status`。
- `desktop-go.yml`：三平台 `go vet` + `go test`，契约生成漂移检查，构建与体积、macOS 透明窗口验证、内存实测（只报告）。
- `desktop-go-package.yml`：安装包打包、安装验证、更新清单与 Release，见 [RELEASE.md](../RELEASE.md)。
