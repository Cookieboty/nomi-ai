package wailsshell

// 系统级快捷键（shell.GlobalShortcuts）：Wails 的 GlobalShortcutManager（App.Run 之前注册的在启动时绑定）

func (w *Wails) RegisterGlobalShortcut(accel string, fn func()) error {
	return w.app.GlobalShortcut.Register(accel, fn)
}

func (w *Wails) UnregisterGlobalShortcut(accel string) error {
	return w.app.GlobalShortcut.Unregister(accel)
}
