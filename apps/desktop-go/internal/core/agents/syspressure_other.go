//go:build !darwin && !linux && !windows

package agents

// SystemMemory：这个平台读不到内存压力
func SystemMemory() MemPressure { return MemPressure{Level: PressureUnknown, AvailablePercent: -1} }
