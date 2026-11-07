//go:build !linux && !windows && !(darwin && cgo)

package agents

// SystemCPU：这个平台 / 构建（没有 cgo 的 macOS）读不到整机 CPU
func SystemCPU() (busy, total float64, ok bool) { return 0, 0, false }
