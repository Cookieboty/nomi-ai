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
