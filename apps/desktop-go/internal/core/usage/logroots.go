package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Only configuration paths reported by a running CLI are stored here, never account metadata.
type usageLogRoots struct {
	mu     sync.Mutex
	path   string
	claude []string
}

type usageLogRootsFile struct {
	Version int      `json:"version"`
	Claude  []string `json:"claude"`
}

func loadUsageLogRoots(path string) *usageLogRoots {
	r := &usageLogRoots{path: path}
	if b, err := os.ReadFile(path); err == nil && len(b) <= 128*1024 {
		var disk usageLogRootsFile
		if json.Unmarshal(b, &disk) == nil && disk.Version == 1 {
			for _, dir := range disk.Claude {
				r.addPath(dir)
			}
		}
	}
	return r
}

// Caller holds mu (or is still constructing r).
func (r *usageLogRoots) addPath(dir string) bool {
	if !filepath.IsAbs(dir) || strings.ContainsAny(dir, "\x00\r\n") || len(r.claude) >= 128 {
		return false
	}
	dir = filepath.Clean(dir)
	if dir == filepath.Dir(dir) {
		return false
	}
	for _, old := range r.claude {
		if old == dir || (runtime.GOOS == "windows" && strings.EqualFold(old, dir)) {
			return false
		}
	}
	r.claude = append(r.claude, dir)
	return true
}

func (r *usageLogRoots) addClaude(dir string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.addPath(dir) {
		return false, nil
	}
	b, err := json.Marshal(usageLogRootsFile{Version: 1, Claude: r.claude})
	if err == nil {
		err = WritePrivateFile(r.path, string(b))
	}
	return true, err
}

func (r *usageLogRoots) claudeDirs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.claude...)
}
