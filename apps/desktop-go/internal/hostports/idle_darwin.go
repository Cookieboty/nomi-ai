//go:build darwin

package hostports

import (
	"os/exec"
	"regexp"
	"strconv"
)

var reHIDIdle = regexp.MustCompile(`"HIDIdleTime" = (\d+)`)

// IdleSeconds = powerMonitor.getSystemIdleTime（Chromium 在 macOS 读 IOHIDSystem 的 HIDIdleTime，单位纳秒）
func IdleSeconds() int {
	out, err := exec.Command("/usr/sbin/ioreg", "-c", "IOHIDSystem", "-d", "4").Output()
	if err != nil {
		return 0
	}
	m := reHIDIdle.FindSubmatch(out)
	if m == nil {
		return 0
	}
	ns, _ := strconv.ParseUint(string(m[1]), 10, 64)
	return int(ns / 1e9)
}
