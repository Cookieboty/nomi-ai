//go:build windows

package devviews

import (
	"errors"

	"golang.org/x/sys/windows"
)

func isWindowsConnErrno(err error) bool {
	return errors.Is(err, windows.WSAECONNRESET) ||
		errors.Is(err, windows.WSAECONNREFUSED) ||
		errors.Is(err, windows.WSAECONNABORTED)
}
