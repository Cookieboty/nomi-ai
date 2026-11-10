package harness

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const tinyImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII="

func withImageOrchestrator(t *testing.T, run func(*Orchestrator)) {
	t.Helper()
	root := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(root, "h"), Home: root, Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle,
			ImageStore: &cli.MessageImageStore{ChatRoot: filepath.Join(root, "chat")}})
		defer o.Dispose()
		run(o)
	})
}
func imageTurn(id, text string, at float64) *util.Obj {
	return util.NewObj("id", id, "role", "user", "content", text, "timestamp", at, "images", []any{clisdk.ImageReference(tinyImage, "photo.png")})
}
func TestImageSeedsPersistAcrossReload(t *testing.T) {
	withImageOrchestrator(t, func(o *Orchestrator) {
		tab := o.CreateTab(util.NewObj("backend", "codex", "activate", false, "messages", []any{imageTurn("u", "", 1)}))
		id := util.Str(tab.Get("id"))
		assertImages := func() {
			messages := o.TabMessages(id)
			images, _ := messages[0].Get("images").([]any)
			if len(messages) != 1 || len(images) != 1 || !strings.HasPrefix(util.Str(util.AsObj(images[0]).Get("url")), "chat-asset://images/") {
				t.Fatal("seed lost image")
			}
		}
		assertImages()
		o.FlushPersist()
		delete(o.messages, id)
		delete(o.migratedImgTabs, id)
		assertImages()
		o.SeedTabMessages(id, []any{imageTurn("seed2", "inspect", 2)})
		assertImages()
	})
}
func TestLiveImageEchoAndMultipartDoNotDuplicateTurns(t *testing.T) {
	withImageOrchestrator(t, func(o *Orchestrator) {
		tab := o.CreateTab(util.NewObj("backend", "codex", "activate", false, "messages", []any{imageTurn("local", "inspect", 1)}))
		id := util.Str(tab.Get("id"))
		event := func(source, text string) *util.Obj {
			return util.NewObj("type", "user-message", "sourceId", source, "text", text, "images", []any{clisdk.ImageReference(tinyImage, "photo.png")})
		}
		o.receiveUserImages(id, event("source1", "inspect"))
		if len(o.TabMessages(id)) != 1 || o.TabMessages(id)[0].Get("id") != "local" {
			t.Fatal("own echo duplicated")
		}
		o.receiveUserImages(id, event("source2", "inspect"))
		if len(o.TabMessages(id)) != 2 {
			t.Fatal("same text with different source lost")
		}
		o.receiveUserImages(id, event("source2", "inspect please"))
		if len(o.TabMessages(id)) != 2 || o.TabMessages(id)[1].Get("content") != "inspect please" {
			t.Fatal("multipart update not applied")
		}
		o.receiveUserImages(id, event("source1", "inspect"))
		if len(o.TabMessages(id)) != 2 {
			t.Fatal("late replay duplicated old turn")
		}
		o.emitEvent(id, event("source3", ""))
		if len(o.TabMessages(id)) != 3 || o.TabMessages(id)[2].Get("content") != "" {
			t.Fatal("image-only turn lost")
		}
	})
}
func TestReopenedHistoryRecoversImagesWithoutReplacingLiveTurns(t *testing.T) {
	withImageOrchestrator(t, func(o *Orchestrator) {
		legacy := util.NewObj("id", "local", "role", "user", "content", "inspect", "timestamp", float64(1), "images", []any{util.NewObj("unavailable", true, "thumb", "")})
		tab := o.CreateTab(util.NewObj("backend", "codex", "activate", false, "cliSessionId", "session", "messages", []any{legacy}))
		id := util.Str(tab.Get("id"))
		o.appendMessage(id, util.NewObj("id", "live", "role", "assistant", "content", "new live answer", "timestamp", float64(2)))
		result := o.OpenHistorySession(util.NewObj("backend", "codex", "sessionId", "session", "messages", []any{imageTurn("hist-0", "inspect", 1)}))
		messages := o.TabMessages(id)
		images, _ := messages[0].Get("images").([]any)
		if result.Get("reused") != true || len(messages) != 2 || messages[0].Get("id") != "local" || messages[1].Get("content") != "new live answer" || util.AsObj(images[0]).Get("unavailable") == true {
			t.Fatal("reopen did not safely recover image")
		}
	})
}
