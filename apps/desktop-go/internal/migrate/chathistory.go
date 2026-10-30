package migrate

import (
	"fmt"
	"log"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/aichat"
)

// 契约 migration.chatHistory 的三种状态（packages/contract/src/app/shell/schemas.ts ChatHistoryMigration）
const (
	ChatHistoryNone   = "none"
	ChatHistoryReady  = "ready"
	ChatHistoryFailed = "failed"
)

// ChatHistory = 契约 migration.chatHistory 的返回值
type ChatHistory struct {
	Status  string            `json:"status"`
	Entries map[string]string `json:"entries"`
	Error   string            `json:"error,omitempty"`
}

var chatHistoryMu sync.Mutex

// LoadChatHistory：首启从 Electron localStorage 抽出的 ai-chat:* 键，交给视图导入（#181）。
//
// 只读、可重复调用（视图自己记完成标记，导入失败下次启动再取）：
//   - 没迁移过 / 不是从 Electron 升级来的 / 抽出 0 个键 → none；
//   - 有汇总文件 → ready；
//   - 首启抽取失败（或汇总文件丢了）→ 当场从 Electron 原目录再抽一次（原库不动），成功 ready、失败 failed，
//     结果写回迁移标记。
func LoadChatHistory(goUserData string) ChatHistory {
	chatHistoryMu.Lock()
	defer chatHistoryMu.Unlock()
	none := ChatHistory{Status: ChatHistoryNone, Entries: map[string]string{}}
	failed := func(err error) ChatHistory {
		return ChatHistory{Status: ChatHistoryFailed, Entries: map[string]string{}, Error: err.Error()}
	}

	if m, ok, err := aichat.ReadExport(goUserData); ok {
		if err != nil {
			return failed(err)
		}
		if len(m) == 0 {
			return none
		}
		return ChatHistory{Status: ChatHistoryReady, Entries: m}
	}

	marker := filepath.Join(goUserData, markerName)
	markerMu.Lock()
	res, ok := loadMarker(marker)
	markerMu.Unlock()
	if !ok || !res.Migrated || res.From == "" {
		return none
	}
	if res.ChatExtractError == "" && res.ChatKeysExtracted == 0 {
		return none
	}

	n, err := aichat.ExtractLocalStorage(res.From, goUserData)
	updateMarker(marker, func(r *Result) {
		if err != nil {
			r.ChatExtractError = err.Error()
			return
		}
		r.ChatExtractError = ""
		r.ChatKeysExtracted = n
	})
	if err != nil {
		log.Printf("[migrate] chat history re-extract failed: %v", err)
		return failed(err)
	}
	log.Printf("[migrate] chat history re-extracted: keys=%d", n)
	if n == 0 {
		return none
	}
	m, ok, err := aichat.ReadExport(goUserData)
	if err != nil || !ok {
		if err == nil {
			err = fmt.Errorf("chat history export missing after extract")
		}
		return failed(err)
	}
	return ChatHistory{Status: ChatHistoryReady, Entries: m}
}
