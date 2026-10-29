//go:build !linux

package wailsshell

func trayHostAvailable() bool { return true }
