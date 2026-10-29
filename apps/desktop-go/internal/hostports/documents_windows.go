package hostports

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// Windows：SHGetKnownFolderPath(FOLDERID_Documents)（可被重定向，如 OneDrive）
func documentsDir() string {
	if p, err := windows.KnownFolderPath(windows.FOLDERID_Documents, 0); err == nil && p != "" {
		return p
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Documents")
}
