package local

import "os"

// libuv 在 Windows 上按 NtQueryDirectoryFile 返回顺序，不排序；File.ReadDir 同样不排序。
func readDirNodeOrder(p string) ([]os.DirEntry, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return f.ReadDir(-1)
}
