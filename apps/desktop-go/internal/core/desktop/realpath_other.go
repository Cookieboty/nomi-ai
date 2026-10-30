//go:build !windows

package desktop

import "path/filepath"

func realpathNative(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(r)
}
