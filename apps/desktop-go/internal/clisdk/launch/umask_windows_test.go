//go:build windows

package launch

// Windows 无 umask（process.umask 在 Windows 上也不影响权限位）。
func setUmask(int) func() { return func() {} }
