package computer

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type call struct {
	args  []string
	stdin string
}

// fake：按命令名返回 envelope；snapshot 每次换一个 snapshot id
type fake struct {
	calls  []call
	snaps  int
	staleN int // click 前 staleN 次返回 STALE_REF
	retry  string
}

func env(cmd string, data any) []byte {
	b, _ := json.Marshal(map[string]any{"version": "2.6", "ok": true, "command": cmd, "data": data})
	return b
}

func errEnv(cmd, code, retry string) []byte {
	b, _ := json.Marshal(map[string]any{"version": "2.6", "ok": false, "command": cmd,
		"error": map[string]any{"code": code, "message": code, "disposition": map[string]any{"retry": retry, "delivery": "not_delivered"}}})
	return b
}

func (f *fake) exec(_ context.Context, _ string, args []string, stdin string) ([]byte, error) {
	f.calls = append(f.calls, call{args, stdin})
	if len(args) > 4 && args[0] == "sandbox" && args[1] == "exec" {
		args = args[4:]
	}
	switch args[0] {
	case "snapshot":
		f.snaps++
		id := "s" + strings.Repeat("x", f.snaps)
		app := "Notes"
		for i, a := range args {
			if a == "--app" {
				app = args[i+1]
			}
		}
		return env("snapshot", map[string]any{"app": app, "snapshot_id": id, "ref_count": 3, "complete": true,
			"tree": map[string]any{"role": "window", "name": "Notes", "children": []any{
				map[string]any{"role": "group", "children": []any{
					map[string]any{"role": "button", "name": "New Note", "ref_id": "@" + id + ":e1"},
					map[string]any{"role": "button", "name": "Send", "ref_id": "@" + id + ":e2"},
				}},
				map[string]any{"role": "AXSecureTextField", "name": "Password", "value": "hunter2", "ref_id": "@" + id + ":e3"},
			}}}), nil
	case "click":
		if f.staleN > 0 {
			f.staleN--
			return errEnv("click", "STALE_REF", f.retry), nil
		}
		return env("click", map[string]any{"ok": true}), nil
	}
	return env(args[0], map[string]any{}), nil
}

func newTest(f *fake) *Service {
	return New(Options{Resolve: func() string { return "/usr/bin/true" }, Exec: f.exec,
		Self: func(n, _ string) bool { return n == "Nomi" }, Getenv: func(string) string { return "" }})
}

func TestSnapshotOutlineAndRefs(t *testing.T) {
	f := &fake{}
	s := newTest(f)
	snap, err := s.Snapshot(context.Background(), SnapshotOpts{App: "Notes"})
	if err != nil {
		t.Fatal(err)
	}
	want := "window \"Notes\"\n  button \"New Note\" [@sx:e1]\n  button \"Send\" [@sx:e2]\n  AXSecureTextField \"Password\" =\"***\" [@sx:e3]\n"
	if snap.Outline != want {
		t.Fatalf("outline:\n%s\nwant:\n%s", snap.Outline, want)
	}
	if strings.Contains(snap.Outline, "hunter2") {
		t.Fatal("password value leaked")
	}
	info, ok := s.Ref("@sx:e2")
	if !ok || info.App != "Notes" || info.Name != "Send" || info.Role != "button" {
		t.Fatalf("ref info %+v %v", info, ok)
	}
	if got := f.calls[0].args; strings.Join(got, " ") != "snapshot -i --compact --app Notes" {
		t.Fatalf("args %v", got)
	}
}

func TestSnapshotBlocked(t *testing.T) {
	f := &fake{}
	s := newTest(f)
	for _, app := range []string{"1Password 8", "Keychain Access", "钥匙串访问", "Nomi", "招商银行"} {
		if _, err := s.Snapshot(context.Background(), SnapshotOpts{App: app}); CodeOf(err) != "blocked_app" {
			t.Fatalf("%s: %v", app, err)
		}
	}
	if len(f.calls) != 0 {
		t.Fatalf("blocked app reached agent-desktop: %v", f.calls)
	}
}

func TestActTypeUsesStdin(t *testing.T) {
	f := &fake{}
	s := newTest(f)
	if _, err := s.Snapshot(context.Background(), SnapshotOpts{App: "Notes"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Act(context.Background(), Action{Kind: "type", Ref: "@sx:e1", Text: "secret text"}); err != nil {
		t.Fatal(err)
	}
	c := f.calls[len(f.calls)-1]
	if c.stdin != "secret text" || strings.Contains(strings.Join(c.args, " "), "secret") {
		t.Fatalf("text must go through stdin: %+v", c)
	}
}

func TestActUnknownRef(t *testing.T) {
	s := newTest(&fake{})
	if _, err := s.Act(context.Background(), Action{Kind: "click", Ref: "@zz:e1"}); CodeOf(err) != "unknown_ref" {
		t.Fatal(err)
	}
}

func TestActStaleRefRelocates(t *testing.T) {
	f := &fake{staleN: 1, retry: "safe"}
	s := newTest(f)
	if _, err := s.Snapshot(context.Background(), SnapshotOpts{App: "Notes"}); err != nil {
		t.Fatal(err)
	}
	r, err := s.Act(context.Background(), Action{Kind: "click", Ref: "@sx:e1"})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Retried || r.Ref != "@sxx:e1" {
		t.Fatalf("want relocated to @sxx:e1, got %+v", r)
	}
}

func TestActStaleRefUnsafeNoRetry(t *testing.T) {
	f := &fake{staleN: 1, retry: "unsafe"}
	s := newTest(f)
	_, _ = s.Snapshot(context.Background(), SnapshotOpts{App: "Notes"})
	if _, err := s.Act(context.Background(), Action{Kind: "click", Ref: "@sx:e1"}); CodeOf(err) != "STALE_REF" {
		t.Fatal(err)
	}
	if f.snaps != 1 {
		t.Fatal("must not re-snapshot when retry is unsafe")
	}
}

func TestPressAlwaysTargetsApp(t *testing.T) {
	f := &fake{}
	s := newTest(f)
	if _, err := s.Press(context.Background(), "Notes", "cmd+s"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls[0].args, " "); got != "press cmd+s --app Notes" {
		t.Fatal(got)
	}
}

func TestRefCacheEviction(t *testing.T) {
	f := &fake{}
	s := newTest(f)
	for range keepSnapshots + 1 {
		_, _ = s.Snapshot(context.Background(), SnapshotOpts{App: "Notes"})
	}
	if _, ok := s.Ref("@sx:e1"); ok {
		t.Fatal("oldest snapshot refs should be evicted")
	}
	if _, ok := s.Ref("@" + "s" + strings.Repeat("x", keepSnapshots+1) + ":e1"); !ok {
		t.Fatal("latest snapshot refs should be kept")
	}
}

func TestParseEnvelopeSkipsWarnings(t *testing.T) {
	out := append([]byte("warning: something\n"), env("version", map[string]any{"version": "1.0.1"})...)
	e, err := parseEnvelope(out)
	if err != nil || !e.OK || e.Command != "version" {
		t.Fatalf("%+v %v", e, err)
	}
}

func TestUnavailableWithoutBinary(t *testing.T) {
	s := New(Options{Resolve: func() string { return "" }})
	if s.Available() {
		t.Fatal("should be unavailable")
	}
	if _, err := s.ListApps(context.Background()); CodeOf(err) != "unavailable" {
		t.Fatal(err)
	}
}

func TestSensitiveAction(t *testing.T) {
	ref := func(app, name string) *RefInfo { return &RefInfo{App: app, Role: "button", Name: name} }
	cases := []struct {
		kind  string
		ref   *RefInfo
		app   string
		combo string
		want  bool
	}{
		{"click", ref("Mail", "Send"), "", "", true},
		{"click", ref("微信", "发送(S)"), "", "", true},
		{"click", ref("Shop", "立即付款"), "", "", true},
		{"click", ref("Finder", "Move to Trash"), "", "", false},
		{"click", ref("Finder", "Delete Immediately…"), "", "", true},
		{"click", ref("Notes", "New Note"), "", "", false},
		{"click", ref("System Settings", "Wi-Fi"), "", "", true},
		{"click", ref("gnome-control-center", "Wi-Fi"), "", "", true},
		{"click", ref("systemsettings", "Display"), "", "", true},
		{"click", ref("org.gnome.Settings", "Privacy"), "", "", true},
		{"scroll", ref("System Settings", "list"), "", "", false},
		{"press", nil, "Notes", "Cmd + Return", true},
		{"press", nil, "Notes", "enter", true},
		{"press", nil, "Notes", "cmd+s", false},
		{"press", nil, "Notes", "command+q", true},
		{"press", nil, "gedit", "Ctrl+Q", true},
		{"press", nil, "Notepad", "ctrl+w", true},
		{"press", nil, "Notes", "cmd+w", true},
		// 只有图标的按钮：没有名字，看不出会做什么
		{"click", &RefInfo{App: "Slack", Role: "button", Name: ""}, "", "", true},
		{"click", &RefInfo{App: "Notes", Role: "textfield", Name: ""}, "", "", false},
		{"type", &RefInfo{App: "Notes", Role: "textfield", Name: ""}, "", "", false},
	}
	for _, c := range cases {
		if got := SensitiveAction(c.kind, c.ref, c.app, c.combo) != ""; got != c.want {
			t.Errorf("%s %+v %s %s: got %v", c.kind, c.ref, c.app, c.combo, got)
		}
	}
}

func TestBlockedApp(t *testing.T) {
	for _, n := range []string{"Bitwarden", "Passwords", "密码", "Alipay", "PayPal"} {
		if BlockedApp(n, "", nil) == "" {
			t.Errorf("%s should be blocked", n)
		}
	}
	for _, n := range []string{"Notes", "Finder", "Safari", "Keynote", "Visual Studio Code"} {
		if r := BlockedApp(n, "", nil); r != "" {
			t.Errorf("%s should not be blocked: %s", n, r)
		}
	}
	if BlockedApp("Whatever", "com.agilebits.onepassword7", nil) == "" {
		t.Error("bundle id should block")
	}
}
