package usage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestUsageLogRootsPersistAndValidate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log-roots.json")
	r := loadUsageLogRoots(path)
	root := filepath.Join(t.TempDir(), "wrapper-account", "config")
	if added, err := r.addClaude(root); !added || err != nil {
		t.Fatal("root not saved", added, err)
	}
	for _, dir := range []string{root, filepath.Join(root, "."), "relative/config", "", root + "\n"} {
		if added, err := r.addClaude(dir); added || err != nil {
			t.Fatalf("duplicate/invalid root accepted: %q", dir)
		}
	}
	r = loadUsageLogRoots(path)
	got := r.claudeDirs()
	if len(got) != 1 || got[0] != root {
		t.Fatal("discovered path lost after restart", got)
	}
	got[0] = "mutated"
	if r.claudeDirs()[0] != root {
		t.Fatal("snapshot exposed mutable state")
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"claude":["relative"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if len(loadUsageLogRoots(path).claudeDirs()) != 0 {
		t.Fatal("invalid persisted path accepted")
	}
}

func TestUsageScannerDiscoversWrapperLogsAndDeduplicates(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	wrapper := filepath.Join(t.TempDir(), "account", "config")
	ledger := NewUsageLedger(LedgerDeps{Root: root, Logger: nopLogger{}})
	defer ledger.Close()
	var discovered []string
	scanner := NewUsageLogScanner(ScannerDeps{Ledger: ledger, Home: &home, Env: util.NewObj(), Logger: nopLogger{},
		Retention: func() Retention { return "1y" }, ClaudeConfigDirs: func() []string { return discovered }})
	write := func(config string) {
		t.Helper()
		dir := filepath.Join(config, "projects", "test-project")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		line := util.Stringify(util.NewObj("type", "assistant", "timestamp", time.Now().UTC().Format(time.RFC3339Nano),
			"sessionId", "test-session", "message", util.NewObj("id", "msg_wrapper_usage", "model", "claude-test",
				"usage", util.NewObj("input_tokens", 2, "output_tokens", 189, "cache_read_input_tokens", 1000)))) + "\n"
		if err := os.WriteFile(filepath.Join(dir, "test-session.jsonl"), []byte(line), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(wrapper)
	if scan := scanner.Scan(); scan.Added != 0 || ledger.Size() != 0 {
		t.Fatal("undiscovered wrapper directory should not be scanned", scan)
	}
	discovered = []string{wrapper}
	if scan := scanner.Scan(); scan.Added != 1 || ledger.Size() != 1 {
		t.Fatal("wrapper usage was not imported", scan, ledger.Size())
	}
	rec := ledger.Get("claude:msg_wrapper_usage")
	if rec == nil || rec.Input != 2 || rec.Output != 189 || rec.CacheRead != 1000 {
		t.Fatal("incorrect usage imported", rec)
	}
	// The same CLI message can exist in the default home and in a wrapper/account home.
	write(filepath.Join(home, ".claude"))
	discovered = append(discovered, wrapper)
	scanner.Scan()
	if ledger.Size() != 1 || ledger.Get(rec.Key).Output != 189 {
		t.Fatal("duplicate paths or messages were counted twice")
	}
	if scan := scanner.Scan(); scan.Added != 0 {
		t.Fatal("unchanged logs were counted again", scan)
	}
}
