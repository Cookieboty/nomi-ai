package computer

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"path/filepath"
	"strings"
	"testing"
)

// identityEnv：QQ（com.tencent.qq）与备忘录正在运行；windows 是屏幕上的可见窗口
type identityEnv struct {
	calls   []string
	apps    []any
	windows []any
	failWin bool
}

func (e *identityEnv) service(t *testing.T) *Service {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 40, 20))
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	b64 := base64.StdEncoding.EncodeToString(buf.Bytes())
	s := New(Options{Resolve: func() string { return "/usr/bin/true" }, Getenv: func(string) string { return "" },
		ShotsDir: t.TempDir(), SettingsPath: filepath.Join(t.TempDir(), "computer.json"),
		Exec: func(_ context.Context, _ string, args []string, _ string) ([]byte, error) {
			e.calls = append(e.calls, strings.Join(args, " "))
			switch args[0] {
			case "list-apps":
				return env("list-apps", map[string]any{"apps": e.apps}), nil
			case "list-windows":
				if e.failWin {
					return errEnv("list-windows", "INTERNAL", "safe"), nil
				}
				return env("list-windows", e.windows), nil
			case "screenshot":
				return env("screenshot", map[string]any{"data": b64, "width": 40, "height": 20}), nil
			case "snapshot":
				app := args[len(args)-1]
				return env("snapshot", map[string]any{"app": app, "snapshot_id": "s1", "ref_count": 1, "complete": true,
					"tree": map[string]any{"role": "button", "name": "OK", "ref_id": "@s1:e1"}}), nil
			}
			return env(args[0], map[string]any{}), nil
		}})
	rules := []string{"com.tencent."}
	if _, err := s.UpdateSettings(SettingsPatch{BlockedApps: &rules}); err != nil {
		t.Fatal(err)
	}
	return s
}

func newIdentityEnv() *identityEnv {
	return &identityEnv{apps: []any{
		map[string]any{"name": "QQ", "bundle_id": "com.tencent.qq", "pid": 11, "presentation": "regular"},
		map[string]any{"name": "Notes", "bundle_id": "com.apple.Notes", "pid": 12, "presentation": "regular"},
	}}
}

func (e *identityEnv) reached(cmd string) bool {
	for _, c := range e.calls {
		if strings.HasPrefix(c, cmd+" ") || c == cmd {
			return true
		}
	}
	return false
}

// 只写了 bundle id 的禁用规则：按显示名读界面、按键、等待、截图都要拒绝
func TestBundleRuleAppliesToNamedCalls(t *testing.T) {
	e := newIdentityEnv()
	s := e.service(t)
	ctx := context.Background()
	if _, err := s.Snapshot(ctx, SnapshotOpts{App: "QQ"}); CodeOf(err) != "blocked_app" {
		t.Fatalf("snapshot: %v", err)
	}
	if _, err := s.Press(ctx, "qq", "cmd+n"); CodeOf(err) != "blocked_app" {
		t.Fatalf("press: %v", err)
	}
	if _, err := s.Wait(ctx, WaitOpts{App: "QQ", Text: "x"}); CodeOf(err) != "blocked_app" {
		t.Fatalf("wait: %v", err)
	}
	if _, err := s.Screenshot(ctx, "QQ"); CodeOf(err) != "blocked_app" {
		t.Fatalf("screenshot: %v", err)
	}
	// 名字不完全一样（agent-desktop 模糊匹配）也认
	if err := s.CheckApp(ctx, "Q"); CodeOf(err) != "blocked_app" {
		t.Fatalf("fuzzy: %v", err)
	}
	for _, cmd := range []string{"snapshot", "press", "wait", "screenshot"} {
		if e.reached(cmd) {
			t.Fatalf("%s reached agent-desktop: %v", cmd, e.calls)
		}
	}
	// 没禁用的照常
	if _, err := s.Snapshot(ctx, SnapshotOpts{App: "Notes"}); err != nil {
		t.Fatal(err)
	}
	info, _ := s.Ref("@s1:e1")
	if info.BundleID != "com.apple.Notes" {
		t.Fatalf("ref should keep the bundle id: %+v", info)
	}
}

// ref 背后的应用换了（同名的另一个应用）或身份查不到：不猜，拒绝
func TestRefRechecksIdentity(t *testing.T) {
	e := newIdentityEnv()
	s := e.service(t)
	ctx := context.Background()
	if _, err := s.Snapshot(ctx, SnapshotOpts{App: "Notes"}); err != nil {
		t.Fatal(err)
	}
	e.apps = []any{map[string]any{"name": "Notes", "bundle_id": "com.example.notes", "pid": 99}}
	s.apps = appsCache{}
	if _, err := s.Act(ctx, Action{Kind: "click", Ref: "@s1:e1"}); CodeOf(err) != "STALE_REF" {
		t.Fatalf("changed identity: %v", err)
	}
	if e.reached("click") {
		t.Fatal("click reached agent-desktop")
	}
}

// 整屏截图：屏幕上有禁用应用（名字或 bundle id）的可见窗口就拒绝，拿不到窗口列表也拒绝
func TestFullScreenRespectsBlockedWindows(t *testing.T) {
	ctx := context.Background()
	e := newIdentityEnv()
	e.windows = []any{map[string]any{"app_name": "Notes", "pid": 12}, map[string]any{"app_name": "QQ", "pid": 11}}
	s := e.service(t)
	if _, err := s.Screenshot(ctx, ""); CodeOf(err) != "blocked_app" {
		t.Fatalf("bundle-blocked window: %v", err)
	}
	e2 := newIdentityEnv()
	e2.windows = []any{map[string]any{"app_name": "1Password", "pid": 30}}
	if _, err := e2.service(t).Locate(ctx, "", "x", func(context.Context, string, []byte) (string, error) {
		t.Fatal("blocked screen must not reach the vision model")
		return "", nil
	}); CodeOf(err) != "blocked_app" {
		t.Fatalf("built-in blocked window: %v", err)
	}
	e3 := newIdentityEnv()
	e3.failWin = true
	if _, err := e3.service(t).Screenshot(ctx, ""); err == nil {
		t.Fatal("unknown windows must fail closed")
	}
	// 最小化 / 不可见的窗口不算
	e4 := newIdentityEnv()
	e4.windows = []any{map[string]any{"app_name": "Notes", "pid": 12}, map[string]any{"app_name": "QQ", "pid": 11, "minimized": true}}
	if _, err := e4.service(t).Screenshot(ctx, ""); err != nil {
		t.Fatal(err)
	}
	for _, x := range [][]string{e.calls, e2.calls, e3.calls} {
		for _, c := range x {
			if strings.HasPrefix(c, "screenshot") {
				t.Fatalf("screenshot taken: %v", x)
			}
		}
	}
}
