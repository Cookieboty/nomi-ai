package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
)

type nopConfirmUI struct{}

func (nopConfirmUI) Request(desktop.ConfirmRequest) {}
func (nopConfirmUI) Cancel(string)                  {}

// 灵动岛上的 Nomi 确认：能记住的多一个「始终允许」（在「拒绝」前面），点了 = 允许并记住
func TestIslandConfirmAlwaysAllow(t *testing.T) {
	R := t.TempDir()
	ud := filepath.Join(R, "ud")
	_ = os.MkdirAll(ud, 0o755)
	svc := desktop.CreateService(ud, desktop.Ports{Home: filepath.Join(R, "home")}, nil)
	svc.Broker.UI = nopConfirmUI{}
	h := &islandPendingHub{src: islandPendingSources{desktop: svc}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx = tools.WithConversation(ctx, "c1")
	authorize := func() chan desktop.Decision {
		ch := make(chan desktop.Decision, 1)
		go func() {
			ch <- svc.Broker.Authorize(desktop.AuthorizeInput{Tool: "computer_click", Danger: "write", Summary: "点击", Signal: ctx})
		}()
		return ch
	}
	got := authorize()
	var items []island.Pending
	var acts map[string]map[string]func() error
	for i := 0; i < 200 && len(items) == 0; i++ {
		items, acts = h.collect()
		time.Sleep(5 * time.Millisecond)
	}
	if len(items) != 1 {
		t.Fatalf("items %v", items)
	}
	var ids []string
	for _, a := range items[0].Actions {
		ids = append(ids, a.ID)
	}
	if len(ids) != 3 || ids[0] != "allow" || ids[1] != "always" || ids[2] != "deny" {
		t.Fatalf("actions %v", ids)
	}
	if err := acts[items[0].ID]["always"](); err != nil {
		t.Fatal(err)
	}
	if d := <-got; d != "allowed" {
		t.Fatal(d)
	}
	// 记住了：同一对话里的桌面操作不再问
	select {
	case d := <-authorize():
		if d != "auto" {
			t.Fatal(d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("should not ask again in the same conversation")
	}
}
