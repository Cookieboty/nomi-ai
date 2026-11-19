//go:build darwin

package sideterminal

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/unix"
)

func openPTY() (master *os.File, slave *os.File, err error) {
	masterFd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	cleanupMaster := func() { _ = unix.Close(masterFd) }

	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), unix.TIOCPTYGRANT, 0); errno != 0 {
		cleanupMaster()
		return nil, nil, errno
	}
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), unix.TIOCPTYUNLK, 0); errno != 0 {
		cleanupMaster()
		return nil, nil, errno
	}

	var nameBuf [128]byte
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), unix.TIOCPTYGNAME, uintptr(unsafe.Pointer(&nameBuf[0]))); errno != 0 {
		cleanupMaster()
		return nil, nil, errno
	}
	slavePath := unix.ByteSliceToString(nameBuf[:])
	if slavePath == "" {
		cleanupMaster()
		return nil, nil, errors.New("empty pty slave name")
	}

	slaveFd, err := unix.Open(slavePath, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		cleanupMaster()
		return nil, nil, err
	}

	return os.NewFile(uintptr(masterFd), "/dev/ptmx"), os.NewFile(uintptr(slaveFd), slavePath), nil
}
