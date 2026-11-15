//go:build !windows

package devviews

func isWindowsConnErrno(error) bool { return false }
