//go:build !windows

package agents

import (
	"os"
	"syscall"
)

// inoOf = Number(stats.ino)。
func inoOf(st os.FileInfo) float64 {
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		return float64(s.Ino)
	}
	return 0
}
