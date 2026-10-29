package delegate

import "math"

// NumberToString36：V8 DoubleToRadixCString(value, 36)（Number.prototype.toString(36)），用于 [0,1) 等有限值。
func NumberToString36(value float64) string {
	const radix = 36
	const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
	if value == 0 {
		return "0"
	}
	neg := value < 0
	if neg {
		value = -value
	}
	integer := math.Floor(value)
	fraction := value - integer
	delta := 0.5 * (math.Nextafter(value, math.Inf(1)) - value)
	delta = math.Max(math.Nextafter(0, 1), delta)
	var frac []byte
	if fraction >= delta {
		for {
			fraction *= radix
			delta *= radix
			digit := int(fraction)
			frac = append(frac, chars[digit])
			fraction -= float64(digit)
			if fraction > 0.5 || (fraction == 0.5 && digit&1 == 1) {
				if fraction+delta > 1 {
					// 向上进位
					i := len(frac) - 1
					for {
						if i < 0 {
							integer++
							break
						}
						c := frac[i]
						d := radixIndex(chars, c) + 1
						if d < radix {
							frac[i] = chars[d]
							break
						}
						frac = frac[:i]
						i--
					}
					break
				}
			}
			if fraction < delta {
				break
			}
		}
	}
	var ip []byte
	if integer == 0 {
		ip = []byte{'0'}
	}
	for integer > 0 {
		r := math.Mod(integer, radix)
		ip = append([]byte{chars[int(r)]}, ip...)
		integer = (integer - r) / radix
	}
	out := string(ip)
	if len(frac) > 0 {
		out += "." + string(frac)
	}
	if neg {
		out = "-" + out
	}
	return out
}

func radixIndex(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
