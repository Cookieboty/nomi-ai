# CI Triggers

| Workflow | Scope |
| --- | --- |
| [`ci.yml`](../../.github/workflows/ci.yml) | Views, shared packages, and repo scripts: `quality` (licenses, i18n, character leak check, typecheck / lint / tests / build), `changeset status` |
| [`desktop-go.yml`](../../.github/workflows/desktop-go.yml) | Go core: three-platform `go vet` / `go test -race`, contract drift check, build and binary size, macOS transparent window verification, memory measurement (report-only) |
| [`desktop-go-package.yml`](../../.github/workflows/desktop-go-package.yml) | Installers: three-platform packaging + install / launch / signing verification + `latest-go.json`; drafts on `v*` tags -> auto-publishes Release |

## `ci.yml` Trigger Matrix

| Event | quality | changeset status |
| --- | --- | --- |
| push `main` | Ubuntu / macOS / Windows | — |
| push `feat/**` or other branches | Not triggered | Not triggered |
| PR -> `main` / `feat/**` | **Ubuntu only** | ✓ |
| PR with `ci:full` label | Ubuntu / macOS / Windows | ✓ |
| `merge_group` (when merge queue is enabled) | Ubuntu / macOS / Windows | — |
| `workflow_dispatch` | Ubuntu / macOS / Windows | — |

- `quality` = license check, `check:i18n`, `check:character-leak`, character pack contract, `check:frontend`, typecheck / lint / unit tests / build, and root script tests.
- PR trigger types: `opened`, `synchronize`, `reopened`, `ready_for_review`, `labeled`. Adding the `ci:full` label immediately triggers the full matrix and continues running the full matrix on subsequent pushes until the label is removed. Adding other labels triggers no jobs.
- PRs touching only `docs/**`, `*.md`, or `.changeset/**` skip the entire workflow (`paths-ignore`, applies to PRs only).
- Concurrency: a new run for the same PR cancels the previous run; runs on `main`, `merge_group`, and manual triggers are never cancelled.

## Go Workflows

| Workflow | Triggers |
| --- | --- |
| `desktop-go.yml` | push `main`; PR -> `main` (when changing `apps/desktop-go`, `packages`, `characters`, contract generation scripts, or `scripts/mock-cli`) |
| `desktop-go-package.yml` | PR with `ci:full`; push tag `v*` (>= v2.0.5, without re-running tests); manual dispatch |

`desktop-go.yml` splits into two parallel jobs: `test` (contract drift check, `go vet` / `go test -race`) and `build` (build, binary size, macOS transparent window verification, and report-only memory measurement). New commits on a PR cancel previous runs.

## When to Add `ci:full`

Add it when changes affect Windows/macOS platform differences, windows/desktop character behavior, or packaging scripts, or when you want three-platform `quality` and installer results before merging. Merging into `main` also runs the full matrix on push.

## Branch Protection

`main` currently has no branch protection or required checks (`gh api repos/Cookieboty/nomi-ai/branches/main/protection` -> 404, and no rulesets), so skipping the entire workflow via `paths-ignore` does not block merges. If required checks are added to `main` later, replace `paths-ignore` with a `paths-filter` job (so required jobs finish as `success` or `skipped`); otherwise docs-only PRs will wait indefinitely on required checks.

## Retries

Only transient failures unrelated to code are retried, and **retries are always made visible**; a check fails only if both attempts fail.

| Location | Rule |
| --- | --- |
| Go tests (`apps/desktop-go/ci/go-test.sh`) | Failing packages are retried once. Passing on retry emits `::warning::` and lists the test name in the job summary; compile / `vet` failures are not retried |
| Artifact uploads | Retried once after waiting 30 seconds on failure (transient GitHub errors such as `ENOTFOUND`) |

Tests that pass only on retry still need fixing: check the ⚠️ section in the job summary. `quality` invokes Turbo with `--continue=dependencies-successful` so a failure in one package does not abort other packages, reporting all failures in a single run. Before releasing, run `pnpm release:check` locally (see [RELEASE.md](../RELEASE.md)).

---

**Summary:** `ci.yml` checks the views, shared packages, and repo scripts; `desktop-go.yml` runs the Go tests and builds; `desktop-go-package.yml` builds and verifies installers and publishes Releases on `v*` tags. Pushes to `main` run the full matrix. PRs into `main` or `feat/**` run only the Linux `quality` job plus `changeset status`; add the `ci:full` label for the Windows / macOS matrix and installer builds. Docs-only and changeset-only PRs skip `ci.yml`. Newer PR runs cancel older ones; `main` runs are never cancelled.
