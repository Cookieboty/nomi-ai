# Testing

| Layer | Location | Command | Scope |
| --- | --- | --- | --- |
| View unit tests | `packages/*/{src,tests}/**` | `pnpm test` | Views and shared packages (Vitest); runs script tests after all packages finish |
| Script tests | `scripts/__tests__` | `pnpm test:root` | Repo-level rules: changelog/changeset, release and signing, turbo inputs, brand name and `appId`, character name scan, semantic event names, bundle budgets |
| Go tests | `apps/desktop-go/**/*_test.go` | `cd apps/desktop-go && go test ./...` | Go core and Wails shell; add `-tags private_mac_apis` on macOS and `-tags gtk3` on Linux |
| Installer verification | `apps/desktop-go/ci/verify-*.{sh,ps1}` | CI (`desktop-go-package.yml`) | Three-platform installers: install, launch, desktop character window; Windows also verifies silent in-app overwrite updates; macOS runs an in-place replacement check against the real `-mac.zip` after packaging (`TestVerifyMacAppReal`) |

As of 2.2.0, the Electron edition and Node core were removed, along with the headless E2E (`e2e/`), headed app E2E (`e2e-headed/`), browser smoke tests (`dev:web` / `smoke:web`), real CLI conformance tests (`e2e-cli/`), and Go vs. TS core parity comparisons that ran on top of them.

## Coverage

Per-package coverage is collected in CI (enabled automatically when the `CI` environment variable is set, avoiding the overhead when running a single file locally). Thresholds are configured in each package's `vitest.config.*` (renderer packages use `coverageConfig` from the root `vitest.base.ts`):

- Thresholds are set 2 to 3 points below the measured baseline at the time—they only catch coverage regressions, not routine code movement. Raising them is always fine; lowering them requires an explanation in the PR.
- Thresholds only make sense when running a full package: running a single test file yields very low coverage, so do not run single files locally with `CI=1`.

## Async in View Unit Tests: Wait for Completion, Not Timeouts

In view tests (`packages/ai-chat/tests`), do not use `await waitFor(() => ...)` or `findBy*` to wait for UI updates: they poll on wall-clock time and give up after 1 second by default, which flakes on slower CI runners (this is how `historySidebar` failed on Windows in 2.1.2). Instead, use `await untilIdle()` from `tests/helpers/fakeApi.ts`: it waits until the fake core has no pending calls and the UI has finished updating (settled by turn count rather than a timeout), then assert synchronously. For UI flows that schedule delayed requests (such as local history mounting after 120 ms), enable `vi.useFakeTimers()` in the test so `untilIdle` flushes scheduled timers on each pass. Existing test files still contain many `waitFor` calls—replace them as you touch those files.

Outside a Nomi window (tests, browser preview), `hasTransport()` in `services/api.ts` is false and contract calls fail with `BRIDGE_MISSING`. Tests needing a fake core use `tests/helpers/fakeApi.ts`, or `installSharedTransport(createFakeServer().connect())` in `@nomi-ai/ai-sdk-client` tests.

## Go Tests

- Paths to other parts of the repository in tests use `RepoPath` from `internal/repotest` (searches upward for `pnpm-workspace.yaml`) rather than counting `..`. Missing environment dependencies (`tzdata`, `node`, etc.) use `repotest.SkipOrFail`: skip locally, fail in CI (`CI=true`).
- Mock models live in `internal/mockllm`; mock CLIs for agents live in `scripts/mock-cli` at the repository root (when `NOMI_USE_MOCK_CLI=1`, `cli.MockCliBin` searches upward from the current directory to locate them in place of real CLIs).
- Waiting on subprocesses or asynchronous disk writes must wait on explicit conditions (with descriptive timeouts) rather than counting fixed polling iterations or asserting wall-clock elapsed time.
- CI runs `apps/desktop-go/ci/go-test.sh`: `go vet` first, then `go test -race`. Failing packages are retried once; passing on the second attempt is flagged as flaky (`::warning::` + job summary), while failing twice fails the job.

When modifying `packages/contract`, regenerate the Go contract artifacts:

```bash
pnpm --filter @nomi-ai/contract build
node scripts/go-contract/gen.mjs          # Write files; --check only checks (CI runs on Linux)
```

When modifying `packages/i18n` dictionaries, run `pnpm i18n:sync` to sync them to `apps/desktop-go/internal/core/i18n/locales` (`dict_test.go` compares both copies, and `pnpm check:i18n` checks for drift in CI).

## Character Name Leak Check

`pnpm check:character-leak` (`scripts/check-character-leak.mjs`, run in CI's `quality` job) statically scans source code, UI strings, `packages/*/index.html`, `packages/*/public`, Go platform packaging templates, and non-official character packs. Places referring to the desktop character must not hardcode the official character name (rules in `scripts/lib/characterLeak.mjs`); every entry in the allowlist must include a reason and match at least once.

## Bundle Budget

```bash
pnpm build
node scripts/check-bundle-budget.mjs [--strict]   # Initial JS / CSS bundle budgets (scripts/bundle-budgets.json)
```

Bundle budgets measure the entry script + `modulepreload` + stylesheet assets in `dist/index.html` and forbid syntax highlighters from appearing in initial chunks. In CI this is report-only (`::warning` annotations + job summary with `continue-on-error`) and does not fail the build; pass `--strict` to fail on violations. Raising a budget requires a reason in the PR.

## CI

See [CI Triggers](ci.md) for which events trigger which jobs.

- `ci.yml`: `quality` (Ubuntu only on standard PRs; all three platforms when labeled `ci:full` or on push to `main`): licenses, i18n, character name leak check, character pack contract, frontend standards, typecheck, lint, unit tests, build, and script tests; Ubuntu also appends the initial bundle budget report (non-blocking). PRs also run `changeset status`.
- `desktop-go.yml`: three-platform `go vet` + `go test`, contract generation drift check, build and binary size, macOS transparent window verification, and memory measurement (report-only).
- `desktop-go-package.yml`: installer packaging, installation verification, update manifests, and Releases; see [RELEASE.md](../RELEASE.md).
