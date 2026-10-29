package hostports

import (
	"os"
	"path/filepath"
)

// macOS：NSDocumentDirectory（用户域）= ~/Documents
func documentsDir() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "Documents")
}
