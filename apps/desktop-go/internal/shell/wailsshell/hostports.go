package wailsshell

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// HostPorts：electronPorts.ts 的 dialogs / shell 子集（Wails 原生对话框）

// PickDirectory = dialogs.pickDirectory：properties ['openDirectory'(, 'createDirectory')]；取消 → ""
func (w *Wails) PickDirectory(title, buttonLabel, defaultPath string, createDirectory bool) (string, error) {
	d := w.app.Dialog.OpenFile().CanChooseFiles(false).CanChooseDirectories(true).CanCreateDirectories(createDirectory)
	if title != "" {
		d.SetTitle(title)
	}
	if buttonLabel != "" {
		d.SetButtonText(buttonLabel)
	}
	if defaultPath != "" {
		d.SetDirectory(defaultPath)
	}
	return d.PromptForSingleSelection()
}

// SaveFileFilter = Electron FileFilter { name, extensions }
type SaveFileFilter struct {
	Name       string
	Extensions []string
}

// SaveFile = dialogs.saveFile；取消 → ""
func (w *Wails) SaveFile(title, defaultPath string, filters []SaveFileFilter) (string, error) {
	opts := &application.SaveFileDialogOptions{Title: title, CanCreateDirectories: true}
	if defaultPath != "" {
		opts.Filename = defaultPath
	}
	for _, f := range filters {
		pats := make([]string, 0, len(f.Extensions))
		for _, e := range f.Extensions {
			pats = append(pats, "*."+e)
		}
		opts.Filters = append(opts.Filters, application.FileFilter{DisplayName: f.Name, Pattern: strings.Join(pats, ";")})
	}
	return w.app.Dialog.SaveFileWithOptions(opts).PromptForSingleSelection()
}

// OpenPath = shell.openPath：成功返回 ""，失败返回错误信息
func (w *Wails) OpenPath(p string) string {
	if err := w.app.Browser.OpenFile(p); err != nil {
		return err.Error()
	}
	return ""
}

// ShowItemInFolder = shell.showItemInFolder
func (w *Wails) ShowItemInFolder(p string) { _ = w.app.Env.OpenFileManager(p, true) }
