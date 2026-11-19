//go:build linux

package sideterminal

import (
	"fmt"
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

	var unlock int32
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), unix.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		cleanupMaster()
		return nil, nil, errno
	}

	var ptn uint32
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(masterFd), unix.TIOCGPTN, uintptr(unsafe.Pointer(&ptn))); errno != 0 {
		cleanupMaster()
		return nil, nil, errno
	}
	slavePath := fmt.Sprintf("/dev/pts/%d", ptn)

	slaveFd, err := unix.Open(slavePath, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		cleanupMaster()
		return nil, nil, err
	}

	return os.NewFile(uintptr(masterFd), "/dev/ptmx"), os.NewFile(uintptr(slaveFd), slavePath), nil
}
