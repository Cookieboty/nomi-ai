//go:build !windows

package usage

import (
	"os"
	"syscall"
)

// fileID = fs.Stats 的 dev / ino（libuv：uint64 → double）。
func fileID(_ string, fi os.FileInfo) (dev, ino float64) {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return float64(uint64(st.Dev)), float64(uint64(st.Ino))
	}
	return 0, 0
}
