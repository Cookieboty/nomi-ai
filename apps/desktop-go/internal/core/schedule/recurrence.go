// Package schedule 移植 apps/desktop-electron/internal/core/src/schedule：重复规则 / 免打扰（recurrence.ts）与
// SchedulerService（定时任务、补跑、主动聊天）。时间一律按本地时区（time.Local），与 Node 的 Date 一致。
package schedule

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Repeat 对应 recurrence.ts 的判别联合：daily | weekdays | weekly{days} | monthly | interval{minutes}
type Repeat struct {
	Kind    string `json:"kind"`
	Days    []int  `json:"days,omitempty"`
	Minutes int    `json:"minutes,omitempty"`
}

var RepeatLabel = map[string]string{
	"daily":    "每天",
	"weekdays": "工作日",
	"weekly":   "每周",
	"monthly":  "每月",
	"interval": "每隔",
}

var week = []string{"日", "一", "二", "三", "四", "五", "六"}

func DescribeRepeat(r *Repeat) string {
	if r == nil {
		return "不重复"
	}
	switch r.Kind {
	case "weekly":
		days := append([]int(nil), r.Days...)
		// JS 默认 sort 按字符串比较；0–6 单字符，与数值序一致
		sort.Slice(days, func(i, j int) bool { return strconv.Itoa(days[i]) < strconv.Itoa(days[j]) })
		parts := make([]string, len(days))
		for i, d := range days {
			if d >= 0 && d < len(week) {
				parts[i] = week[d]
			}
		}
		return "每周" + strings.Join(parts, "、")
	case "interval":
		if r.Minutes%60 == 0 {
			return "每 " + strconv.Itoa(r.Minutes/60) + " 小时"
		}
		return "每 " + strconv.Itoa(r.Minutes) + " 分钟"
	default:
		return RepeatLabel[r.Kind]
	}
}

// jsNumber：JS 的 Number(x)（JSON 解出来的值）
func jsNumber(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	default:
		return math.NaN()
	}
}

// jsRound：Math.round（.5 向 +∞）
func jsRound(f float64) float64 { return math.Floor(f + 0.5) }

func SanitizeRepeat(raw any) *Repeat {
	o, ok := raw.(map[string]any)
	if !ok || o == nil {
		return nil
	}
	kind, _ := o["kind"].(string)
	switch kind {
	case "daily", "weekdays", "monthly":
		return &Repeat{Kind: kind}
	case "weekly":
		var days []int
		if arr, ok := o["days"].([]any); ok {
			seen := map[int]bool{}
			for _, d := range arr {
				f, ok := d.(float64)
				if !ok || f != math.Trunc(f) || f < 0 || f > 6 {
					continue
				}
				if !seen[int(f)] {
					seen[int(f)] = true
					days = append(days, int(f))
				}
			}
		}
		if len(days) == 0 {
			return nil
		}
		sort.Ints(days)
		return &Repeat{Kind: "weekly", Days: days}
	case "interval":
		v, present := o["minutes"]
		m := math.NaN()
		if present {
			m = jsNumber(v)
		}
		if math.IsNaN(m) || math.IsInf(m, 0) || m < 5 {
			return nil
		}
		return &Repeat{Kind: "interval", Minutes: int(math.Min(10080, jsRound(m)))}
	}
	return nil
}

func local(ms int64) time.Time { return time.UnixMilli(ms).In(time.Local) }

func mk(y int, mon time.Month, d, h, mi, s int) int64 {
	return time.Date(y, mon, d, h, mi, s, 0, time.Local).UnixMilli()
}

// NextOccurrence：下一次发生时间，保持 anchor 的时分（interval 除外），严格晚于 after
func NextOccurrence(r Repeat, anchor, after int64) int64 {
	if r.Kind == "interval" {
		step := int64(r.Minutes) * 60_000
		if anchor > after {
			return anchor
		}
		return anchor + (int64(math.Floor(float64(after-anchor)/float64(step)))+1)*step
	}
	a := local(anchor)
	h, mi, s := a.Hour(), a.Minute(), a.Second()
	if r.Kind == "monthly" {
		dom := a.Day()
		base := local(max(after, anchor))
		for k := 0; k < 24; k++ {
			y := base.Year()
			m := base.Month() + time.Month(k)
			last := local(mk(y, m+1, 0, 0, 0, 0)).Day()
			t := mk(y, m, min(dom, last), h, mi, s)
			if t > after && t >= anchor {
				return t
			}
		}
		return after + 30*86_400_000
	}
	start := local(max(after, anchor-1))
	for k := 0; k < 15; k++ {
		t := mk(start.Year(), start.Month(), start.Day()+k, h, mi, s)
		if t <= after || t < anchor {
			continue
		}
		wd := int(local(t).Weekday())
		if r.Kind == "weekdays" && (wd == 0 || wd == 6) {
			continue
		}
		if r.Kind == "weekly" && !containsInt(r.Days, wd) {
			continue
		}
		return t
	}
	return after + 86_400_000
}

func containsInt(xs []int, v int) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

type QuietHours struct {
	Enabled bool   `json:"enabled"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

var hhmmRe = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)

func toMin(s string) (int, bool) {
	m := hhmmRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	if h < 24 && mi < 60 {
		return h*60 + mi, true
	}
	return 0, false
}

// ValidHHMM：typeof s === 'string' && toMin(s) !== null
func ValidHHMM(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	_, ok = toMin(s)
	return ok
}

// InQuiet：当前是否处于免打扰；跨午夜也支持
func InQuiet(q QuietHours, at int64) bool {
	if !q.Enabled {
		return false
	}
	s, ok1 := toMin(q.Start)
	e, ok2 := toMin(q.End)
	if !ok1 || !ok2 || s == e {
		return false
	}
	d := local(at)
	m := d.Hour()*60 + d.Minute()
	if s < e {
		return m >= s && m < e
	}
	return m >= s || m < e
}

// QuietEndsAt：免打扰结束的时间点（不在免打扰时返回 at）
func QuietEndsAt(q QuietHours, at int64) int64 {
	if !InQuiet(q, at) {
		return at
	}
	e, _ := toMin(q.End)
	d := local(at)
	t := mk(d.Year(), d.Month(), d.Day(), e/60, e%60, 0)
	if t <= at {
		t += 86_400_000
	}
	return t
}

// FirstRun："HH:MM" + 重复规则 → 第一次运行时间（晚于 now）
func FirstRun(hhmm string, r Repeat, now int64) int64 {
	m, ok := toMin(hhmm)
	if !ok {
		m = 8 * 60
	}
	d := local(now)
	anchor := mk(d.Year(), d.Month(), d.Day(), m/60, m%60, 0)
	if r.Kind == "interval" {
		if anchor > now {
			return anchor
		}
		return NextOccurrence(r, anchor, now)
	}
	return NextOccurrence(r, anchor, max(now, anchor-1))
}
