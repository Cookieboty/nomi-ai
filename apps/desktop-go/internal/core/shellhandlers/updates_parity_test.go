package shellhandlers

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/updates"
)

// fakeClock = record-shell.mjs 的假 setTimeout / setInterval / Date.now
type fakeTimer struct {
	c      *fakeClock
	id, at int64
	every  int64
	fn     func()
}

func (t *fakeTimer) Stop() {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	for i, x := range t.c.timers {
		if x == t {
			t.c.timers = append(t.c.timers[:i], t.c.timers[i+1:]...)
			return
		}
	}
}

type fakeClock struct {
	mu     sync.Mutex
	now    int64
	seq    int64
	timers []*fakeTimer
}

func (c *fakeClock) Now() int64 { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) add(ms, every int64, f func()) updates.Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	t := &fakeTimer{c: c, id: c.seq, at: c.now + ms, every: every, fn: f}
	c.timers = append(c.timers, t)
	return t
}
func (c *fakeClock) AfterFunc(ms int64, f func()) updates.Timer { return c.add(ms, 0, f) }
func (c *fakeClock) Every(ms int64, f func()) updates.Timer     { return c.add(ms, ms, f) }

func (c *fakeClock) advance(ms int64) int {
	c.mu.Lock()
	end := c.now + ms
	for {
		sort.SliceStable(c.timers, func(i, j int) bool {
			a, b := c.timers[i], c.timers[j]
			return a.at < b.at || (a.at == b.at && a.id < b.id)
		})
		if len(c.timers) == 0 || c.timers[0].at > end {
			break
		}
		t := c.timers[0]
		c.now = t.at
		if t.every > 0 {
			t.at += t.every
		} else {
			c.timers = c.timers[1:]
		}
		c.mu.Unlock()
		t.fn()
		c.mu.Lock()
	}
	c.now = end
	n := len(c.timers)
	c.mu.Unlock()
	return n
}

type updBehavior struct {
	Emit     [][]json.RawMessage `json:"emit"`
	Ret      string              `json:"ret"`
	Throw    *string             `json:"throw"`
	ThrowStr *string             `json:"throwStr"`
	Code     string              `json:"code"`
}

func (b *updBehavior) err() error {
	if b.ThrowStr != nil {
		return errors.New(*b.ThrowStr)
	}
	if b.Throw != nil {
		if b.Code != "" {
			return &updates.CodedError{Code: b.Code, Msg: *b.Throw}
		}
		return errors.New(*b.Throw)
	}
	return nil
}

type fakeUpdater struct {
	ev                updates.UpdaterEvents
	cfg               []bool
	log               updates.Logger
	checks, downloads []json.RawMessage
	cancelThrows      bool
	installThrows     string
	calls             []any
	tok               int
}

func (f *fakeUpdater) Configure(a, b, c bool, l updates.Logger) { f.cfg, f.log = []bool{a, b, c}, l }
func (f *fakeUpdater) On(ev updates.UpdaterEvents)              { f.ev = ev }
func (f *fakeUpdater) RemoveAllListeners() {
	f.calls = append(f.calls, []any{"removeAllListeners"})
	f.ev = updates.UpdaterEvents{}
}

func info(raw json.RawMessage) updates.UpdateInfo {
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	i := updates.UpdateInfo{}
	_ = json.Unmarshal(m["version"], &i.Version)
	if r, ok := m["releaseName"]; ok {
		var s *string
		_ = json.Unmarshal(r, &s)
		i.ReleaseName = updates.Opt{Set: true, V: s}
	}
	if r, ok := m["releaseNotes"]; ok {
		i.ReleaseNotes = rawAny(r)
	}
	return i
}

func (f *fakeUpdater) fire(ev string, arg json.RawMessage) {
	switch ev {
	case "checking-for-update":
		if f.ev.CheckingForUpdate != nil {
			f.ev.CheckingForUpdate()
		}
	case "update-available":
		if f.ev.UpdateAvailable != nil {
			f.ev.UpdateAvailable(info(arg))
		}
	case "update-not-available":
		if f.ev.UpdateNotAvailable != nil {
			f.ev.UpdateNotAvailable()
		}
	case "download-progress":
		var p struct{ Percent, BytesPerSecond, Transferred, Total float64 }
		_ = json.Unmarshal(arg, &p)
		if f.ev.DownloadProgress != nil {
			f.ev.DownloadProgress(updates.ProgressInfo{Percent: p.Percent, BytesPerSecond: p.BytesPerSecond, Transferred: p.Transferred, Total: p.Total})
		}
	case "update-downloaded":
		if f.ev.UpdateDownloaded != nil {
			f.ev.UpdateDownloaded(info(arg))
		}
	case "error":
		var b updBehavior
		_ = json.Unmarshal(arg, &b)
		if f.ev.Error != nil {
			f.ev.Error(b.err())
		}
	}
}

func (f *fakeUpdater) CheckForUpdates() (*updates.CheckResult, error) {
	f.calls = append(f.calls, []any{"checkForUpdates"})
	b := updBehavior{Ret: "null"}
	if len(f.checks) > 0 {
		_ = json.Unmarshal(f.checks[0], &b)
		f.checks = f.checks[1:]
	}
	for _, e := range b.Emit {
		var name string
		_ = json.Unmarshal(e[0], &name)
		var arg json.RawMessage
		if len(e) > 1 {
			arg = e[1]
		}
		f.fire(name, arg)
	}
	if err := b.err(); err != nil {
		return nil, err
	}
	if b.Ret == "null" {
		return nil, nil
	}
	f.tok++
	id := f.tok
	r := &updates.CheckResult{Info: updates.UpdateInfo{Version: "2.0.6"}}
	if b.Ret == "token" {
		r.Cancel = func() {
			f.calls = append(f.calls, []any{"cancel", id})
			if f.cancelThrows {
				panic("done")
			}
		}
	}
	return r, nil
}

func (f *fakeUpdater) DownloadUpdate() error {
	f.calls = append(f.calls, []any{"downloadUpdate"})
	if len(f.downloads) > 0 {
		var s string
		d := f.downloads[0]
		f.downloads = f.downloads[1:]
		if json.Unmarshal(d, &s) == nil && s == "ok" {
			return nil
		}
		var b updBehavior
		_ = json.Unmarshal(d, &b)
		return b.err()
	}
	return nil
}

func (f *fakeUpdater) QuitAndInstall(a, b bool) error {
	f.calls = append(f.calls, []any{"quitAndInstall", a, b})
	if f.installThrows != "" {
		return errors.New(f.installThrows)
	}
	return nil
}

type recLogger struct {
	mu   sync.Mutex
	logs []any
}

func (l *recLogger) add(level, msg string, kv []any) {
	var meta any
	if len(kv) > 0 {
		m := map[string]any{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i].(string)] = kv[i+1]
		}
		meta = m
	}
	l.mu.Lock()
	l.logs = append(l.logs, []any{level, msg, meta})
	l.mu.Unlock()
}
func (l *recLogger) Info(m string, kv ...any)  { l.add("info", m, kv) }
func (l *recLogger) Warn(m string, kv ...any)  { l.add("warn", m, kv) }
func (l *recLogger) Error(m string, kv ...any) { l.add("error", m, kv) }
func (l *recLogger) Debug(m string, kv ...any) { l.add("debug", m, kv) }

type updStep struct {
	Op     string          `json:"op"`
	Arg    json.RawMessage `json:"arg"`
	Arg2   json.RawMessage `json:"arg2"`
	OK     json.RawMessage `json:"ok"`
	Err    json.RawMessage `json:"err"`
	Events json.RawMessage `json:"events"`
	Calls  json.RawMessage `json:"calls"`
	Logs   json.RawMessage `json:"logs"`
}

// callProc：经 contract.Router 的会话调一个过程（与渲染侧同路径）
func callProc(t *testing.T, r *contract.Router, name string, input json.RawMessage) (any, *contract.ErrorPayload) {
	t.Helper()
	ch := make(chan contract.ServerFrame, 1)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat", ID: 1}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	fr, _ := json.Marshal(contract.ClientFrame{T: "req", ID: "1", Kind: "call", Name: name, Input: input})
	s.Handle(fr)
	f := <-ch
	return f.Output, f.Error
}

func TestUpdatesParity(t *testing.T) {
	var g struct {
		Now       int64 `json:"now"`
		Scenarios []struct {
			Name          string            `json:"name"`
			Packaged      bool              `json:"packaged"`
			File          *string           `json:"file"`
			SettingsFile  *string           `json:"settingsFile"`
			LaunchDelayMs *int64            `json:"launchDelayMs"`
			IntervalMs    *int64            `json:"intervalMs"`
			StallMs       *int64            `json:"stallMs"`
			Checks        []json.RawMessage `json:"checks"`
			Downloads     []json.RawMessage `json:"downloads"`
			CancelThrows  bool              `json:"cancelThrows"`
			InstallThrows string            `json:"installThrows"`
			Log           []updStep         `json:"log"`
		} `json:"scenarios"`
	}
	loadGolden(t, "shell_updates.json", &g)
	if len(g.Scenarios) == 0 {
		t.Fatal("empty golden")
	}
	sb, _ := filepath.EvalSymlinks(t.TempDir())
	n := 0
	for _, sc := range g.Scenarios {
		ud := filepath.Join(sb, "upd", sc.Name)
		_ = os.MkdirAll(ud, 0o755)
		_ = os.WriteFile(filepath.Join(ud, "blocker"), []byte("x"), 0o644)
		if sc.File != nil {
			_ = os.WriteFile(filepath.Join(ud, "update-settings.json"), []byte(*sc.File), 0o644)
		}
		var sf *string
		switch {
		case sc.SettingsFile == nil:
			sf = new(string) // null = 不落盘
		case *sc.SettingsFile != "":
			p := filepath.Join(ud, *sc.SettingsFile)
			sf = &p
		}
		clock := &fakeClock{now: g.Now}
		fu := &fakeUpdater{checks: sc.Checks, downloads: sc.Downloads, cancelThrows: sc.CancelThrows, installThrows: sc.InstallThrows}
		lg := &recLogger{}
		var evMu sync.Mutex
		events := []any{}
		svc := updates.New(lg, updates.Options{
			Version: func() string { return "2.0.5" }, Packaged: sc.Packaged, Updater: fu, Clock: clock,
			UserData: ud, SettingsFile: sf,
			LaunchDelayMs: sc.LaunchDelayMs, IntervalMs: sc.IntervalMs, StallMs: sc.StallMs,
			Publish: func(e string, p any) { evMu.Lock(); events = append(events, []any{e, p}); evMu.Unlock() },
		})
		r := contract.NewRouter()
		InstallUpdates(r, func() *updates.Service { return svc })
		for i, st := range sc.Log {
			events, fu.calls, lg.logs = []any{}, nil, nil
			var res any
			var perr *contract.ErrorPayload
			switch st.Op {
			case "start":
				svc.Start()
			case "stop":
				svc.Stop()
			case "emit":
				var name string
				_ = json.Unmarshal(st.Arg, &name)
				fu.fire(name, st.Arg2)
			case "ulog":
				fu.log.Info("i")
				fu.log.Warn("w")
				fu.log.Error("e")
				fu.log.Debug("d")
				res = fu.cfg
			case "file":
				svc.WaitPersisted()
				if b, err := os.ReadFile(filepath.Join(ud, "update-settings.json")); err == nil {
					res = string(b)
				}
			case "advance":
				ms, _ := strconv.ParseInt(string(st.Arg), 10, 64)
				res = clock.advance(ms)
			default:
				in := st.Arg
				if st.Op != "setAutoCheck" {
					in = json.RawMessage("null")
				}
				res, perr = callProc(t, r, "updates."+st.Op, in)
			}
			svc.WaitPersisted()
			var gotErr any
			if perr != nil {
				gotErr = map[string]any{"code": perr.Code, "message": perr.Message}
				res = nil
			}
			calls := fu.calls
			if calls == nil {
				calls = []any{}
			}
			logs := lg.logs
			if logs == nil {
				logs = []any{}
			}
			got := map[string]any{"ok": normJSON(t, res, sb), "err": normJSON(t, gotErr, sb), "events": normJSON(t, events, sb), "calls": normJSON(t, calls, sb), "logs": normJSON(t, logs, sb)}
			want := map[string]any{"ok": rawAny(st.OK), "err": rawAny(st.Err), "events": rawAny(st.Events), "calls": rawAny(st.Calls), "logs": rawAny(st.Logs)}
			if !reflect.DeepEqual(got, want) {
				gb, _ := json.Marshal(got)
				wb, _ := json.Marshal(want)
				t.Fatalf("%s step %d (%s):\n got %s\nwant %s", sc.Name, i, st.Op, gb, wb)
			}
			n++
		}
		svc.Stop()
	}
	t.Logf("updates: %d scenarios, %d steps", len(g.Scenarios), n)
}
