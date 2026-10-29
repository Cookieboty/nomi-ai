//go:build !windows

package extensions

import (
	"os"
	"syscall"
)

// openNoFollow：fs.openSync(p, O_RDONLY | O_NOFOLLOW)
func openNoFollow(p string) (*os.File, error) {
	return os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
}
