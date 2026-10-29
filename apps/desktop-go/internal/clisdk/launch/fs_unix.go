//go:build !windows

package launch

import (
	"os"
	"path/filepath"
	"syscall"
)

// realpathNative = fs.realpathSync.native（realpath(3)）。
func realpathNative(p string) (string, error) {
	if p == "" {
		return "", syscall.ENOENT
	}
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(r)
}

func readlinkNode(p string) (string, error) { return os.Readlink(p) }

// symlinkNode：POSIX 上 type 参数被忽略（同 Node）。
func symlinkNode(target, link, _ string) error { return os.Symlink(target, link) }

func isJunction(os.FileInfo) bool { return false }
