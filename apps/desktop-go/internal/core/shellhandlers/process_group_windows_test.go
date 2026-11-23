//go:build windows

package shellhandlers_test

import "testing"

func processGroupAlive(t *testing.T, pgid int, exclude int) bool {
	t.Helper()
	t.Skip("POSIX process-group check skipped on Windows")
	return false
}
