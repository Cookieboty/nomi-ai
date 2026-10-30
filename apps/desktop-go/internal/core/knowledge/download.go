package knowledge

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
)

// Downloader：流式写 .part → sha256 校验 → 原子改名；onProgress 的 total 未知时为 0
type Downloader func(ctx context.Context, url, sha string, dest string, expected int64, onProgress func(received, total int64)) error

// DownloadVerified = voice/download 的 downloadVerified（同 Node，知识库 OCR 数据与本地模型共用；不续传、无空闲超时）
func DownloadVerified(ctx context.Context, url, sha string, dest string, expected int64, onProgress func(received, total int64)) error {
	return voice.DownloadVerified(ctx, voice.DownloadOpts{URL: url, Sha256: sha, Dest: dest, ExpectedBytes: expected, T: i18n.T,
		OnProgress: func(p voice.Progress) {
			if onProgress != nil {
				onProgress(p.Received, p.Total)
			}
		}})
}
