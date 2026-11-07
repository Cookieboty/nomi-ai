package agents

import "golang.org/x/sys/unix"

// SystemMemory：macOS 的内存压力等级（kern.memorystatus_vm_pressure_level：1 正常 / 2 告警 / 4 危险，
// 与活动监视器的「内存压力」同源）与可用内存比例（kern.memorystatus_level）
func SystemMemory() MemPressure {
	out := MemPressure{Level: PressureUnknown, AvailablePercent: -1}
	if v, err := unix.SysctlUint32("kern.memorystatus_level"); err == nil {
		out.AvailablePercent = float64(v)
	}
	if v, err := unix.SysctlUint32("kern.memorystatus_vm_pressure_level"); err == nil {
		switch v {
		case 1:
			out.Level = PressureNormal
		case 2:
			out.Level = PressureWarn
		case 4:
			out.Level = PressureCritical
		}
	}
	return out
}
