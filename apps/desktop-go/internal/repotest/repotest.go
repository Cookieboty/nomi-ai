// Package repotest：测试里拼仓库内路径、按环境跳过的公共约定。
//   - CI 中不允许 Skip：环境缺失（tzdata、node 等）直接失败。
package repotest

import (
	"os"
	"path/filepath"
	"testing"
)

// RepoRoot 返回仓库根目录：从当前目录（go test 时是包目录）往上找 pnpm-workspace.yaml。
// 测试里通往 packages、characters 等的路径都从这里拼，不数 ".."：目录挪了也不会悄悄指错。
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
			panic("repotest: pnpm-workspace.yaml not found above " + wd)
		}
	}
}

// RepoPath 返回仓库根目录下的路径，如 RepoPath("characters/nomi")
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
