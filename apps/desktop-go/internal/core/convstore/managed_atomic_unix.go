//go:build !windows

package convstore

import "os"

func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func chmodPrivate(f *os.File) error {
	return f.Chmod(0600)
}

func replaceFile(src, dst string) error {
	return os.Rename(src, dst)
}
