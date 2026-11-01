package tasks

// 旧的提醒 / 定时代理任务并入任务页（只读适配器），对应 src/tasks/legacy.ts。

import (
	"sort"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

type LegacyItem struct {
	Source     string           `json:"source"` // reminder | schedule
	ID         string           `json:"id"`
	Title      string           `json:"title"`
	Enabled    bool             `json:"enabled"`
	NextRunAt  *int64           `json:"nextRunAt,omitempty"`
	Repeat     *schedule.Repeat `json:"repeat,omitempty"`
	LastStatus string           `json:"lastStatus,omitempty"`
}

type LegacyReminder struct {
	ID     string           `json:"id"`
	Text   string           `json:"text"`
	DueAt  int64            `json:"dueAt"`
	Status string           `json:"status"`
	Repeat *schedule.Repeat `json:"repeat,omitempty"`
}

type LegacySchedTask struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Enabled    bool            `json:"enabled"`
	NextRunAt  int64           `json:"nextRunAt"`
	Repeat     schedule.Repeat `json:"repeat"`
	LastStatus string          `json:"lastStatus,omitempty"`
}

// LegacyItems：提醒在前（按到期时间，只列待触发的），定时任务在后（按下次运行时间）
func LegacyItems(reminders []LegacyReminder, sched []LegacySchedTask) []LegacyItem {
	rs := []LegacyReminder{}
	for _, r := range reminders {
		if r.Status == "pending" {
			rs = append(rs, r)
		}
	}
	sort.SliceStable(rs, func(i, j int) bool { return rs[i].DueAt < rs[j].DueAt })
	ss := append([]LegacySchedTask(nil), sched...)
	sort.SliceStable(ss, func(i, j int) bool { return ss[i].NextRunAt < ss[j].NextRunAt })
	out := []LegacyItem{}
	for _, r := range rs {
		out = append(out, LegacyItem{Source: "reminder", ID: r.ID, Title: r.Text, Enabled: true, NextRunAt: ptr(r.DueAt), Repeat: r.Repeat})
	}
	for _, s := range ss {
		rep := s.Repeat
		out = append(out, LegacyItem{Source: "schedule", ID: s.ID, Title: s.Name, Enabled: s.Enabled, NextRunAt: ptr(s.NextRunAt), Repeat: &rep, LastStatus: s.LastStatus})
	}
	return out
}
