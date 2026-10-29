//go:build linux

package wailsshell

import "github.com/godbus/dbus/v5"

// trayHostAvailable：Linux 托盘走 StatusNotifierItem，需要会话总线上有 StatusNotifierWatcher
// （KDE、装了 AppIndicator 扩展的 GNOME 等）；没有就不建托盘。
func trayHostAvailable() bool {
	conn, err := dbus.SessionBus()
	if err != nil {
		return false
	}
	var has bool
	err = conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has)
	return err == nil && has
}
