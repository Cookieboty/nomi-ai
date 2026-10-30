package privacy

import "math"

// log2 is V8's Math.log2 (ieee754::log2, FreeBSD e_log2.c). Products are
// wrapped in float64() so the compiler cannot fuse them into FMAs.
func log2(x float64) float64 {
	const (
		two54   = 1.80143985094819840000e+16
		ivln2hi = 1.44269504072144627571e+00
		ivln2lo = 1.67517131648865118353e-10
	)
	bits := math.Float64bits(x)
	hx := int32(bits >> 32)
	lx := uint32(bits)
	k := int32(0)
	if hx < 0x00100000 {
		if (hx&0x7fffffff)|int32(lx) == 0 {
			return math.Inf(-1)
		}
		if hx < 0 {
			return math.NaN()
		}
		k -= 54
		x = float64(x * two54)
		hx = int32(math.Float64bits(x) >> 32)
	}
	if hx >= 0x7ff00000 {
		return x + x
	}
	if hx == 0x3ff00000 && uint32(math.Float64bits(x)) == 0 {
		return 0
	}
	k += (hx >> 20) - 1023
	hx &= 0x000fffff
	i := (hx + 0x95f64) & 0x100000
	x = math.Float64frombits(uint64(uint32(hx|(i^0x3ff00000)))<<32 | uint64(uint32(math.Float64bits(x))))
	k += i >> 20
	y := float64(k)
	f := x - 1.0
	hfsq := float64(float64(0.5*f) * f)
	r := kLog1p(f)
	hi := f - hfsq
	hi = math.Float64frombits(math.Float64bits(hi) &^ 0xffffffff)
	lo := (f - hi) - hfsq + r
	valHi := float64(hi * ivln2hi)
	valLo := float64(float64(lo+hi)*ivln2lo) + float64(lo*ivln2hi)
	w := y + valHi
	valLo += (y - w) + valHi
	valHi = w
	return valLo + valHi
}

func kLog1p(f float64) float64 {
	const (
		lg1 = 6.666666666666735130e-01
		lg2 = 3.999999999940941908e-01
		lg3 = 2.857142874366239149e-01
		lg4 = 2.222219843214978396e-01
		lg5 = 1.818357216161805012e-01
		lg6 = 1.531383769920937332e-01
		lg7 = 1.479819860511658591e-01
	)
	s := f / (2.0 + f)
	z := float64(s * s)
	w := float64(z * z)
	t1 := float64(w * (lg2 + float64(w*(lg4+float64(w*lg6)))))
	t2 := float64(z * (lg1 + float64(w*(lg3+float64(w*(lg5+float64(w*lg7)))))))
	R := t2 + t1
	hfsq := float64(float64(0.5*f) * f)
	return float64(s * (hfsq + R))
}
