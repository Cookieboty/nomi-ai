//go:build !darwin && !windows

package hostports

// preferredLanguages：Linux 等没有统一的首选语言 API，交给 envLanguages（Electron 在 Linux 上同样读 locale 环境变量）
func preferredLanguages() []string { return nil }
