package desktop

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
	"time"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// AppTrash.ts：应用自己的回收站 <root>/<YYYY-MM-DD>/<uuid>/<basename> + manifest.json

// TrashRecord 回收记录
type TrashRecord struct {
	ID        string  `json:"id"`
	Original  string  `json:"original"`
	Stored    string  `json:"stored"`
	TrashedAt float64 `json:"trashedAt"`
}

// renameFS / copyData：测试注入点（模拟跨文件系统 EXDEV、复制中途失败）
var (
	renameFS = os.Rename
	copyData = func(dst io.Writer, src io.Reader) (int64, error) { return io.Copy(dst, src) }
)

// moveFS：move —— 先 rename；跨文件系统（EXDEV）时按 fs.promises.cp(recursive, errorOnExist) 复制再删源。
// 复制失败一律保留源并清掉本次写出的目标
func moveFS(from, to string) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o777); err != nil {
		return err
	}
	err := renameFS(from, to)
	if err == nil || !errors.Is(err, syscall.EXDEV) {
		return err
	}
	st, err := os.Lstat(from)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(to); err == nil {
		return toolErr("ERR_FS_CP_EEXIST", "Target already exists: "+to)
	}
	switch {
	case st.Mode().IsRegular():
		if err := copyFile(from, to, st); err != nil {
			return err
		}
		if err := os.Remove(from); err != nil {
			// 源删不掉（仍完整在原处）：撤回副本，等同移动没发生
			if _, serr := os.Lstat(from); serr == nil {
				_ = os.Remove(to)
			}
			return err
		}
		return nil
	case st.Mode()&os.ModeSymlink != 0:
		// fs.cp 默认不跟随链接：在目标处重建链接（verbatimSymlinks=false → 指向解析后的绝对路径）
		link, err := os.Readlink(from)
		if err != nil {
			return err
		}
		if !filepath.IsAbs(link) {
			link = filepath.Join(filepath.Dir(from), link)
		}
		if err := os.Symlink(link, to); err != nil {
			return err
		}
		return os.Remove(from)
	case st.IsDir():
		if err := os.CopyFS(to, os.DirFS(from)); err != nil {
			_ = os.RemoveAll(to)
			return err
		}
		// 目录删除可能只删掉一部分：此时目标是完整副本，保留它，不再回滚
		return os.RemoveAll(from)
	}
	return toolErr("ERR_FS_CP_UNKNOWN", "Cannot copy an unknown file type: "+from)
}

// copyFile：普通文件的有界流式复制 —— 排他创建目标、保留权限位，写完关闭并核对字节数后才算成功；
// 任何失败都删掉本次创建的目标
func copyFile(from, to string, st os.FileInfo) (err error) {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, st.Mode().Perm())
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return toolErr("ERR_FS_CP_EEXIST", "Target already exists: "+to)
		}
		return err
	}
	defer func() {
		if err != nil {
			_ = dst.Close()
			_ = os.Remove(to)
		}
	}()
	n, err := copyData(dst, src)
	if err != nil {
		return err
	}
	if n != st.Size() {
		return fmt.Errorf("copy %s: wrote %d of %d bytes", from, n, st.Size())
	}
	if err = dst.Chmod(st.Mode().Perm()); err != nil {
		return err
	}
	if err = dst.Close(); err != nil {
		return err
	}
	got, err := os.Stat(to)
	if err != nil {
		return err
	}
	if got.Size() != st.Size() {
		return fmt.Errorf("copy %s: target has %d of %d bytes", from, got.Size(), st.Size())
	}
	return nil
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
	cutoff := isoDay(a.now() - float64(float64(maxAgeDays)*86400_000))
	n := 0
	for _, e := range ents {
		if reDay.MatchString(e.Name()) && e.Name() < cutoff {
			_ = os.RemoveAll(filepath.Join(a.root, e.Name()))
			n++
		}
	}
	return n
}
