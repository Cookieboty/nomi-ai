package chatassets

import (
	"os"
	"syscall"
)

// createdAt：创建时间（macOS 有 birthtime），拿不到用修改时间（与 Node birthtimeMs || mtimeMs 一致）
func createdAt(info os.FileInfo) int64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Birthtimespec.Sec > 0 {
		return st.Birthtimespec.Sec*1000 + st.Birthtimespec.Nsec/1e6
	}
	return info.ModTime().UnixMilli()
}
