// Package trash = HostPorts.shell.trashItem（Electron shell.trashItem）：把文件 / 目录移到系统废纸篓。
// 不用厂商 SDK：Linux 走 gio / kioclient（同 Electron platform_util_linux），macOS 走 Finder（osascript，
// 偏差 D-SH-9：Electron 用 NSFileManager trashItemAtURL），Windows 走 shell32 SHFileOperationW(FOF_ALLOWUNDO)。
package trash

import (
	"errors"
	"os"
	"path/filepath"
)

// run 可在单测里替换（外部命令）
var run = runCmd

// Item = shell.trashItem(path)：路径不存在或移动失败返回错误
func Item(p string) error {
	if p == "" {
		return errors.New("trashItem: empty path")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(abs); err != nil {
		return err
	}
	return item(abs)
}
