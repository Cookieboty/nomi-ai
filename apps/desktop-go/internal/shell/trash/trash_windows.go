//go:build windows

package trash

import (
	"fmt"
	"syscall"
	"unsafe"
)

type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

const (
	foDelete          = 0x3
	fofSilent         = 0x4
	fofNoConfirmation = 0x10
	fofAllowUndo      = 0x40
	fofNoErrorUI      = 0x400
)

var procSHFileOperationW = syscall.NewLazyDLL("shell32.dll").NewProc("SHFileOperationW")

// item：SHFileOperationW(FO_DELETE, FOF_ALLOWUNDO) → 回收站；pFrom 以双 NUL 结尾
func item(p string) error {
	from, err := syscall.UTF16FromString(p)
	if err != nil {
		return err
	}
	from = append(from, 0)
	op := shFileOpStruct{wFunc: foDelete, pFrom: &from[0], fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("SHFileOperationW failed: 0x%x", r)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("SHFileOperationW aborted")
	}
	return nil
}
