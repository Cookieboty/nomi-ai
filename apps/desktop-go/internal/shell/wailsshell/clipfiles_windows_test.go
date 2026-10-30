package wailsshell

import (
	"testing"

	"golang.org/x/sys/windows"
)

// #198：剪贴板文件粘贴用到的系统 DLL 与函数都能解析。LazyProc 首次 Call 时才加载，
// 名称写错（如 clipUser32.dll）编译与启动都不报错，粘贴时才 panic，所以这里逐个 Find。
func TestClipboardProcsResolve(t *testing.T) {
	for _, p := range []*windows.LazyProc{procOpenClipboard, procCloseClip, procGetClipData, procDragQueryFile} {
		if err := p.Find(); err != nil {
			t.Errorf("%s: %v", p.Name, err)
		}
	}
	for dll, want := range map[*windows.LazyDLL]string{clipUser32: "user32.dll", clipShell32: "shell32.dll"} {
		if dll.Name != want {
			t.Errorf("dll name %q, want %q", dll.Name, want)
		}
	}
}

// 整条读取路径不 panic：剪贴板里没有文件（或被占用）时返回 nil，有就返回路径
func TestClipboardFilePathsNoPanic(t *testing.T) {
	_ = (*Wails)(nil).ClipboardFilePaths()
}
