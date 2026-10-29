package util

import (
	"math"
	"math/big"
	"strings"
)

// ToFixed is Number.prototype.toFixed(d) for finite |x| < 1e21: the exact
// binary value rounded to d places, ties to the larger n (away from zero for
// the magnitude), unlike Go's round-half-even.
func ToFixed(x float64, d int) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.Abs(x) >= 1e21 || math.IsInf(x, 0) {
		return JSString(x)
	}
	neg := x < 0
	if neg {
		x = -x
	}
	s := new(big.Float).SetPrec(2048).SetFloat64(x).Text('f', 1100) // exact
	ip, fp, _ := strings.Cut(s, ".")
	fp += strings.Repeat("0", d+1)
	digits := []byte(ip + fp[:d])
	if fp[d] >= '5' {
		i := len(digits) - 1
		for ; i >= 0; i-- {
			if digits[i] == '9' {
				digits[i] = '0'
				continue
			}
			digits[i]++
			break
		}
		if i < 0 {
			digits = append([]byte{'1'}, digits...)
		}
	}
	n := len(digits) - d
	out := string(digits[:n])
	if d > 0 {
		out += "." + string(digits[n:])
	}
	if neg {
		out = "-" + out // JS: (-0.001).toFixed(2) === "-0.00"
	}
	return out
}
