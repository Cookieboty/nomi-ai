package updates

import "errors"

// Windows 用 NSIS 安装器静默升级，不做原地替换
func macSwapTarget() (string, bool) { return "", false }

func startMacSwap(string, string, bool) error {
	return errors.New("in-place update is only supported on macOS")
}
