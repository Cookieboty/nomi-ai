package computer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

func TestSettingsSanitizeAndPersist(t *testing.T) {
	p := filepath.Join(t.TempDir(), "computer.json")
	s := New(Options{SettingsPath: p})
	apps := []string{" Slack ", "slack", "", "WeChat"}
	sb, vm := "bad name;rm", "no-slash"
	st, err := s.UpdateSettings(SettingsPatch{BlockedApps: &apps, Sandbox: &sb, VisionModel: &vm})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(st.BlockedApps, ",") != "Slack,WeChat" || st.Sandbox != "" || st.VisionModel != "" {
		t.Fatalf("%+v", st)
	}
	again := New(Options{SettingsPath: p})
	if strings.Join(again.Settings().BlockedApps, ",") != "Slack,WeChat" {
		t.Fatal("settings should persist")
	}
	if again.Blocked("slack", "") == "" || again.Blocked("Notes", "") != "" {
		t.Fatal("user block list")
	}
}

func TestSandboxRoutesDesktopCommandsOnly(t *testing.T) {
	f := &fake{}
	s := newTest(f)
	sb := "vm1"
	if _, err := s.UpdateSettings(SettingsPatch{Sandbox: &sb}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Snapshot(context.Background(), SnapshotOpts{App: "Notes"}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls[0].args, " "); got != "sandbox exec vm1 -- snapshot -i --compact --app Notes" {
		t.Fatal(got)
	}
	// 隔离模式下文字也走 stdin，不进进程参数
	if _, err := s.Act(context.Background(), Action{Kind: "type", Ref: "@sx:e1", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	last := f.calls[len(f.calls)-1]
	if strings.Join(last.args, " ") != "sandbox exec vm1 -- type @sx:e1 --stdin" || last.stdin != "hi" {
		t.Fatalf("%+v", last)
	}
	// 版本、沙箱管理在这台电脑上执行
	s.InstalledVersion(context.Background())
	if got := strings.Join(f.calls[len(f.calls)-1].args, " "); got != "version" {
		t.Fatal(got)
	}
}

func TestRedactInputs(t *testing.T) {
	var b strings.Builder
	n := node{Role: "window", Children: []node{
		{Role: "textfield", Name: "To", Value: json.RawMessage(`"alice@example.com"`), Ref: "@s:e1"},
		{Role: "button", Name: "Send", Ref: "@s:e2"},
	}}
	walk(n, 0, &b, true, func(node) {})
	out := b.String()
	if strings.Contains(out, "alice") || !strings.Contains(out, "已隐去 17 字") || !strings.Contains(out, `button "Send"`) {
		t.Fatal(out)
	}
}

func TestStopAllStopsThatTurnUntilNextMessage(t *testing.T) {
	started := make(chan struct{})
	s := New(Options{Resolve: func() string { return "/usr/bin/true" }, Getenv: func(string) string { return "" },
		Exec: func(ctx context.Context, _ string, args []string, _ string) ([]byte, error) {
			if args[0] == "wait" {
				close(started)
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return []byte(`{"version":"2.6","ok":true,"command":"x","data":{}}`), nil
		}})
	activity := make(chan []string, 8)
	s.OnActivity(func() { activity <- s.Active() })
	turn, cancel := context.WithCancel(tools.WithConversation(context.Background(), "conv-1"))
	defer cancel()
	turn = WithActor(turn, "Nomi")
	done := make(chan error, 1)
	go func() {
		_, err := s.Wait(turn, WaitOpts{Text: "x", App: "Notes", TimeoutMs: 60_000})
		done <- err
	}()
	<-started
	if a := <-activity; strings.Join(a, ",") != "Nomi" {
		t.Fatalf("active %v", a)
	}
	rep := s.StopAll()
	if strings.Join(rep.Conversations, ",") != "conv-1" {
		t.Fatalf("report %+v", rep)
	}
	select {
	case err := <-done:
		if CodeOf(err) != "stopped" {
			t.Fatalf("in-flight call should end as stopped: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not cancel the in-flight call")
	}
	// 同一轮之后的调用一直拒绝（不是只停 10 秒）
	if _, err := s.ListApps(turn); CodeOf(err) != "stopped" || !s.StoppedFor(turn) {
		t.Fatalf("same turn after stop: %v", err)
	}
	// 用户发了新消息 = 新的一轮：可以继续
	next, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	if _, err := s.ListApps(next); err != nil || s.StoppedFor(next) {
		t.Fatalf("new turn: %v", err)
	}
	if len(s.Active()) != 1 {
		t.Fatalf("active %v", s.Active())
	}
}

func TestParseLocate(t *testing.T) {
	x, y, _, _, ok := parseLocate("sure: {\"found\":true,\"x\":10,\"y\":20}", 100, 100)
	if !ok || x != 10 || y != 20 {
		t.Fatal("xy")
	}
	x, y, _, _, ok = parseLocate(`{"bbox":[10,10,30,50]}`, 100, 100)
	if !ok || x != 20 || y != 30 {
		t.Fatal("bbox center")
	}
	if _, _, _, _, ok = parseLocate(`{"found":true,"x":500,"y":5}`, 100, 100); ok {
		t.Fatal("outside the image")
	}
	if _, _, _, note, ok := parseLocate(`{"found":false,"note":"not there"}`, 100, 100); ok || note != "not there" {
		t.Fatal("not found")
	}
}

func TestLocateScreenCoordinates(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 3200, 2000))
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	b64 := base64.StdEncoding.EncodeToString(buf.Bytes())
	s := New(Options{Resolve: func() string { return "/usr/bin/true" }, Getenv: func(string) string { return "" }, ShotsDir: t.TempDir(),
		Exec: func(_ context.Context, _ string, args []string, _ string) ([]byte, error) {
			d, _ := json.Marshal(map[string]any{"version": "2.6", "ok": true, "command": args[0],
				"data": map[string]any{"data": b64, "width": 3200, "height": 2000, "scale_factor": 2}})
			return d, nil
		}})
	var gotW, gotH int
	ask := func(_ context.Context, prompt string, p []byte) (string, error) {
		im, _ := png.Decode(bytes.NewReader(p))
		gotW, gotH = im.Bounds().Dx(), im.Bounds().Dy()
		return `{"found":true,"x":800,"y":500}`, nil
	}
	r, err := s.Locate(context.Background(), "", "center", ask)
	if err != nil {
		t.Fatal(err)
	}
	// 3200x2000 缩到 1600x1000 给模型；(800,500) → 原图 (1600,1000) → 2 倍屏 (800,500) 点
	if gotW != 1600 || gotH != 1000 || !r.Found || r.X != 800 || r.Y != 500 {
		t.Fatalf("sent %dx%d, got %+v", gotW, gotH, r)
	}
}

func TestCliEnabledDefaultsOn(t *testing.T) {
	p := filepath.Join(t.TempDir(), "computer.json")
	if !New(Options{SettingsPath: p}).Settings().CliEnabled {
		t.Fatal("default on without a settings file")
	}
	off := false
	_, _ = New(Options{SettingsPath: p}).UpdateSettings(SettingsPatch{CliEnabled: &off})
	if New(Options{SettingsPath: p}).Settings().CliEnabled {
		t.Fatal("an explicit off must be kept")
	}
}
