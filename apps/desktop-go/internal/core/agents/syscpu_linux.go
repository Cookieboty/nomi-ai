package agents

import (
	"os"
	"strconv"
	"strings"
)

// SystemCPU：整机累计 CPU 时间（/proc/stat 第一行，所有核加起来）；忙 = 总 - idle - iowait
func SystemCPU() (busy, total float64, ok bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	return parseProcStat(string(b))
}

func parseProcStat(s string) (busy, total float64, ok bool) {
	line, _, _ := strings.Cut(s, "\n")
	f := strings.Fields(line)
	if len(f) < 5 || f[0] != "cpu" {
		return 0, 0, false
	}
	vals := []float64{}
	// user nice system idle iowait irq softirq steal（guest 已算在 user 里，不再加）
	for _, x := range f[1:min(len(f), 9)] {
		v, err := strconv.ParseFloat(x, 64)
		if err != nil {
			return 0, 0, false
		}
		vals = append(vals, v)
	}
	idle := vals[3]
	if len(vals) > 4 {
		idle += vals[4]
	}
	for _, v := range vals {
		total += v
	}
	return total - idle, total, true
}
