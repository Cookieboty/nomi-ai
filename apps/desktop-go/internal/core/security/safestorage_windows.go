//go:build windows

package security

import (
	"syscall"
	"unsafe"
)

type winSafeStorage struct{}

func NewElectronSafeStorage() ElectronSafeStorage { return winSafeStorage{} }

func (winSafeStorage) Available() bool { return true }

func (winSafeStorage) Decrypt(cipherText []byte) (string, bool) {
	// Chromium/Electron on Windows: optional "DPAPI" prefix then CryptUnprotectData blob
	data := cipherText
	if len(data) >= 5 && string(data[:5]) == "DPAPI" {
		data = data[5:]
	}
	var in, out dataBlob
	in.cbData = uint32(len(data))
	in.pbData = &data[0]
	crypt32 := syscall.NewLazyDLL("crypt32.dll")
	proc := crypt32.NewProc("CryptUnprotectData")
	r, _, _ := proc.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 || out.pbData == nil {
		return "", false
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(out.pbData)))
	plain := unsafe.Slice(out.pbData, out.cbData)
	return string(append([]byte(nil), plain...)), true
}

type dataBlob struct {
	cbData uint32
	pbData *byte
}
