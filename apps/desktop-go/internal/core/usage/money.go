package usage

import (
	"math"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 对应 money.ts

func CurrencySymbol(c Currency) string {
	if c == "CNY" {
		return "¥"
	}
	return "$"
}

func ConvertUsd(usd float64, c Currency, cnyPerUsd float64) float64 {
	if c == "CNY" {
		return usd * cnyPerUsd
	}
	return usd
}

// toLocaleString('en-US', { maximumFractionDigits: 0 })：四舍五入（远离 0）+ 千分位
func localeInt(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if math.IsInf(v, 0) {
		if v < 0 {
			return "-∞"
		}
		return "∞"
	}
	s := util.ToFixed(v, 0)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	if strings.ContainsAny(s, "e") {
		f, _ := strconv.ParseFloat(s, 64)
		s = strconv.FormatFloat(f, 'f', 0, 64)
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	out := b.String()
	if neg && out != "0" {
		out = "-" + out
	}
	return out
}

func FormatMoney(usd float64, c Currency, cnyPerUsd float64) string {
	v := ConvertUsd(usd, c, cnyPerUsd)
	s := CurrencySymbol(c)
	if v == 0 {
		return s + "0.00"
	}
	if v < 0.01 {
		return "<" + s + "0.01"
	}
	if v < 1 {
		return s + util.ToFixed(v, 3)
	}
	if v < 1000 {
		return s + util.ToFixed(v, 2)
	}
	return s + localeInt(v)
}

var trailing00 = util.JSRe(`\.00$`)

func FormatAmount(v float64, c Currency) string {
	s := CurrencySymbol(c)
	if v >= 100 {
		return s + util.ToFixed(v, 0)
	}
	return s + trailing00.ReplaceAllString(util.ToFixed(v, 2), "")
}

var trailingZeros = util.JSRe(`\.?0+$`)

func FormatTokens(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return "0"
	}
	type unit struct {
		base float64
		u    string
	}
	units := []unit{{1e9, "B"}, {1e6, "M"}, {1e3, "K"}}
	for i := 0; i < len(units); i++ {
		base, un := units[i].base, units[i].u
		if n < base {
			continue
		}
		v := n / base
		u := un
		if jsRound(v) >= 1000 && i > 0 {
			v = n / units[i-1].base
			u = units[i-1].u
		}
		d := 2
		if v >= 100 {
			d = 0
		} else if v >= 10 {
			d = 1
		}
		txt := util.ToFixed(v, d)
		if strings.Contains(txt, ".") {
			txt = trailingZeros.ReplaceAllString(txt, "")
		}
		return txt + u
	}
	return util.FormatNumber(jsRound(n))
}

// Math.round：.5 向 +∞
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	if r == 0 && (math.Signbit(x) || x < 0) {
		return math.Copysign(0, -1)
	}
	return r
}
