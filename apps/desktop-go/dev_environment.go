package main

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
)

// 必须在读取进程环境、初始化账号与 CLI 服务之前执行；仅开发构建生效。
// 从正式版启动的 CLI 可能把 CODEX_HOME 等指向生产托管账号，开发版需使用自己的新目录。
func isolateDevelopmentCLIEnvironment() {
	if !hostports.Development {
		return
	}
	roots := hostports.ProductionDataRoots()
	for _, id := range builtin.IDs {
		impl := builtin.Impl(id)
		if impl == nil || impl.Accounts == nil || impl.Accounts.HomeEnv == "" {
			continue
		}
		key := impl.Accounts.HomeEnv
		value := os.Getenv(key)
		if strings.TrimSpace(value) == "" {
			continue
		}
		home, _ := os.UserHomeDir()
		value = shared.CliHome(key, "", map[string]string{key: value}, home)
		for _, root := range roots {
			rel, err := filepath.Rel(canonicalEnvPath(root), canonicalEnvPath(value))
			if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
				_ = os.Setenv(key, filepath.Join(hostports.DefaultPaths().UserData(), "cli-inherited", id))
				// 生产账号的路由凭据也不能被开发网关自动发现。
				for _, name := range impl.Accounts.Strip {
					if name != key {
						_ = os.Unsetenv(name)
					}
				}
				break
			}
		}
	}
}

// 解析已有祖先的符号链接，覆盖 macOS /var → /private/var 和尚未创建的 CLI 子目录。
func canonicalEnvPath(value string) string {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return filepath.Clean(value)
	}
	parent, suffix := absolute, ""
	for {
		if resolved, err := filepath.EvalSymlinks(parent); err == nil {
			return filepath.Join(resolved, suffix)
		}
		next := filepath.Dir(parent)
		if next == parent {
			return absolute
		}
		suffix = filepath.Join(filepath.Base(parent), suffix)
		parent = next
	}
}
