package util

import (
	"math"
	"regexp"
	"strconv"
)

var reDecimal = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

func toNumber(s string) float64 {
	switch s {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			f := 0.0
			for _, c := range s[2:] {
				d, ok := unhex(byte(c))
				if c > 0x7f || !ok || int(d) >= base {
					return math.NaN()
				}
				f = float64(f*float64(base)) + float64(d) // explicit float64(): no FMA (JS rounds the product)
			}
			return f
		}
	}
	if !reDecimal.MatchString(s) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !math.IsInf(f, 0) {
		return math.NaN()
	}
	return f
}
