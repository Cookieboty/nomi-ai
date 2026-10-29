//go:build windows

package cli

import "os"

// accessWritable = fs.accessSync(d, W_OK)：libuv 在 Windows 上只看只读属性（目录总是可写）。
func accessWritable(d string) bool {
	st, err := os.Stat(d)
	if err != nil {
		return false
	}
	return st.IsDir() || st.Mode().Perm()&0o200 != 0
}
