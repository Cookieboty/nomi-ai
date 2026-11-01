//go:build !darwin

package chatassets

import "os"

// createdAt：没有可靠的 birthtime，用修改时间
func createdAt(info os.FileInfo) int64 { return info.ModTime().UnixMilli() }
