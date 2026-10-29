//go:build !windows && !darwin

package hostports

import (
	"os/exec"
	"strconv"
	"strings"
)

// IdleSeconds = powerMonitor.getSystemIdleTime：Chromium 在 Linux 用 XScreenSaverQueryInfo，
// 拿不到（如纯 Wayland）时返回 0。这里用 xprintidle（同一个 XScreenSaver 扩展），缺失时同样返回 0。
func IdleSeconds() int {
	out, err := exec.Command("xprintidle").Output()
	if err != nil {
		return 0
	}
	ms, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return int(ms / 1000)
}
