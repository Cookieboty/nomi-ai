package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
)

func TestDevelopmentCLIEnvironment(t *testing.T) {
	production, dev := t.TempDir(), t.TempDir()
	t.Setenv("NOMI_USER_DATA", production)
	t.Setenv("NOMI_DEV_USER_DATA", dev)
	for _, id := range builtin.IDs {
		impl := builtin.Impl(id)
		if impl == nil || impl.Accounts == nil || impl.Accounts.HomeEnv == "" {
			continue
		}
		t.Run(id, func(t *testing.T) {
			key := impl.Accounts.HomeEnv
			inherited := filepath.Join(production, "cli-accounts", id)
			t.Setenv(key, inherited)
			for _, name := range impl.Accounts.Strip {
				if name != key {
					t.Setenv(name, "production-route")
				}
			}
			isolateDevelopmentCLIEnvironment()
			want := inherited
			if hostports.Development {
				want = filepath.Join(dev, "cli-inherited", id)
			}
			if got := os.Getenv(key); got != want {
				t.Fatalf("%s = %q, want %q", key, got, want)
			}
			for _, name := range impl.Accounts.Strip {
				if name == key {
					continue
				}
				want := "production-route"
				if hostports.Development {
					want = ""
				}
				if got := os.Getenv(name); got != want {
					t.Fatalf("routing variable %s = %q", name, got)
				}
			}
			shared := production + "-shared"
			t.Setenv(key, shared)
			isolateDevelopmentCLIEnvironment()
			if got := os.Getenv(key); got != shared {
				t.Fatalf("explicit shared CLI home changed: %q", got)
			}
		})
	}
}

func TestDevelopmentCLIHomeSymlink(t *testing.T) {
	preserveCLIEnvironment(t)
	root, dev := t.TempDir(), t.TempDir()
	production := filepath.Join(root, "production")
	if err := os.MkdirAll(production, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "alias")
	if err := os.Symlink(production, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	t.Setenv("NOMI_USER_DATA", production)
	t.Setenv("NOMI_DEV_USER_DATA", dev)
	inherited := filepath.Join(link, "new-account")
	t.Setenv("CODEX_HOME", inherited)
	isolateDevelopmentCLIEnvironment()
	want := inherited
	if hostports.Development {
		want = filepath.Join(dev, "cli-inherited", "codex")
	}
	if got := os.Getenv("CODEX_HOME"); got != want {
		t.Fatalf("symlink home = %q, want %q", got, want)
	}
}

func preserveCLIEnvironment(t *testing.T) {
	t.Helper()
	for _, id := range builtin.IDs {
		impl := builtin.Impl(id)
		if impl == nil || impl.Accounts == nil {
			continue
		}
		for _, key := range impl.Accounts.Strip {
			t.Setenv(key, os.Getenv(key))
		}
	}
}

func TestDevelopmentCLIHomeExpansion(t *testing.T) {
	preserveCLIEnvironment(t)
	home, dev := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("NOMI_USER_DATA", filepath.Join(home, "production"))
	t.Setenv("NOMI_DEV_USER_DATA", dev)
	inherited := "  ~/production/account  "
	t.Setenv("CODEX_HOME", inherited)
	isolateDevelopmentCLIEnvironment()
	want := inherited
	if hostports.Development {
		want = filepath.Join(dev, "cli-inherited", "codex")
	}
	if got := os.Getenv("CODEX_HOME"); got != want {
		t.Fatalf("expanded home = %q, want %q", got, want)
	}
}
