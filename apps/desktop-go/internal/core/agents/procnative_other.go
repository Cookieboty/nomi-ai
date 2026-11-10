//go:build !(darwin && cgo) && !windows

package agents

// readProcessesNative：这个平台 / 构建没有原生读法，用 ps
func readProcessesNative() []RawProc { return nil }
