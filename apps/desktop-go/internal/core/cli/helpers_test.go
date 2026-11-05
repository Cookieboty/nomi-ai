package cli

// 测试辅助（原在已删除的 parity 测试里）

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/repotest"
	_ "modernc.org/sqlite"
)

func findNode(t *testing.T) string {
	n, err := exec.LookPath("node")
	if err != nil {
		repotest.SkipOrFail(t, "node not on PATH")
	}
	if r, err := filepath.EvalSymlinks(n); err == nil {
		n = r
	}
	return n
}
