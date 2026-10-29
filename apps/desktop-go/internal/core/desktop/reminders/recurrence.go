package reminders

// recurrence.go 移植 packages/core/src/schedule/recurrence.ts 中提醒用到的部分。
// D-B6-2：core/schedule 属于批次 8；该批次合入后改为引用 core/schedule，删除本文件。

import (
	"encoding/json"
	"math"
	"slices"
	"time"
)

// Repeat 重复规则
type Repeat struct {
	Kind    string `json:"kind"`
	Days    []int  `json:"days,omitempty"`
	Minutes *int   `json:"minutes,omitempty"`
}

func (r Repeat) MarshalJSON() ([]byte, error) {
	switch r.Kind {
	case "weekly":
		return json.Marshal(struct {
			Kind string `json:"kind"`
			Days []int  `json:"days"`
		}{r.Kind, r.Days})
	case "interval":
		m := 0
		if r.Minutes != nil {
			m = *r.Minutes
		}
		return json.Marshal(struct {
			Kind    string `json:"kind"`
			Minutes int    `json:"minutes"`
		}{r.Kind, m})
	}
	return json.Marshal(struct {
		Kind string `json:"kind"`
	}{r.Kind})
}

// SanitizeRepeat：raw 为任意 JSON
func SanitizeRepeat(raw json.RawMessage) *Repeat {
	var o map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &o) != nil || o == nil {
		return nil
	}
	kind, _ := o["kind"].(string)
	switch kind {
	case "daily", "weekdays", "monthly":
		return &Repeat{Kind: kind}
	case "weekly":
		arr, _ := o["days"].([]any)
		days := []int{}
		for _, d := range arr {
			f, ok := d.(float64)
			if ok && f == math.Trunc(f) && f >= 0 && f <= 6 && !slices.Contains(days, int(f)) {
				days = append(days, int(f))
			}
		}
		if len(days) == 0 {
			return nil
		}
		slices.Sort(days)
		return &Repeat{Kind: "weekly", Days: days}
	case "interval":
		m, ok := jsNumber(o["minutes"])
		if ok && !math.IsInf(m, 0) && !math.IsNaN(m) && m >= 5 {
			v := int(math.Min(10_080, math.Floor(m+0.5)))
			return &Repeat{Kind: "interval", Minutes: &v}
		}
	}
	return nil
}

// jsNumber：Number(x) 的常见情形
func jsNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case nil:
		return 0, true
	case string:
		var f float64
		if err := json.Unmarshal([]byte(x), &f); err == nil {
			return f, true
		}
		if s := trimJS(x); s == "" {
			return 0, true
		}
	}
	return math.NaN(), false
}

func trimJS(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t' || s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func local(ms float64) time.Time { return time.UnixMilli(int64(ms)).In(time.Local) }

func msOf(t time.Time) float64 { return float64(t.UnixMilli()) }

// NextOccurrence 严格晚于 after 的下一次
func NextOccurrence(r Repeat, anchor, after float64) float64 {
	if r.Kind == "interval" {
		step := float64(*r.Minutes) * 60_000
		if anchor > after {
			return anchor
		}
		return anchor + (math.Floor((after-anchor)/step)+1)*step
	}
	a := local(anchor)
	h, mi, s := a.Hour(), a.Minute(), a.Second()
	if r.Kind == "monthly" {
		dom := a.Day()
		base := local(math.Max(after, anchor))
		for k := 0; k < 24; k++ {
			y, m := base.Year(), int(base.Month())-1+k
			last := time.Date(y, time.Month(m+2), 0, 0, 0, 0, 0, time.Local).Day()
			t := msOf(time.Date(y, time.Month(m+1), min(dom, last), h, mi, s, 0, time.Local))
			if t > after && t >= anchor {
				return t
			}
		}
		return after + 30*86_400_000
	}
	start := local(math.Max(after, anchor-1))
	for k := 0; k < 15; k++ {
		d := time.Date(start.Year(), start.Month(), start.Day()+k, h, mi, s, 0, time.Local)
		t := msOf(d)
		if t <= after || t < anchor {
			continue
		}
		wd := int(d.Weekday())
		if r.Kind == "weekdays" && (wd == 0 || wd == 6) {
			continue
		}
		if r.Kind == "weekly" && !slices.Contains(r.Days, wd) {
			continue
		}
		return t
	}
	return after + 86_400_000
}
