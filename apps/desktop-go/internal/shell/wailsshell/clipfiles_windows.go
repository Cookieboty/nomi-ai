package wailsshell

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	clipUser32        = windows.NewLazySystemDLL("clipUser32.dll")
	clipShell32       = windows.NewLazySystemDLL("clipShell32.dll")
	procOpenClipboard = clipUser32.NewProc("OpenClipboard")
	procCloseClip     = clipUser32.NewProc("CloseClipboard")
	procGetClipData   = clipUser32.NewProc("GetClipboardData")
	procDragQueryFile = clipShell32.NewProc("DragQueryFileW")
)

const cfHDrop = 15

// ClipboardFilePaths = webUtils.getPathForFile 对粘贴文件的来源：剪贴板里的 CF_HDROP（资源管理器里复制的文件）
func (w *Wails) ClipboardFilePaths() []string {
	if r, _, _ := procOpenClipboard.Call(0); r == 0 {
		return nil
	}
	defer procCloseClip.Call()
	h, _, _ := procGetClipData.Call(cfHDrop)
	if h == 0 {
		return nil
	}
	n, _, _ := procDragQueryFile.Call(h, 0xFFFFFFFF, 0, 0)
	var out []string
	for i := uintptr(0); i < n; i++ {
		size, _, _ := procDragQueryFile.Call(h, i, 0, 0)
		buf := make([]uint16, size+1)
		procDragQueryFile.Call(h, i, uintptr(unsafe.Pointer(&buf[0])), size+1)
		out = append(out, syscall.UTF16ToString(buf))
	}
	return out
}
