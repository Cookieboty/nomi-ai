package computer

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPickLatestAndCompare(t *testing.T) {
	latest, newest := pickLatest([]string{"0.9.0", "1.0.1", "1.2.0", "1.10.0", "1.11.0-beta.1", "2.0.0", "bad"})
	if latest != "1.10.0" || newest != "2.0.0" {
		t.Fatalf("latest=%s newest=%s", latest, newest)
	}
	if CompareVersions("1.2.0", "1.10.0") >= 0 || CompareVersions("v1.2.0", "1.2.0") != 0 {
		t.Fatal("compare")
	}
}

func TestInstallArgvOnlySupportedMajor(t *testing.T) {
	if _, err := InstallArgv("npm", "2.0.0", ""); err == nil {
		t.Fatal("other majors must be rejected")
	}
	if _, err := InstallArgv("npm", "1.2.0; rm -rf /", ""); err == nil {
		t.Fatal("non-version must be rejected")
	}
	a, err := InstallArgv("npm", "1.2.0", "/home/u/.local")
	if err != nil || strings.Join(a, " ") != "npm install -g agent-desktop@1.2.0 --prefix /home/u/.local" {
		t.Fatalf("%v %v", a, err)
	}
}

// fakeInstall：npm view 给出版本列表；npm install 后 agent-desktop 出现
type fakeInstall struct {
	runs      []string
	installed bool
	have      string
	writable  bool
}

func (f *fakeInstall) svc() *Service {
	s := New(Options{
		Resolve: func() string {
			if f.installed {
				return "/usr/bin/true"
			}
			return ""
		},
		Exec: func(_ context.Context, _ string, args []string, _ string) ([]byte, error) {
			b, _ := json.Marshal(map[string]any{"version": "2.6", "ok": true, "command": args[0], "data": map[string]any{"version": f.have}})
			return b, nil
		},
		Getenv: func(string) string { return "" },
	})
	s.SetInstaller(InstallDeps{
		Npm:        func() string { return "npm" },
		NpmPrefix:  func() string { return "/usr/local" },
		UserPrefix: func() string { return "/home/u/.local" },
		CanWrite:   func(string) bool { return f.writable },
		Run: func(_ context.Context, argv []string) (string, int, error) {
			f.runs = append(f.runs, strings.Join(argv, " "))
			if argv[1] == "view" {
				return `["1.0.0","1.2.0","1.3.1","2.0.0"]`, 0, nil
			}
			f.installed, f.have = true, "1.3.1"
			return "added 1 package", 0, nil
		},
	})
	return s
}

func TestInstallFallsBackToUserScope(t *testing.T) {
	f := &fakeInstall{}
	s := f.svc()
	r, err := s.Install(context.Background(), "global")
	if err != nil || r.OK || !r.NeedsUserScope || r.UserPrefix != "/home/u/.local" {
		t.Fatalf("%+v %v", r, err)
	}
	if len(f.runs) != 0 {
		t.Fatalf("nothing should run when the global dir is not writable: %v", f.runs)
	}
	r, err = s.Install(context.Background(), "user")
	if err != nil || !r.OK || r.Version != "1.3.1" {
		t.Fatalf("%+v %v", r, err)
	}
	if last := f.runs[len(f.runs)-1]; last != "npm install -g agent-desktop@1.3.1 --prefix /home/u/.local" {
		t.Fatal(last)
	}
}

func TestVersionsUpdateCheck(t *testing.T) {
	f := &fakeInstall{installed: true, have: "1.2.0", writable: true}
	s := f.svc()
	v := s.Versions(context.Background(), true)
	if !v.Installed || v.Version != "1.2.0" || v.Latest != "1.3.1" || !v.UpdateAvailable || v.NewerMajor != "2.0.0" {
		t.Fatalf("%+v", v)
	}
	// 6 小时内用缓存，不重复查 npm
	n := len(f.runs)
	s.Versions(context.Background(), false)
	if len(f.runs) != n {
		t.Fatal("should use cached latest")
	}
	f.have = "1.3.1"
	if v := s.Versions(context.Background(), false); v.UpdateAvailable {
		t.Fatalf("up to date: %+v", v)
	}
}

func TestVersionsDoNotWaitForNetwork(t *testing.T) {
	f := &fakeInstall{installed: true, have: "1.2.0", writable: true}
	s := f.svc()
	changed := make(chan struct{}, 1)
	s.OnStateChange(func() { changed <- struct{}{} })
	// 打开设置页：没有缓存也不当场查 npm，先返回
	if v := s.Versions(context.Background(), false); v.Latest != "" || !v.Installed {
		t.Fatalf("%+v", v)
	}
	select {
	case <-changed:
	case <-time.After(5 * time.Second):
		t.Fatal("background check should notify")
	}
	if v := s.Versions(context.Background(), false); v.Latest != "1.3.1" || !v.UpdateAvailable {
		t.Fatalf("after background check: %+v", v)
	}
}
