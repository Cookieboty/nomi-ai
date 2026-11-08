package igtools

// 桌面工具注册的本地数据外发检查（tools.CheckDataSend）：按传入的接收者 / 角色走 Broker.CheckSend

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

func TestDataSendCheckUsesBroker(t *testing.T) {
	UD := filepath.Join(t.TempDir(), "ud")
	_ = os.MkdirAll(UD, 0o755)
	svc := desktop.CreateService(UD, desktop.Ports{Home: t.TempDir()}, nil)
	summary := &desktop.Provider{ID: "cloud-sum", Name: "cloud-sum"}
	DesktopTools(DeskDeps{Broker: svc.Broker, Audit: svc.Audit, Journal: svc.Journal, Trash: svc.Trash,
		ProviderFor: func(r string) *desktop.Provider {
			if r == "summary" {
				return summary
			}
			return nil
		}})
	t.Cleanup(func() { tools.SetDataSendCheck(nil) })
	svc.Broker.SetLocalOnly(true)
	ctx := context.Background()
	if err := tools.CheckDataSend(ctx, &tools.ToolCallProvider{ID: "local", BaseURL: "http://127.0.0.1:11434/v1"}); err != nil {
		t.Fatalf("local receiver refused: %v", err)
	}
	if err := tools.CheckDataSend(ctx, &tools.ToolCallProvider{ID: "cloud", BaseURL: "https://api.example.com/v1"}); err == nil {
		t.Fatal("cloud receiver allowed with local-only on")
	}
	if err := tools.CheckDataSend(ctx, nil, "summary"); err == nil {
		t.Fatal("cloud summary model allowed with local-only on")
	}
	summary.Local = true
	if err := tools.CheckDataSend(ctx, nil, "summary"); err != nil {
		t.Fatalf("local summary model refused: %v", err)
	}
}
