package agents

// 系统内存压力（Agent 看板与内存守护用）：三级，读不到时 unknown。

const (
	PressureUnknown  = "unknown"
	PressureNormal   = "normal"
	PressureWarn     = "warn"
	PressureCritical = "critical"
)

// MemPressure：系统内存压力；AvailablePercent < 0 = 不知道
type MemPressure struct {
	Level            string
	AvailablePercent float64
}

// Linux / Windows 没有系统给的压力等级，按可用比例与 PSI 自己划
const (
	warnAvailablePct     = 15
	criticalAvailablePct = 7
	warnPSI              = 10 // /proc/pressure/memory some avg10（%）
	criticalPSI          = 5  // full avg10（%）
)

func levelFromAvailable(avail float64) string {
	switch {
	case avail < 0:
		return PressureUnknown
	case avail < criticalAvailablePct:
		return PressureCritical
	case avail < warnAvailablePct:
		return PressureWarn
	}
	return PressureNormal
}
