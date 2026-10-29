//go:build linux || freebsd

package trash

import (
	"os"
	"strings"
)

// item：KDE 用 kioclient5/kioclient move <p> trash:/，其余 gio trash（Electron 的选择顺序）
func item(p string) error {
	de := strings.ToUpper(os.Getenv("XDG_CURRENT_DESKTOP"))
	if strings.Contains(de, "KDE") {
		if err := run("kioclient5", "move", p, "trash:/"); err == nil {
			return nil
		}
		if err := run("kioclient", "move", p, "trash:/"); err == nil {
			return nil
		}
	}
	err := run("gio", "trash", p)
	if err == nil {
		return nil
	}
	if e2 := run("gvfs-trash", p); e2 == nil {
		return nil
	}
	return err
}
