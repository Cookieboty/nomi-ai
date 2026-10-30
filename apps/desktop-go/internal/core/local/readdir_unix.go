//go:build !windows

package local

import "os"

// libuv uv_fs_scandir 在 Unix 上用 strcmp 排序 → 与 os.ReadDir 的字节序一致。
func readDirNodeOrder(p string) ([]os.DirEntry, error) { return os.ReadDir(p) }
