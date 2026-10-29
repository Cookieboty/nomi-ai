package main

import (
	"context"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

// hostPorts：electronPorts.ts 的 dialogs / shell / power，外壳晚于服务创建，按需取 *wailsshell.Wails
type hostPorts struct{ sh *shell.Shell }

func (p hostPorts) w() *wailsshell.Wails {
	if p.sh == nil || *p.sh == nil {
		return nil
	}
	w, _ := (*p.sh).(*wailsshell.Wails)
	return w
}

var _ deps.Ports = hostPorts{}

func (p hostPorts) PickDirectory(_ context.Context, title, buttonLabel string) (string, error) {
	return p.PickDir(title, buttonLabel, "")
}

// PickDir：批次 6 desktop.Ports.PickDirectory 的签名
func (p hostPorts) PickDir(title, buttonLabel, defaultPath string) (string, error) {
	if w := p.w(); w != nil {
		return w.PickDirectory(title, buttonLabel, defaultPath, false)
	}
	return "", nil
}

func (p hostPorts) SaveFile(_ context.Context, title, defaultName string, filters []deps.FileFilter) (string, error) {
	w := p.w()
	if w == nil {
		return "", nil
	}
	fs := make([]wailsshell.SaveFileFilter, 0, len(filters))
	for _, f := range filters {
		fs = append(fs, wailsshell.SaveFileFilter{Name: f.Name, Extensions: f.Extensions})
	}
	return w.SaveFile(title, defaultName, fs)
}

func (p hostPorts) OpenPath(path string) string {
	if w := p.w(); w != nil {
		return w.OpenPath(path)
	}
	return "no shell"
}

func (p hostPorts) ShowItemInFolder(path string) {
	if w := p.w(); w != nil {
		w.ShowItemInFolder(path)
	}
}

func (p hostPorts) IdleSeconds() int { return hostports.IdleSeconds() }

// ClipboardRead / ClipboardWrite：electronPorts.ts 的 clipboard（desktop.Ports 用）
func (p hostPorts) ClipboardRead() (string, error) {
	if w := p.w(); w != nil {
		return w.ClipboardText(), nil
	}
	return "", nil
}

func (p hostPorts) ClipboardWrite(text string) error {
	if w := p.w(); w != nil {
		w.ClipboardSetText(text)
	}
	return nil
}
