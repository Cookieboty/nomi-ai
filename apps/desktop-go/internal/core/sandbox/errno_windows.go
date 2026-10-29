//go:build windows

package sandbox

import (
	"errors"
	"os"
	"strings"
)

// Windows 环境变量名大小写不敏感（process.env 同）
func lookupEnv(k string) (string, bool) {
	for _, kv := range os.Environ() {
		if i := strings.Index(kv[1:], "="); i >= 0 && strings.EqualFold(kv[:i+1], k) {
			return kv[i+2:], true
		}
	}
	return "", false
}

func signaled(*os.ProcessState) bool { return false }

// libuv 在 Windows 上的 UV_ENOENT / UV_EACCES
func errnoName(err error) string {
	if errors.Is(err, os.ErrPermission) {
		return "EACCES"
	}
	return "ENOENT"
}

func spawnErrorCode(err error) *int {
	c := -4058
	if errors.Is(err, os.ErrPermission) {
		c = -4092
	}
	return &c
}

// spawnRequiredEnv = libuv win/process.c 的 required_vars：Node 在 Windows 上 spawn 时，
// 自定义 env 缺少这些变量则从父进程补上（不区分大小写）。
var spawnRequiredEnv = []string{"HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE",
	"SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"}

func withSpawnRequiredEnv(env []string) []string {
	for _, k := range spawnRequiredEnv {
		found := false
		for _, kv := range env {
			if i := strings.IndexByte(kv, '='); i > 0 && strings.EqualFold(kv[:i], k) {
				found = true
				break
			}
		}
		if !found {
			if v, ok := lookupEnv(k); ok {
				env = append(env, k+"="+v)
			}
		}
	}
	return env
}
