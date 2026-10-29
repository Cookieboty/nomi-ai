//go:build darwin

package trash

import "strings"

// item：Finder 删除 = 移到废纸篓（可在 Finder 里「放回原处」）
func item(p string) error {
	q := strings.ReplaceAll(strings.ReplaceAll(p, `\`, `\\`), `"`, `\"`)
	return run("osascript", "-e", `tell application "Finder" to delete POSIX file "`+q+`"`)
}
