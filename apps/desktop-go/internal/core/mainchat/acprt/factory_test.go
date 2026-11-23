package acprt

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
)

func TestFactorySupportsAllBuiltinAcpBackendsAndSeparatesCompatKeys(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	dir := t.TempDir()
	project := filepath.Join(dir, "proj")
	cfg1 := filepath.Join(dir, "cfg-1")
	cfg2 := filepath.Join(dir, "cfg-2")
	for _, d := range []string{project, cfg1, cfg2} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	acpIDs := builtin.Where(builtin.UsesAcp)
	if len(acpIDs) == 0 {
		t.Fatal("expected builtin ACP backends")
	}
	for _, id := range acpIDs {
		t.Run(id, func(t *testing.T) {
			marker := filepath.Join(dir, "executed-"+id)
			exe1 := filepath.Join(dir, id+"-v1")
			exe2 := filepath.Join(dir, id+"-v2")
			for _, p := range []string{exe1, exe2} {
				if err := os.WriteFile(p, []byte("#!/bin/sh\necho ran > '"+marker+"'\nexit 0\n"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			useExe, useCfg, useModel := exe1, cfg1, ""
			f := New(id, func(string) (Config, error) {
				return Config{BackendID: id, Executable: useExe, Cwd: project, ConfigDir: useCfg, Model: useModel}, nil
			})
			defer f.Release("c")

			t1, err := f.Target("c")
			if err != nil {
				t.Fatalf("Target(%s): %v", id, err)
			}
			if t1.Identity.DriverID != id || t1.Env.PermissionMode != "ask" || t1.Env.Model != "cli-default" {
				t.Fatalf("unexpected target metadata: %+v / %+v", t1.Identity, t1.Env)
			}
			k1 := t1.Identity.Key(t1.Env)

			useCfg = cfg2
			t2, err := f.Target("c")
			if err != nil {
				t.Fatal(err)
			}
			if t2.Identity.Key(t2.Env) == k1 {
				t.Fatalf("%s config dir change reused compatibility key", id)
			}

			useCfg, useExe, useModel = cfg1, exe2, "custom-model"
			t3, err := f.Target("c")
			if err != nil {
				t.Fatal(err)
			}
			if t3.Identity.Key(t3.Env) == k1 {
				t.Fatalf("%s model/exe change reused compatibility key", id)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("%s metadata Target executed executable", id)
			}
		})
	}
}

func TestFactoryPermissionModesAndCompatKeys(t *testing.T) {
	wantGrok := []string{"deny", "ask", "acceptEdits", "auto", "bypass"}
	gotGrok := PermissionModes("grok")
	if len(gotGrok) != len(wantGrok) {
		t.Fatalf("PermissionModes(grok) = %v, want %v", gotGrok, wantGrok)
	}
	for i := range wantGrok {
		if gotGrok[i] != wantGrok[i] {
			t.Fatalf("PermissionModes(grok)[%d] = %q, want %q", i, gotGrok[i], wantGrok[i])
		}
	}
	for _, id := range []string{"gemini", "minimax"} {
		got := PermissionModes(id)
		if len(got) == 0 {
			t.Fatalf("PermissionModes(%s) should not be empty", id)
		}
	}

	dir := t.TempDir()
	exe := filepath.Join(dir, "grok")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	mode := "ask"
	f := New("grok", func(string) (Config, error) {
		return Config{BackendID: "grok", Executable: exe, Cwd: dir, ConfigDir: dir, PermissionMode: mode}, nil
	})
	tAsk, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	mode = "auto"
	tAuto, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	if tAuto.Env.PermissionMode != "auto" {
		t.Fatalf("expected Env.PermissionMode=auto, got %q", tAuto.Env.PermissionMode)
	}
	if tAsk.Identity.Key(tAsk.Env) == tAuto.Identity.Key(tAuto.Env) {
		t.Fatal("different PermissionMode must yield distinct CompatibilityKey")
	}

	mode = "bogus"
	tBogus, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	if tBogus.Env.PermissionMode != "bogus" {
		t.Fatalf("explicit bogus PermissionMode must be preserved for session rejection, got %q", tBogus.Env.PermissionMode)
	}
}
