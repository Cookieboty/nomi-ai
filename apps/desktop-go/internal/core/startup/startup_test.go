package startup_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/startup"
)

func TestDefaultsAndSet(t *testing.T) {
	f := filepath.Join(t.TempDir(), "startup.json")
	s := startup.New(f, nil)
	st := s.Get()
	if st.DefaultView != "main" || st.ShowMascot || st.CloseMain != "hide" {
		t.Fatalf("%+v", st)
	}
	st, err := s.Set(map[string]any{"defaultView": "main", "showMascot": false})
	if err != nil {
		t.Fatal(err)
	}
	if st.DefaultView != "main" || st.ShowMascot {
		t.Fatalf("%+v", st)
	}
	s2 := startup.New(f, nil)
	if s2.Get() != st {
		t.Fatalf("reload %+v vs %+v", s2.Get(), st)
	}
}

// 没有 startup.json 的升级安装也统一使用工作台；桌面角色必须由用户在设置中开启。
func TestExistingInstallUsesWorkbench(t *testing.T) {
	for _, marker := range []string{"onboarding.json", "ai-providers.json", "memory"} {
		t.Run(marker, func(t *testing.T) {
			dir := t.TempDir()
			if marker == "memory" {
				if err := os.Mkdir(filepath.Join(dir, marker), 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(filepath.Join(dir, marker), []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
			st := startup.New(filepath.Join(dir, "startup.json"), nil).Get()
			if st.DefaultView != "main" || st.ShowMascot || st.CloseMain != "hide" {
				t.Fatalf("%+v", st)
			}
		})
	}
}

// 新安装第一次启动就把工作台默认写盘：之后引导写出 onboarding.json 也不会被当成老安装
func TestNewInstallDefaultPersists(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "startup.json")
	first := startup.New(f, nil).Get()
	if first.DefaultView != "main" || first.ShowMascot {
		t.Fatalf("%+v", first)
	}
	if err := os.WriteFile(filepath.Join(dir, "onboarding.json"), []byte(`{"done":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if again := startup.New(f, nil).Get(); again != first {
		t.Fatalf("reload %+v vs %+v", again, first)
	}
}
