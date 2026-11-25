//go:build !windows

package shellhandlers_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// processGroupAlive reports whether any process in the fixture's group is
// still running; the fake app-server is spawned detached as its own leader.
func processGroupAlive(t *testing.T, pgid int, exclude int) bool {
	t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		if pgid <= 0 {
			return false
		}
		return syscall.Kill(-pgid, 0) != syscall.ESRCH
	}
	for _, e := range entries {
		pid := 0
		if _, err := fmt.Sscanf(e.Name(), "%d", &pid); err != nil || pid == exclude {
			continue
		}
		b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue
		}
		s := string(b)
		i := strings.LastIndexByte(s, ')')
		if i < 0 {
			continue
		}
		fields := strings.Fields(s[i+1:])
		if len(fields) < 3 || fields[2] != "0" {
			continue
		}
		if fields[1] == fmt.Sprint(pgid) {
			return true
		}
	}
	return false
}
