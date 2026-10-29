//go:build !windows

package cli

import "golang.org/x/sys/unix"

// accessWritable = fs.accessSync(d, W_OK) 成功。
func accessWritable(d string) bool { return unix.Access(d, unix.W_OK) == nil }
