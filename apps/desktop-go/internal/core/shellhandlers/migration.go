package shellhandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
)

// InstallMigration：shell.ts 的 migration.*。Node 版恒为 none（core/contract/shell.ts）；
// Go 版把首启从 Electron localStorage 抽出的 ai-chat:* 键交给对话窗口导入（#181）
func InstallMigration(r *contract.Router, userData string) {
	r.Call("migration.chatHistory", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return migrate.LoadChatHistory(userData), nil
	})
}
