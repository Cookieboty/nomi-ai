package harness

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestExternalLauncherDoesNotRequireOrInjectNomiAccount(t *testing.T) {
	cli.ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { cli.ConfigureLaunchers("") })
	if err := cli.SaveLauncher("claude", cli.LauncherSettings{Enabled: true, Command: "reclaude cli", AccountSource: "local"}); err != nil {
		t.Fatal(err)
	}
	o := noLocalOrch(t, filepath.Join(t.TempDir(), "harness"), map[string]bool{})
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		created := o.CreateTab(util.NewObj("backend", "claude", "source", "official", "accountId", "old-nomi-account", "activate", false))
		if created.Has("accountId") {
			t.Fatal("external login inherited a Nomi account association")
		}
		if !o.hasOfficialAccount("claude") || o.hasOfficialAccount("codex") {
			t.Fatal("account availability override is not scoped")
		}
		if got := o.defaultSource("claude", "official"); got != "official" {
			t.Fatalf("source = %s", got)
		}
		tab := util.NewObj("backend", "claude", "source", "official", "accountId", "old-nomi-account")
		launch := o.launchFor(tab)
		if !launch.official || len(launch.env.Keys()) != 0 || len(launch.strip) != 0 {
			t.Fatal("Nomi account configuration was injected")
		}
		before := launch.sig
		if err := cli.SaveLauncher("claude", cli.LauncherSettings{Enabled: true, Command: "other-launcher cli", AccountSource: "local"}); err != nil {
			t.Fatal(err)
		}
		if o.launchFor(tab).sig == before {
			t.Fatal("changed command reused the old launch signature")
		}
		if err := cli.SaveLauncher("claude", cli.LauncherSettings{Enabled: true, Command: "other-launcher cli", AccountSource: "nomi"}); err != nil {
			t.Fatal(err)
		}
		func() {
			defer func() {
				if recover() == nil {
					t.Fatal("Nomi account check was bypassed without manageLogin")
				}
			}()
			o.officialLaunchFor("claude", nil)
		}()
	})
}

func TestLocalLoginForAccountBackendsNeedsNeitherNomiAccountNorCustomCommand(t *testing.T) {
	cli.ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { cli.ConfigureLaunchers("") })
	o := noLocalOrch(t, filepath.Join(t.TempDir(), "harness"), map[string]bool{})
	defer jsrt.Run(o.Dispose)
	for _, kind := range []string{"claude", "codex", "grok", "kimi", "minimax"} {
		if err := cli.SaveLauncher(kind, cli.LauncherSettings{AccountSource: "local"}); err != nil {
			t.Fatal(err)
		}
		jsrt.Run(func() {
			tab := o.CreateTab(util.NewObj("backend", kind, "source", "official", "accountId", "old-account", "activate", false))
			if tab.Get("source") != "official" || tab.Has("accountId") {
				t.Fatalf("%s retained Nomi account requirement", kind)
			}
			l := o.launchFor(tab)
			if len(l.env.Keys()) != 0 || len(l.args) != 0 || len(l.strip) != 0 {
				t.Fatalf("%s received Nomi account config", kind)
			}
			if o.defaultSource(kind, "thirdParty") != "thirdParty" {
				t.Fatal("local login replaced explicit third-party source")
			}
		})
	}
}

func TestClaudeReportedConfigDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "wrapper", "config")
	if got := claudeReportedConfigDir(util.NewObj("user_output_styles_dir", filepath.Join(root, "output-styles"))); got != root {
		t.Fatal("CLI configuration directory not detected", got)
	}
	for _, p := range []any{nil, "", "relative/output-styles", root, root + "\n", 42} {
		if got := claudeReportedConfigDir(util.NewObj("user_output_styles_dir", p)); got != "" {
			t.Fatalf("unrelated/invalid metadata accepted: %v", p)
		}
	}
}

func TestLauncherChangedRecyclesCatalogAndCarriesIdleTabs(t *testing.T) {
	cli.ConfigureLaunchers(t.TempDir())
	t.Cleanup(func() { cli.ConfigureLaunchers("") })
	o := noLocalOrch(t, filepath.Join(t.TempDir(), "harness"), map[string]bool{})
	defer jsrt.Run(o.Dispose)

	jsrt.Run(func() {
		tab := o.CreateTab(util.NewObj(
			"backend", "claude",
			"source", "official",
			"cliSessionId", "sess-old-nomi",
			"activate", false,
		))
		id := str(tab, "id")
		o.tab(id).Set("accountId", "nomi-acct-1")
		o.SeedTabMessages(id, []any{util.NewObj("id", "m1", "role", "user", "content", "hi", "timestamp", float64(1))})
		o.modelCatalogs["claude"] = catalogEntry{at: nowMs(), catalog: util.NewObj("backend", "claude")}
		prevGen := o.modelCatalogGen["claude"]

		prev := cli.LauncherFor("claude")
		next := cli.LauncherSettings{AccountSource: "local"}
		if err := cli.SaveLauncher("claude", next); err != nil {
			t.Fatal(err)
		}
		o.LauncherChanged("claude", prev, next)

		if _, cached := o.modelCatalogs["claude"]; cached {
			t.Fatal("model catalog cache was not invalidated")
		}
		if o.modelCatalogGen["claude"] <= prevGen {
			t.Fatal("model catalog generation did not advance")
		}
		cur := o.tab(id)
		if cur.Has("accountId") {
			t.Fatalf("accountId remained after switching to local: %v", cur.Get("accountId"))
		}
		if truthy(cur.Get("cliSessionId")) {
			t.Fatalf("stale cliSessionId remained after switching account source: %v", cur.Get("cliSessionId"))
		}
		if !truthy(cur.Get("carriedMessages")) {
			t.Fatal("idle tab did not retain carriedMessages across account source switch")
		}
	})
}

func TestStateReportsEnabledCustomLauncherBin(t *testing.T) {
	if runtime.GOOS == "windows" {
		return
	}
	cli.ConfigureLaunchers(t.TempDir())
	cli.ResetCliBinCache()
	t.Cleanup(func() {
		cli.ConfigureLaunchers("")
		cli.ResetCliBinCache()
	})
	t.Setenv("NOMI_USE_MOCK_CLI", "0")
	t.Setenv("PATH", t.TempDir())

	targetKind := ""
	for _, k := range []string{"minimax", "kimi", "grok", "codex", "claude"} {
		if ResolveHarnessBin(k) == "" {
			targetKind = k
			break
		}
	}
	if targetKind == "" {
		return
	}

	dir := t.TempDir()
	wrapper := filepath.Join(dir, "custom-wrapper")
	if err := os.WriteFile(wrapper, []byte("#!/bin/sh\necho 1.0.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := cli.SaveLauncher(targetKind, cli.LauncherSettings{
		Enabled:       true,
		Command:       fmt.Sprintf("%q cli", wrapper),
		AccountSource: "local",
	}); err != nil {
		t.Fatal(err)
	}
	if got := ResolveEffectiveHarnessBin(targetKind); got != wrapper {
		t.Fatalf("ResolveEffectiveHarnessBin(%s) = %q, want %q", targetKind, got, wrapper)
	}

	o := noLocalOrch(t, filepath.Join(t.TempDir(), "harness"), map[string]bool{})
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		bins, _ := o.State().Get("bins").(*util.Obj)
		if bins == nil || bins.Get(targetKind) != wrapper {
			t.Fatalf("State().bins[%s] = %v, want %s", targetKind, bins.Get(targetKind), wrapper)
		}
	})
}
