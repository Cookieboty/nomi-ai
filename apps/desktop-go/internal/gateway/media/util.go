package media

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func arr(v any) []map[string]any {
	a, _ := v.([]any)
	out := []map[string]any{}
	for _, x := range a {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func trimSlash(u string) string { return strings.TrimRight(u, "/") }

var dataURL = regexp.MustCompile(`(?s)^data:([^;,]+);base64,(.*)$`)

// fromDataURL：data URL → b64 + mime；否则当公网地址
func fromDataURL(u string) Image {
	if m := dataURL.FindStringSubmatch(u); m != nil {
		return Image{Mime: m[1], B64: m[2]}
	}
	return Image{URL: u}
}

func ratioOf(a Aspect) (float64, float64, bool) {
	p := strings.SplitN(a, ":", 2)
	if len(p) != 2 {
		return 0, 0, false
	}
	w, e1 := strconv.Atoi(p[0])
	h, e2 := strconv.Atoi(p[1])
	if e1 != nil || e2 != nil || w <= 0 || h <= 0 {
		return 0, 0, false
	}
	return float64(w), float64(h), true
}

// OpenAISizeFor：OpenAI Images 只接受三种尺寸；auto 返回 ""
func OpenAISizeFor(a Aspect) string {
	w, h, ok := ratioOf(a)
	if !ok {
		return ""
	}
	if w == h {
		return "1024x1024"
	}
	if w > h {
		return "1536x1024"
	}
	return "1024x1536"
}

// PixelSizeFor：按长边档位与画幅合成像素尺寸，取 64 的倍数
func PixelSizeFor(a Aspect, edge float64, sep string) string {
	w, h, ok := ratioOf(a)
	if !ok {
		w, h = 1, 1
	}
	area := edge * edge
	pw := math.Sqrt(area * w / h)
	ph := area / pw
	snap := func(x float64) int { return int(math.Max(64, math.Round(x/64)*64)) }
	return fmt.Sprintf("%d%s%d", snap(pw), sep, snap(ph))
}

func dataImages(data []map[string]any) []Image {
	out := []Image{}
	for _, d := range data {
		if b := str(d["b64_json"]); b != "" {
			out = append(out, Image{B64: b})
		} else if u := str(d["url"]); u != "" {
			out = append(out, Image{URL: u})
		}
	}
	return out
}

// UpstreamErrorMessage：上游错误正文里的可读信息
func UpstreamErrorMessage(body any) string {
	j := obj(body)
	if j == nil {
		return ""
	}
	if s := str(j["error"]); s != "" {
		return s
	}
	if s := str(obj(j["error"])["message"]); s != "" {
		return s
	}
	if s := str(j["detail"]); s != "" {
		return s
	}
	return str(j["message"])
}
