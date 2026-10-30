// Package paritytest：golden 测试的公共约定。
//   - NOMI_LIVE_GOLDENS：CI 在每个平台先用 Node 录制器现场录制（scripts/parity/*.mjs，NOMI_GOLDEN_DIR），
//     Go 测试比对本平台的现场录制，而不是跳过与 Linux golden 不同的平台相关用例。
//   - CI 中不允许 Skip：环境缺失（tzdata、node、TS 源码树）直接失败。
package paritytest

import (
	"os"
	"path/filepath"
	"testing"
)

// Golden 返回 golden 文件路径：设置了 NOMI_LIVE_GOLDENS 时用现场录制（缺失即失败），否则用提交的 committed。
// live=true 表示比对的是本平台的 Node 录制。
func Golden(t testing.TB, name, committed string) (path string, live bool) {
	t.Helper()
	if dir := os.Getenv("NOMI_LIVE_GOLDENS"); dir != "" {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("NOMI_LIVE_GOLDENS set but %s missing: %v", p, err)
		}
		return p, true
	}
	return committed, false
}

// RepoRoot 返回仓库根目录：从当前目录（go test 时是包目录）往上找 pnpm-workspace.yaml。
// 测试里通往 TS 源码、scripts/parity、characters 等的路径都从这里拼，不数 ".."：目录挪了也不会悄悄指错。
func RepoRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	for d := wd; ; d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, "pnpm-workspace.yaml")); err == nil {
			return d
		}
		if filepath.Dir(d) == d {
			panic("paritytest: pnpm-workspace.yaml not found above " + wd)
		}
	}
}

// RepoPath 返回仓库根目录下的路径，如 RepoPath("scripts/parity/b5-chat-scenarios.json")
func RepoPath(elem ...string) string {
	return filepath.Join(append([]string{RepoRoot()}, elem...)...)
}

// SkipOrFail：本地缺环境时跳过；CI（CI=true）中失败
func SkipOrFail(t testing.TB, args ...any) {
	t.Helper()
	if os.Getenv("CI") != "" {
		t.Fatal(append([]any{"required in CI:"}, args...)...)
	}
	t.Skip(args...)
}
