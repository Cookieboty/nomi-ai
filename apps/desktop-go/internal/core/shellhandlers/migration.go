package shellhandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
)

// InstallMigration：挂 migration.*：把首启从旧版 Electron localStorage 抽出的
// ai-chat:* 键交给对话窗口导入（#181）
func InstallMigration(r *contract.Router, userData string) {
	r.Call("migration.chatHistory", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return migrate.LoadChatHistory(userData), nil
	})
}
