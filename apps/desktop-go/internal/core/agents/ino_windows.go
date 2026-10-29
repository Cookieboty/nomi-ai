//go:build windows

package agents

import "os"

// inoOf：Windows 上 dsh 锁快照恒为 null（readLockedInodes 只在 linux 有值），inode 不参与判定。
func inoOf(os.FileInfo) float64 { return 0 }
