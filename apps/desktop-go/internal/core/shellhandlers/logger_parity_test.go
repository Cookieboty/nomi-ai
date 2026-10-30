package shellhandlers

import (
	"bytes"
	"encoding/json"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/diagnostics"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

var goldenNow = time.UnixMilli(1793268000123) // Date.UTC(2026, 9, 29, 10, 0, 0, 123)

type lineSink struct {
	stream string
	out    *[][2]string
}

func (s lineSink) Write(p []byte) (int, error) {
	for _, l := range strings.Split(strings.TrimSuffix(string(p), "\n"), "\n") {
		*s.out = append(*s.out, [2]string{s.stream, l})
	}
	return len(p), nil
}

func loadGoldenJSON(t *testing.T, name string, v any) {
	t.Helper()
	// CI 用本平台现场录制（NOMI_LIVE_GOLDENS），本地用提交的 golden
	p, _ := paritytest.Golden(t, name, filepath.Join("testdata", name))
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestLoggerParity(t *testing.T) {
	if time.Date(2026, 10, 29, 10, 0, 0, 123e6, time.UTC).UnixMilli() != goldenNow.UnixMilli() {
		t.Fatal("goldenNow")
	}
	var scs []struct {
		Name     string
		Packaged bool
		Env      map[string]string
		Files    [][2]any
		Ops      []json.RawMessage
		Console  [][2]string
		Results  []int
		After    map[string]struct {
			Text *string `json:"text"`
			Size *int64  `json:"size"`
		}
	}
	loadGoldenJSON(t, "shell_logger.json", &scs)
	if len(scs) < 5 {
		t.Fatal("too few scenarios")
	}
	for _, sc := range scs {
		dir := filepath.Join(t.TempDir(), sc.Name)
		os.MkdirAll(dir, 0o755)
		for _, f := range sc.Files {
			p := filepath.Join(dir, f[0].(string))
			os.WriteFile(p, nil, 0o644)
			os.Truncate(p, int64(f[1].(float64)))
		}
		var lines [][2]string
		l := services.NewLogger(services.LoggerOptions{
			LogDir: dir, Packaged: func() bool { return sc.Packaged }, Now: func() time.Time { return goldenNow },
			Stdout: lineSink{"stdout", &lines}, Stderr: lineSink{"stderr", &lines},
			Getenv: func(k string) string { return sc.Env[k] },
		})
		var results []int
		for _, raw := range sc.Ops {
			v, _ := util.Parse(raw)
			op := v.([]any)
			name := op[0].(string)
			switch name {
			case "setLevel":
				l.SetLevel(services.LogLevel(int(op[1].(float64))))
			case "getLevel":
				results = append(results, int(l.GetLevel()))
			default:
				lv := map[string]services.LogLevel{"error": services.ERROR, "warn": services.WARN, "info": services.INFO, "debug": services.DEBUG}[name]
				meta := services.Undefined
				ctx := ""
				if len(op) >= 3 {
					meta = op[2]
					if o, ok := meta.(*util.Obj); ok && o.Has("$undef") {
						meta = services.Undefined
					}
				}
				if len(op) >= 4 {
					ctx, _ = op[3].(string)
				}
				l.Log(lv, op[1].(string), meta, ctx)
			}
		}
		l.FlushSync()
		want := make([][2]string, 0, len(sc.Console))
		for _, c := range sc.Console {
			s := "stdout"
			if c[0] == "error" || c[0] == "warn" {
				s = "stderr"
			}
			want = append(want, [2]string{s, c[1]})
		}
		if !jsonEq(want, lines) {
			t.Errorf("%s console:\n got %v\nwant %v", sc.Name, lines, want)
		}
		if !jsonEq(sc.Results, results) && !(len(sc.Results) == 0 && len(results) == 0) {
			t.Errorf("%s results %v want %v", sc.Name, results, sc.Results)
		}
		ents, _ := os.ReadDir(dir)
		var names []string
		for _, e := range ents {
			names = append(names, e.Name())
		}
		sort.Strings(names)
		var wantNames []string
		for n := range sc.After {
			wantNames = append(wantNames, n)
		}
		sort.Strings(wantNames)
		if strings.Join(names, ",") != strings.Join(wantNames, ",") {
			t.Errorf("%s files %v want %v", sc.Name, names, wantNames)
		}
		for n, w := range sc.After {
			b, _ := os.ReadFile(filepath.Join(dir, n))
			if w.Size != nil && int64(len(b)) != *w.Size {
				t.Errorf("%s %s size %d want %d", sc.Name, n, len(b), *w.Size)
			}
			if w.Text != nil && string(b) != *w.Text {
				t.Errorf("%s %s:\n got %q\nwant %q", sc.Name, n, b, *w.Text)
			}
		}
	}
}

func jsonEq(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

type fakeTraceChild struct {
	pid   int
	stdin *nodeproc.Stdin
	out   []func(string)
	err   []func(string)
	close []func(*int, string)
}

func (c *fakeTraceChild) PID() int                     { return c.pid }
func (c *fakeTraceChild) ExitCode() *int               { return nil }
func (c *fakeTraceChild) Killed() bool                 { return false }
func (c *fakeTraceChild) Stdin() clisdk.StdinLike      { return c.stdin }
func (c *fakeTraceChild) OnStdout(f func(string))      { c.out = append(c.out, f) }
func (c *fakeTraceChild) OnStderr(f func(string))      { c.err = append(c.err, f) }
func (c *fakeTraceChild) OnClose(f func(*int, string)) { c.close = append(c.close, f) }
func (c *fakeTraceChild) OnError(func(error))          {}
func (c *fakeTraceChild) Kill(string) bool             { return false }

func TestCliTraceParity(t *testing.T) {
	var scs []struct {
		Name    string
		Enabled bool
		PreSize int64
		Ops     [][]any
		Day     string
		Text    *string
		Mode    *int
	}
	loadGoldenJSON(t, "shell_clitrace.json", &scs)
	if len(scs) < 6 {
		t.Fatal("too few scenarios")
	}
	for _, sc := range scs {
		dir := filepath.Join(t.TempDir(), "logs")
		f := filepath.Join(dir, "cli-"+sc.Day+".jsonl")
		if sc.PreSize > 0 {
			os.MkdirAll(dir, 0o755)
			os.WriteFile(f, nil, 0o644)
			os.Truncate(f, sc.PreSize)
		}
		on := sc.Enabled
		tr := diagnostics.NewCliTrace(dir, func() bool { return on })
		tr.Now = func() time.Time { return goldenNow }
		var ch *fakeTraceChild
		for _, op := range sc.Ops {
			switch op[0] {
			case "spawn":
				ch = &fakeTraceChild{pid: int(op[4].(float64)), stdin: &nodeproc.Stdin{}}
				var args []string
				for _, a := range op[2].([]any) {
					args = append(args, a.(string))
				}
				cmd := op[1].(string)
				tr.Tap(ch, cmd, args, op[3].(string))
			case "in":
				ch.stdin.Write(op[1].(string))
			case "out":
				for _, f := range ch.out {
					f(op[1].(string))
				}
			case "err":
				for _, f := range ch.err {
					f(op[1].(string))
				}
			case "close":
				var code *int
				if op[1] != nil {
					c := int(op[1].(float64))
					code = &c
				}
				sig, _ := op[2].(string)
				for _, f := range ch.close {
					f(code, sig)
				}
			case "enable":
				on = op[1].(bool)
			}
		}
		tr.Flush()
		tr.FlushSync()
		b, err := os.ReadFile(f)
		if sc.Text == nil {
			if err == nil {
				t.Errorf("%s: file should not exist", sc.Name)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", sc.Name, err)
			continue
		}
		got := string(b[sc.PreSize:])
		if got != *sc.Text {
			t.Errorf("%s:\n got %.600q\nwant %.600q", sc.Name, got, *sc.Text)
		}
		if sc.Mode != nil && runtime.GOOS != "windows" {
			st, _ := os.Stat(f)
			if int(st.Mode().Perm()) != *sc.Mode {
				t.Errorf("%s mode %o want %o", sc.Name, st.Mode().Perm(), *sc.Mode)
			}
		}
	}
}
