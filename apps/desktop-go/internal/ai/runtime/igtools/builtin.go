package igtools

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // Intl 自带 IANA 库；Go 侧内嵌，避免依赖系统 zoneinfo

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Env：时间 / 随机源（测试固定；生产 = Date.now / Math.random）
type Env struct {
	Now    func() float64 // ms
	Random func() float64
}

func (e Env) now() float64 {
	if e.Now != nil {
		return e.Now()
	}
	return float64(time.Now().UnixMilli())
}

func (e Env) random() float64 {
	if e.Random != nil {
		return e.Random()
	}
	return rand.Float64()
}

// BuiltinTools = ToolsBuiltinPlugin(enable: ['time_now','random','echo'])
func BuiltinTools(env Env) []tools.Definition {
	return []tools.Definition{
		{
			Name:           "time_now",
			Description:    "返回当前时间的 ISO 字符串。可选 tz（IANA 时区名，如 Asia/Shanghai）。",
			Input:          schema(timeNowSchema),
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				if in == nil || isUndefined(in) { // input ?? {}
					in = u.NewObj()
				}
				o, err := parse(timeNowIn, in)
				if err != nil {
					return nil, err
				}
				now := env.now()
				tz, _ := o.Get("tz").(string)
				if tz == "" {
					s, _ := u.ToISOString(now)
					return s, nil
				}
				loc := resolveTZ(tz)
				if loc == nil {
					return nil, errors.New("invalid tz: " + tz)
				}
				t := time.UnixMilli(int64(now)).In(loc)
				return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d", t.Year(), int(t.Month()), t.Day(), t.Hour(), t.Minute(), t.Second()), nil
			},
		},
		{
			Name:           "random",
			Description:    "返回 [min, max] 之间的随机数；integer=true 时为整数（含边界）。",
			Input:          schema(randomSchema),
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(randomIn, in)
				if err != nil {
					return nil, err
				}
				mn := o.Get("min").(float64)
				mx := o.Get("max").(float64)
				if o.Get("integer") == true {
					lo, hi := math.Ceil(mn), math.Floor(mx)
					return math.Floor(env.random()*(hi-lo+1)) + lo, nil
				}
				return float64(env.random()*(mx-mn)) + mn, nil
			},
		},
		{
			Name:           "echo",
			Description:    "原样返回输入的文本，用于连通性 / 冒烟测试。",
			Input:          schema(echoSchema),
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(echoIn, in)
				if err != nil {
					return nil, err
				}
				return o.Get("text"), nil
			},
		},
	}
}

func isUndefined(v any) bool { return v == aifacade.Undef }

var offsetRe = regexp.MustCompile(`^([+-])(\d{2})(?::?(\d{2}))?$`)

// resolveTZ ≈ Intl.DateTimeFormat({ timeZone })：IANA 名大小写不敏感 + ±HH[:MM] 偏移；nil = RangeError
func resolveTZ(tz string) *time.Location {
	if m := offsetRe.FindStringSubmatch(tz); m != nil {
		var h, mi int
		fmt.Sscanf(m[2], "%d", &h)
		if m[3] != "" {
			fmt.Sscanf(m[3], "%d", &mi)
		}
		if h > 23 || mi > 59 {
			return nil
		}
		off := h*3600 + mi*60
		if m[1] == "-" {
			off = -off
		}
		return time.FixedZone(tz, off)
	}
	if strings.EqualFold(tz, "utc") || strings.EqualFold(tz, "gmt") {
		return time.UTC
	}
	if loc, err := time.LoadLocation(tz); err == nil && tz != "Local" && tz != "" {
		return loc
	}
	if loc, err := time.LoadLocation(canonCase(tz)); err == nil {
		return loc
	}
	return nil
}

// canonCase：asia/shanghai → Asia/Shanghai、america/new_york → America/New_York、etc/gmt+8 → Etc/GMT+8
func canonCase(tz string) string {
	segs := strings.Split(tz, "/")
	for i, s := range segs {
		low := strings.ToLower(s)
		if strings.HasPrefix(low, "gmt") || strings.HasPrefix(low, "utc") || low == "uct" {
			segs[i] = strings.ToUpper(low[:3]) + low[3:]
			continue
		}
		b := []byte(low)
		up := true
		for j, c := range b {
			if up && c >= 'a' && c <= 'z' {
				b[j] = c - 32
			}
			up = c == '_' || c == '-'
		}
		segs[i] = string(b)
	}
	return strings.Join(segs, "/")
}
