package harness

// 测试辅助（原在已删除的 parity 测试里）

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/repotest"
)

type nopLogger struct{}

func (nopLogger) Info(string, any) {}

func (nopLogger) Warn(string, any) {}

type nopPorts struct{}

func (nopPorts) PickDirectory(string, bool, string) *string { return nil }

func (nopPorts) AnyFocused() bool { return false }

func repoRoot(*testing.T) string { return repotest.RepoRoot() }
