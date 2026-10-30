//go:build windows

package wailsshell

import (
	"fmt"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/w32"
	"golang.org/x/sys/windows"
)

// = BrowserWindow.setIcon（Win32：WM_SETICON 大 / 小图标）
func nativeSetWindowIcon(hwnd unsafe.Pointer, png []byte) {
	h := w32.HWND(uintptr(hwnd))
	if big, err := w32.CreateLargeHIconFromImage(png); err == nil && big != 0 {
		w32.SendMessage(h, w32.WM_SETICON, w32.ICON_BIG, uintptr(big))
	}
	if small, err := w32.CreateSmallHIconFromImage(png); err == nil && small != 0 {
		w32.SendMessage(h, w32.WM_SETICON, w32.ICON_SMALL, uintptr(small))
	}
}

var (
	shell32                         = windows.NewLazySystemDLL("shell32.dll")
	procSHGetPropertyStoreForWindow = shell32.NewProc("SHGetPropertyStoreForWindow")
	iidIPropertyStore               = windows.GUID{Data1: 0x886D8EEB, Data2: 0x8CF2, Data3: 0x4446, Data4: [8]byte{0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99}}
	// PKEY_AppUserModel_*：{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}
	fmtAppUserModel = windows.GUID{Data1: 0x9F4C2855, Data2: 0x9F79, Data3: 0x4B39, Data4: [8]byte{0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3}}
)

const (
	pidRelaunchIconResource = 3
	pidAppUserModelID       = 5
	vtLPWSTR                = 31
)

type propertyKey struct {
	fmtid windows.GUID
	pid   uint32
}

// PROPVARIANT（VT_LPWSTR 只用到 vt 与指针；按 x64/x86 都留足 24 字节）
type propVariant struct {
	vt       uint16
	_        [3]uint16
	pwszVal  *uint16
	_padding uintptr
}

type iPropertyStoreVtbl struct {
	QueryInterface, AddRef, Release, GetCount, GetAt, GetValue, SetValue, Commit uintptr
}

type iPropertyStore struct{ vtbl *iPropertyStoreVtbl }

// = BrowserWindow.setAppDetails({ appId, appIconPath, appIconIndex })：
// 窗口属性库写 System.AppUserModel.ID 与 RelaunchIconResource（"<路径>,<序号>"，Electron 同格式）
func nativeSetAppDetails(hwnd unsafe.Pointer, appID, iconPath string, index int) error {
	var ps *iPropertyStore
	hr, _, _ := procSHGetPropertyStoreForWindow.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&iidIPropertyStore)), uintptr(unsafe.Pointer(&ps)))
	if int32(hr) < 0 || ps == nil {
		return fmt.Errorf("SHGetPropertyStoreForWindow: 0x%08x", uint32(hr))
	}
	defer syscall.SyscallN(ps.vtbl.Release, uintptr(unsafe.Pointer(ps)))
	set := func(pid uint32, val string) error {
		p, err := windows.UTF16PtrFromString(val)
		if err != nil {
			return err
		}
		key := propertyKey{fmtAppUserModel, pid}
		pv := propVariant{vt: vtLPWSTR, pwszVal: p}
		r, _, _ := syscall.SyscallN(ps.vtbl.SetValue, uintptr(unsafe.Pointer(ps)), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&pv)))
		if int32(r) < 0 {
			return fmt.Errorf("IPropertyStore::SetValue(%d): 0x%08x", pid, uint32(r))
		}
		return nil
	}
	if appID != "" {
		if err := set(pidAppUserModelID, appID); err != nil {
			return err
		}
	}
	if iconPath != "" {
		if err := set(pidRelaunchIconResource, fmt.Sprintf("%s,%d", iconPath, index)); err != nil {
			return err
		}
	}
	r, _, _ := syscall.SyscallN(ps.vtbl.Commit, uintptr(unsafe.Pointer(ps)))
	if int32(r) < 0 {
		return fmt.Errorf("IPropertyStore::Commit: 0x%08x", uint32(r))
	}
	return nil
}
