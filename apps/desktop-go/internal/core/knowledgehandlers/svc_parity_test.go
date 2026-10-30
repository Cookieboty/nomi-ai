package knowledgehandlers

// 批次 8 服务级往返 golden：scripts/parity/record-b8-svc.mjs（Node，TZ=Asia/Shanghai）录制。
// 同一调用序列在 Go 的 memory / schedule 服务上回放，逐步比对返回值、事件、审计、提示词与落盘 JSON。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/memory"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

type svcTrace struct {
	clock   int64
	seq     int
	events  []any
	prompts []any
	replies []string
	desk    *deps.NoopDesktop
}

func (h *svcTrace) now() int64               { return h.clock }
func (h *svcTrace) newID() string            { h.seq++; return fmt.Sprintf("id-%d", h.seq) }
func (h *svcTrace) publish(ch string, p any) { h.events = append(h.events, []any{ch, p}) }
func (h *svcTrace) complete(_ context.Context, m []deps.Msg) (string, error) {
	h.prompts = append(h.prompts, m)
	if len(h.replies) == 0 {
		return "", nil
	}
	r := h.replies[0]
	h.replies = h.replies[1:]
	return r, nil
}

func jnorm(t *testing.T, v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var o any
	_ = json.Unmarshal(b, &o)
	return o
}

func step(t *testing.T, v any, err error) any {
	if err != nil {
		var me *memory.MemError
		var se *schedule.SchedError
		switch {
		case errors.As(err, &me):
			return map[string]any{"err": me.Code, "msg": me.Msg}
		case errors.As(err, &se):
			return map[string]any{"err": se.Code, "msg": se.Msg}
		}
		return map[string]any{"err": "Error", "msg": err.Error()}
	}
	return map[string]any{"out": jnorm(t, v)}
}

func readJSON(dir, n string) any {
	b, err := os.ReadFile(filepath.Join(dir, n))
	if err != nil {
		return nil
	}
	var o any
	_ = json.Unmarshal(b, &o)
	return o
}

func compareSvc(t *testing.T, name string, want map[string]any, h *svcTrace, steps []any, files map[string]any) {
	audits := []any{}
	for _, a := range h.desk.Audits {
		a.Ms = nil
		audits = append(audits, jnorm(t, a))
	}
	notices := []any{}
	for _, n := range h.desk.Notices {
		notices = append(notices, jnorm(t, n))
	}
	got := map[string]any{
		"steps": steps, "files": files, "events": jnorm(t, h.events), "audits": audits,
		"notices": notices, "prompts": jnorm(t, h.prompts), "flushed": float64(h.desk.Flushed),
	}
	for k, w := range want {
		g := got[k]
		if k == "steps" {
			ws := w.([]any)
			for i := range ws {
				if i >= len(steps) || !reflect.DeepEqual(ws[i], steps[i]) {
					gb, _ := json.Marshal(steps[min(i, len(steps)-1)])
					wb, _ := json.Marshal(ws[i])
					t.Errorf("%s step %d:\n got  %s\n want %s", name, i, gb, wb)
				}
			}
			continue
		}
		if !reflect.DeepEqual(jnorm(t, g), w) {
			gb, _ := json.Marshal(g)
			wb, _ := json.Marshal(w)
			t.Errorf("%s %s:\n got  %s\n want %s", name, k, gb, wb)
		}
	}
}

func TestServiceRoundTripParityB8(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		paritytest.SkipOrFail(t, "tzdata missing")
	}
	old := time.Local
	time.Local = loc
	defer func() { time.Local = old }()
	b, err := os.ReadFile("testdata/parity-b8-svc.json")
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]map[string]any
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	t0 := time.Date(2026, 10, 29, 9, 30, 0, 0, loc).UnixMilli()

	t.Run("memory", func(t *testing.T) {
		dir := t.TempDir()
		h := &svcTrace{clock: t0, desk: &deps.NoopDesktop{}, replies: []string{
			`好的 {"title":"周末计划","summary":"用户打算周末去爬山，并询问了天气。","keywords":["爬山","天气","爬山"],"facts":[{"kind":"preference","text":"喜欢爬山"},{"kind":"bogus","text":"住在杭州"},{"text":"api key sk-abcdefghijklmnopqrstuv"}]}`,
			`not json`,
			`{"summary":"更新后的摘要","facts":[{"kind":"preference","text":"喜欢爬山"}]}`,
		}}
		s := memory.New(memory.Deps{Root: dir, Logger: deps.StdLogger{}, Desktop: h.desk, Complete: h.complete,
			Ports: &deps.NoopPorts{}, Events: deps.EventsFunc(h.publish), T: i18n.T, Now: h.now, NewID: h.newID})
		msgs := []memory.TurnMsg{{Role: "user", Content: "周末去爬山怎么样"}, {Role: "assistant", Content: "好主意，记得看天气"}, {Role: "system", Content: "x"}, {Role: "user", Content: "  "}}
		var st []any
		add := func(v any, err error) { st = append(st, step(t, v, err)) }
		add(s.Settings(), nil)
		add(s.SetSettings(map[string]any{"minMessages": 2.0, "bogus": 1.0, "enabled": "yes"}), nil)
		add(s.SetPersona("# 我\n喜欢简洁"))
		add(s.Persona(), nil)
		add(s.Ingest(ctx, "c1", msgs[:1], false))
		h.clock += 1000
		add(s.Ingest(ctx, "c1", msgs, false))
		add(s.Ingest(ctx, "c1", msgs, false))
		add(s.Ingest(ctx, "c2", msgs, true))
		h.clock += 1000
		add(s.Ingest(ctx, "c1", append(append([]memory.TurnMsg{}, msgs...), memory.TurnMsg{Role: "user", Content: "再说一句"}, memory.TurnMsg{Role: "assistant", Content: "好"}), false))
		add(s.UpsertFact(ctx, map[string]any{"text": "  喝美式  ", "kind": "preference"}))
		add(s.UpsertFact(ctx, map[string]any{"text": ""}))
		h.clock += 1000
		add(s.UpsertFact(ctx, map[string]any{"id": "id-3", "text": "喜欢徒步", "kind": "nope"}))
		add(s.UpdateEpisode(ctx, "id-1", map[string]any{"title": "新标题", "pinned": true, "keywords": []any{"a", "a", "b"}}))
		add(s.UpdateEpisode(ctx, "missing", map[string]any{}))
		add(s.List(""), nil)
		add(s.List("美式"), nil)
		add(s.Remove("fact", "id-4"), nil)
		add(s.Remove("fact", "nope"), nil)
		add(s.State(), nil)
		add(s.ExportData(), nil)
		s.Flush()
		files := map[string]any{"memory.json": readJSON(dir, "memory.json"), "settings.json": readJSON(dir, "settings.json")}
		add(s.ClearAll(), nil)
		s.Flush()
		files["memory.json#cleared"] = readJSON(dir, "memory.json")
		compareSvc(t, "memory", want["memory"], h, st, files)
	})

	t.Run("schedule", func(t *testing.T) {
		dir := t.TempDir()
		h := &svcTrace{clock: t0, desk: &deps.NoopDesktop{}, replies: []string{"  晨报：今天晴。  ", ""}}
		s := schedule.New(schedule.Deps{Root: dir, Logger: deps.StdLogger{}, Desktop: h.desk, Complete: h.complete,
			Memory: func(context.Context, string) (string, error) { return "", nil }, OpenChat: func() {},
			Now: h.now, Ports: &deps.NoopPorts{}, Events: deps.EventsFunc(h.publish), T: i18n.T, NewID: h.newID})
		var st []any
		add := func(v any, err error) { st = append(st, step(t, v, err)) }
		add(s.Settings(), nil)
		add(s.UpsertTask(map[string]any{"name": "晨报", "prompt": "总结今天", "time": "08:00", "repeat": map[string]any{"kind": "weekdays"}}))
		add(s.UpsertTask(map[string]any{"name": "", "prompt": "x", "time": "25:00", "repeat": map[string]any{"kind": "daily"}}))
		add(s.UpsertTask(map[string]any{"name": "喝水", "prompt": "提醒喝水", "time": "10:00", "repeat": map[string]any{"kind": "interval", "minutes": 1.0}}))
		add(s.UpsertTask(map[string]any{"name": "坏", "prompt": "p", "time": "10:00", "repeat": map[string]any{"kind": "zzz"}}))
		h.clock += 60_000
		add(s.UpsertTask(map[string]any{"id": "id-1", "name": "晨报2", "prompt": "总结今天", "time": "07:30", "repeat": map[string]any{"kind": "weekly", "days": []any{5.0, 1.0}}, "enabled": true}))
		add(s.SetTaskEnabled("id-2", false), nil)
		add(s.SetTaskEnabled("nope", true), nil)
		add(s.SetSettings(map[string]any{"quiet": map[string]any{"enabled": true, "start": "09:00", "end": "10:00"}, "proactive": map[string]any{"enabled": true, "perDay": 99.0}}), nil)
		add(s.RunTask(ctx, "id-1", schedule.RunOpts{Manual: true}))
		add(s.SetSettings(map[string]any{"quiet": map[string]any{"enabled": false}}), nil)
		h.clock += 60_000
		add(s.RunTask(ctx, "id-2", schedule.RunOpts{}))
		add(s.RunTask(ctx, "nope", schedule.RunOpts{}))
		add(s.Tasks(), nil)
		add(s.Results(), nil)
		add(s.State(), nil)
		add(s.RemoveTask("id-2"), nil)
		add(s.RemoveTask("id-2"), nil)
		files := map[string]any{"schedule.json": readJSON(dir, "schedule.json")}
		add(s.ClearResults(), nil)
		files["schedule.json#cleared"] = readJSON(dir, "schedule.json")
		compareSvc(t, "schedule", want["schedule"], h, st, files)
	})
}
