package usage

import "math"

// exactSum：费用的精确求和（Shewchuk 部分和，同 Python math.fsum）。结果是全部加数之和的正确舍入，
// 与相加的顺序和分组无关——冷数据按天预先合计后再与热记录相加，结果和逐条相加逐位一致。
// NaN / ±Infinity 按 IEEE 逐步相加的结果处理（有 NaN 或正负无穷都出现 → NaN）。
type exactSum struct {
	p      []float64
	posInf bool
	negInf bool
	nan    bool
}

func (s *exactSum) add(x float64) {
	if math.IsNaN(x) {
		s.nan = true
		return
	}
	if math.IsInf(x, 1) {
		s.posInf = true
		return
	}
	if math.IsInf(x, -1) {
		s.negInf = true
		return
	}
	i := 0
	for _, y := range s.p {
		if math.Abs(x) < math.Abs(y) {
			x, y = y, x
		}
		hi := x + y
		lo := y - (hi - x)
		if lo != 0 {
			s.p[i] = lo
			i++
		}
		x = hi
	}
	s.p = append(s.p[:i], x)
}

func (s *exactSum) addSum(o *exactSum) {
	s.nan = s.nan || o.nan
	s.posInf = s.posInf || o.posInf
	s.negInf = s.negInf || o.negInf
	for _, x := range o.p {
		s.add(x)
	}
}

func (s *exactSum) value() float64 {
	if s.nan || (s.posInf && s.negInf) {
		return math.NaN()
	}
	if s.posInf {
		return math.Inf(1)
	}
	if s.negInf {
		return math.Inf(-1)
	}
	n := len(s.p)
	if n == 0 {
		return 0
	}
	n--
	hi := s.p[n]
	lo := 0.0
	for n > 0 {
		x := hi
		y := s.p[n-1]
		n--
		hi = x + y
		yr := hi - x
		lo = y - yr
		if lo != 0 {
			break
		}
	}
	if n > 0 && ((lo < 0 && s.p[n-1] < 0) || (lo > 0 && s.p[n-1] > 0)) {
		y := lo * 2
		x := hi + y
		yr := x - hi
		if y == yr {
			hi = x
		}
	}
	return hi
}

func (s *exactSum) clone() exactSum {
	c := *s
	c.p = append([]float64(nil), s.p...)
	return c
}
