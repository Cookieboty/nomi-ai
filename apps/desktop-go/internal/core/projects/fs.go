package projects

import "runtime"

// isCaseInsensitiveFS：macOS / Windows 默认大小写不敏感
func isCaseInsensitiveFS() bool { return runtime.GOOS == "darwin" || runtime.GOOS == "windows" }
