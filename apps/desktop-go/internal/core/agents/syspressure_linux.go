package agents

import (
	"os"
	"strconv"
	"strings"
)

// SystemMemory：Linux：MemAvailable / MemTotal 与 PSI（/proc/pressure/memory），取更严重的那一级
func SystemMemory() MemPressure {
	out := MemPressure{Level: PressureUnknown, AvailablePercent: -1}
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		out.AvailablePercent = parseMeminfo(string(b))
	}
	level := levelFromAvailable(out.AvailablePercent)
	if b, err := os.ReadFile("/proc/pressure/memory"); err == nil {
		some, full := parsePSI(string(b))
		switch {
		case full >= criticalPSI:
			level = PressureCritical
		case some >= warnPSI && level != PressureCritical:
			level = PressureWarn
		}
	}
	out.Level = level
	return out
}

// parseMeminfo：可用比例（%），读不到 -1
func parseMeminfo(s string) float64 {
	var total, avail float64 = -1, -1
	for _, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(f[1], 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total <= 0 || avail < 0 {
		return -1
	}
	return avail / total * 100
}

// parsePSI：some / full 的 avg10（%）
func parsePSI(s string) (some, full float64) {
	for _, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		for _, kv := range f[1:] {
			if v, ok := strings.CutPrefix(kv, "avg10="); ok {
				x, _ := strconv.ParseFloat(v, 64)
				switch f[0] {
				case "some":
					some = x
				case "full":
					full = x
				}
			}
		}
	}
	return some, full
}
