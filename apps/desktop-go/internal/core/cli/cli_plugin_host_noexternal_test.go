package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type quietHostLogger struct{}

func (quietHostLogger) Info(string, any) {}
func (quietHostLogger) Warn(string, any) {}

// 旧版本「外部 CLI」存下的清单在启动时删掉，注册表里只有内置编程助手。
func TestLegacyExternalCliSpecsAreDropped(t *testing.T) {
	root := t.TempDir()
	ext := filepath.Join(root, "external")
	_ = os.MkdirAll(ext, 0o755)
	if err := os.WriteFile(filepath.Join(ext, "my-agent.json"), []byte(`{"version":1,"id":"my-agent","displayName":"My Agent","command":"my-agent"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	h := NewCliPluginHost(CliPluginHostDeps{Logger: quietHostLogger{}, Root: root, Home: &home})
	if _, err := jsrt.Block(jsrt.Call(h.Start)); err != nil {
		t.Fatal(err)
	}
	defer jsrt.Run(h.Stop)
	if _, err := os.Stat(ext); !os.IsNotExist(err) {
		t.Fatalf("legacy external CLI specs must be removed (err=%v)", err)
	}
	snap := jsrt.Call(h.Snapshot)
	for _, p := range snap.Get("plugins").([]any) {
		e := util.AsObj(p)
		if e.Get("builtin") != true || e.Has("external") || e.Get("id") == "my-agent" {
			t.Fatalf("registry must only list built-in coding assistants: %v", util.Stringify(e))
		}
	}
}
