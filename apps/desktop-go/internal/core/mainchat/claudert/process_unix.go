//go:build !windows

package claudert

import (
	"fmt"
	"os"
	"syscall"
)

func killGroup(pid int) {
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}
func groupGone(pid int) bool { return pid <= 0 || syscall.Kill(-pid, 0) == syscall.ESRCH }

func directoryIdentity(info os.FileInfo) string {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
	}
	return "unavailable"
}
