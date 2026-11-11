//go:build !windows

package resourcepreview

import "os"

// pinFile keeps the original file identity allocated so a replacement at the
// same path cannot reuse it. Unix can unlink an open file.
func pinFile(path string) (*os.File, error) {
	return os.Open(path)
}
