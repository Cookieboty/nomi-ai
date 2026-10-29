package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/tr"
)

// AppTrash.ts：应用自己的回收站 <root>/<YYYY-MM-DD>/<uuid>/<basename> + manifest.json

// TrashRecord 回收记录
type TrashRecord struct {
	ID        string  `json:"id"`
	Original  string  `json:"original"`
	Stored    string  `json:"stored"`
	TrashedAt float64 `json:"trashedAt"`
}

func moveFS(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o777); err != nil {
		return err
	}
	err := os.Rename(from, to)
	if err == nil || !errors.Is(err, syscall.EXDEV) {
		return err
	}
	if err := copyTree(from, to); err != nil {
		return err
	}
	return os.RemoveAll(from)
}

func copyTree(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return toolErr("ERR_FS_CP_EEXIST", "Target already exists: "+to)
	}
	return os.CopyFS(to, os.DirFS(from))
}

// MoveNoOverwrite：目标已存在时报 conflict
func MoveNoOverwrite(from, to string) error {
	if exists(to) {
		return toolErr("conflict", tr.T("electron.common.target-already-exists", to))
	}
	return moveFS(from, to)
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// AppTrash 应用回收站
type AppTrash struct {
	root string
	now  func() float64
}

func NewAppTrash(root string, now func() float64) *AppTrash {
	if now == nil {
		now = nowMs
	}
	return &AppTrash{root: root, now: now}
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

func isoDay(ms float64) string { return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02") }

func (a *AppTrash) Trash(target string) (TrashRecord, error) {
	id := randomUUID()
	dir := filepath.Join(a.root, isoDay(a.now()), id)
	stored := filepath.Join(dir, filepath.Base(target))
	if err := moveFS(target, stored); err != nil {
		return TrashRecord{}, err
	}
	rec := TrashRecord{ID: id, Original: target, Stored: stored, TrashedAt: a.now()}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(prettyJSON(rec)), 0o666); err != nil {
		return rec, err
	}
	return rec, nil
}

func (a *AppTrash) Restore(stored, original string) error {
	if !exists(stored) {
		return toolErr("gone", tr.T("electron.common.the-file-in-the-trash-no-longer-exists"))
	}
	if err := MoveNoOverwrite(stored, original); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Dir(stored))
}

var reDay = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (a *AppTrash) Purge(maxAgeDays int) int {
	ents, err := os.ReadDir(a.root)
	if err != nil {
		return 0
	}
	cutoff := isoDay(a.now() - float64(maxAgeDays)*86400_000)
	n := 0
	for _, e := range ents {
		if reDay.MatchString(e.Name()) && e.Name() < cutoff {
			_ = os.RemoveAll(filepath.Join(a.root, e.Name()))
			n++
		}
	}
	return n
}
