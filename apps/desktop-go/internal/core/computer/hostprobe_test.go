package computer

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHostProbeCoalescesBursts(t *testing.T) {
	var n atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s := New(Options{
		Resolve: func() string { return "/bin/agent-desktop" },
		Exec: func(ctx context.Context, _ string, args []string, _ string) ([]byte, error) {
			n.Add(1)
			if args[0] == "version" {
				once.Do(func() { close(started) })
				select {
				case <-release:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			var data any
			switch args[0] {
			case "version":
				data = map[string]any{"version": "1.2.0"}
			case "permissions":
				data = map[string]any{
					"accessibility":    map[string]any{"state": "granted"},
					"screen_recording": map[string]any{"state": "not_required"},
				}
			default:
				data = map[string]any{}
			}
			b, _ := json.Marshal(map[string]any{"version": "2.6", "ok": true, "command": args[0], "data": data})
			return b, nil
		},
	})
	s.hostProbeTTL = time.Hour

	var wg sync.WaitGroup
	errc := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st := s.State(context.Background(), false, false, RegisterOptions{})
			if st["version"] != "1.2.0" {
				errc <- errf("bad", "version %v", st["version"])
			}
			perms, _ := st["permissions"].(map[string]string)
			if perms["accessibility"] != "granted" {
				errc <- errf("bad", "perms %#v", st["permissions"])
			}
		}()
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("probe did not start")
	}
	time.Sleep(30 * time.Millisecond)
	if got := n.Load(); got != 1 {
		t.Fatalf("during burst, execs = %d, want 1 (version still in flight)", got)
	}
	close(release)
	wg.Wait()
	close(errc)
	for e := range errc {
		t.Fatal(e)
	}
	if got := n.Load(); got != 2 {
		t.Fatalf("execs = %d, want 2 (version + permissions)", got)
	}
	s.State(context.Background(), false, false, RegisterOptions{})
	if got := n.Load(); got != 2 {
		t.Fatalf("cached execs = %d, want 2", got)
	}
	s.State(context.Background(), false, true, RegisterOptions{})
	if got := n.Load(); got != 4 {
		t.Fatalf("fresh execs = %d, want 4", got)
	}
}

func TestWindowsBatchLaunchQuotesCmdShim(t *testing.T) {
	// 路径没有空格：整段命令外面加一对引号即可（/s 会剥掉）
	_, _, plain := windowsBatchLaunch(`C:\Windows\System32\cmd.exe`,
		`C:\Users\Administrator\AppData\Roaming\npm\agent-desktop.cmd`, []string{"version"})
	if plain != `C:\Windows\System32\cmd.exe /d /s /c "C:\Users\Administrator\AppData\Roaming\npm\agent-desktop.cmd version"` {
		t.Fatal(plain)
	}
	// 路径有空格：垫片自己先加引号，再被 /c 的外层引号包住
	_, argv, line := windowsBatchLaunch(`C:\Windows\System32\cmd.exe`,
		`C:\Program Files\npm\agent-desktop.cmd`, []string{"permissions"})
	want := `C:\Windows\System32\cmd.exe /d /s /c ""C:\Program Files\npm\agent-desktop.cmd" permissions"`
	if line != want {
		t.Fatalf("got %s", line)
	}
	if len(argv) != 5 || argv[1] != "/d" || argv[2] != "/s" || argv[3] != "/c" {
		t.Fatal(argv)
	}
	if !isBatchFile(`C:\npm\agent-desktop.cmd`) || !isBatchFile(`C:\npm\npm.bat`) || isBatchFile(`C:\npm\agent-desktop.exe`) {
		t.Fatal("batch detection")
	}
}
