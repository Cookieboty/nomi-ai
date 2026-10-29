//go:build windows

package usage

import (
	"os"
	"syscall"
)

// fileID = libuv 在 Windows 上的 st_dev（卷序列号）/ st_ino（文件索引号）。
func fileID(p string, _ os.FileInfo) (dev, ino float64) {
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return 0, 0
	}
	h, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return 0, 0
	}
	defer syscall.CloseHandle(h)
	var d syscall.ByHandleFileInformation
	if syscall.GetFileInformationByHandle(h, &d) != nil {
		return 0, 0
	}
	return float64(d.VolumeSerialNumber), float64(uint64(d.FileIndexHigh)<<32 | uint64(d.FileIndexLow))
}
