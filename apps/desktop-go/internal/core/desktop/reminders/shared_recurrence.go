package reminders

import (
	"encoding/json"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

// Repeat：与 SchedulerService 共用 schedule/recurrence（Node 两边都 import '../schedule/recurrence'）
type Repeat = schedule.Repeat

// SanitizeRepeat：原始 JSON → schedule.SanitizeRepeat
func SanitizeRepeat(raw json.RawMessage) *Repeat {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return schedule.SanitizeRepeat(v)
}

// NextOccurrence：提醒的时间戳是 JSON number（float64）
func NextOccurrence(r Repeat, anchor, after float64) float64 {
	return float64(schedule.NextOccurrence(r, int64(anchor), int64(after)))
}

func local(ms float64) time.Time { return time.UnixMilli(int64(ms)).In(time.Local) }

func msOf(t time.Time) float64 { return float64(t.UnixMilli()) }
