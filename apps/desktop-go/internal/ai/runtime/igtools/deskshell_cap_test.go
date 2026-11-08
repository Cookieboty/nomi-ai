//go:build !windows

package igtools

import (
	"strings"
	"testing"
)

// 输出超过上限：保留开头与结尾（测试失败、报错常在最后），中间省略
func TestRunShellCommandKeepsTail(t *testing.T) {
	r := RunShellCommand(`echo BEGIN; i=0; while [ $i -lt 2000 ]; do echo "line $i ................................"; i=$((i+1)); done; echo "FAILED: TestFoo"`,
		RunShellOpts{TimeoutMs: 20_000, Cap: 2_000})
	if !r.Truncated || !strings.HasPrefix(r.Stdout, "BEGIN") || !strings.Contains(r.Stdout, "FAILED: TestFoo") || !strings.Contains(r.Stdout, "中间省略") {
		t.Fatalf("truncated=%v stdout=%q", r.Truncated, r.Stdout[:min(len(r.Stdout), 300)])
	}
	if len([]rune(r.Stdout)) > 2_100 {
		t.Fatalf("over the cap: %d", len([]rune(r.Stdout)))
	}
}
