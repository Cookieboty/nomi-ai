//go:build windows

package launch

// Windows 无 umask（Node process.umask 在 Windows 上同样不影响权限位）。
func setUmask(int) func() { return func() {} }
