package desktop

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"
)

// 保留 30 天：更早的条目不列出，整月都更早的文件被删；offset 分页（同 journal.test.ts）
func TestAuditLogRetentionAndPaging(t *testing.T) {
	dir := t.TempDir()
	const day = 24 * 60 * 60 * 1000.0
	now := float64(time.Date(2026, 11, 3, 12, 0, 0, 0, time.Local).UnixMilli())
	log := NewAuditLog(dir, func() float64 { return now })
	add := func(tool string, ts float64) {
		log.Append(AuditEntry{Tool: tool, Decision: "auto", Result: "ok", Ts: ts}, map[string]any{})
	}
	add("old-file", now-90*day)
	add("old", now-31*day)
	for i := 4; i >= 0; i-- {
		add("t"+string(rune('0'+i)), now-float64(i)*day)
	}
	tools := func(rows []json.RawMessage) []string {
		out := []string{}
		for _, r := range rows {
			var e struct{ Tool string }
			_ = json.Unmarshal(r, &e)
			out = append(out, e.Tool)
		}
		return out
	}
	if got := tools(log.List(200, 0)); !slices.Equal(got, []string{"t0", "t1", "t2", "t3", "t4"}) {
		t.Fatalf("list = %v", got)
	}
	if got := tools(log.List(2, 2)); !slices.Equal(got, []string{"t2", "t3"}) {
		t.Fatalf("page 2 = %v", got)
	}
	if got := tools(log.List(2, 4)); !slices.Equal(got, []string{"t4"}) {
		t.Fatalf("page 3 = %v", got)
	}
	log.Rotate()
	ents, _ := os.ReadDir(dir)
	names := []string{}
	for _, e := range ents {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"desktop-2026-10.jsonl", "desktop-2026-11.jsonl"}) {
		t.Fatalf("after rotate = %v", names)
	}
}
