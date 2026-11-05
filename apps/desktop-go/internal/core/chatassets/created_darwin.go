package chatassets

import (
	"os"
	"syscall"
)

// createdAt：birthtime 与修改时间取早的那个，birthtime 拿不到用修改时间。
// macOS 复制文件时 birthtime 是复制时刻，修改时间可能更早。
func createdAt(info os.FileInfo) int64 {
	m := info.ModTime().UnixMilli()
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Birthtimespec.Sec > 0 {
		if b := st.Birthtimespec.Sec*1000 + st.Birthtimespec.Nsec/1e6; b < m {
			return b
		}
	}
	return m
}
