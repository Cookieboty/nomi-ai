package delegate

// edit_log.go：委派标签里改过哪些文件（来自 agent 的工具事件：Edit / Write / apply_patch 的入参），
// 带时间记下来。收尾时据此补齐 git 核对不出来的改动：
//   - 委派之前工作区里就有改动的文件（git 前后都是「已修改」，按前后差集会被丢掉）；
//   - 委派之后用户在子任务里接着对话的轮次（没有前后快照，原来只回报了文字）；
//   - 失败 / 被停下的那一次（任务执行没有结果，原来一个文件都不带）。
// 只在内存里（重启后靠 git 与汇报），每个标签最多留最近 maxEditsPerTab 条。

import (
	"path/filepath"
	"strings"
	"sync"
)

const maxEditsPerTab = 2000

type editMark struct {
	path string
	at   float64
}

// EditLog：标签 id → 改文件的工具事件（路径按工具入参原样，可能是绝对路径）
type EditLog struct {
	mu   sync.Mutex
	tabs map[string][]editMark
}

func NewEditLog() *EditLog { return &EditLog{tabs: map[string][]editMark{}} }

// Edits：编排器的工具事件写进来（main 里接线），委派收尾时读
var Edits = NewEditLog()

// Note：标签 tabID 在 at（毫秒）改了这些文件
func (l *EditLog) Note(tabID string, paths []string, at float64) {
	if l == nil || tabID == "" || len(paths) == 0 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	list := l.tabs[tabID]
	for _, p := range paths {
		list = append(list, editMark{path: p, at: at})
	}
	if n := len(list); n > maxEditsPerTab {
		list = append([]editMark(nil), list[n-maxEditsPerTab:]...)
	}
	l.tabs[tabID] = list
}

// Since：标签在 [from, to] 之间改过的文件，按 cwd 转成相对路径（cwd 外的绝对路径原样），去重、保持先后顺序。
// to <= 0 表示到现在。
func (l *EditLog) Since(tabID, cwd string, from, to float64) []string {
	if l == nil || tabID == "" {
		return nil
	}
	l.mu.Lock()
	marks := append([]editMark(nil), l.tabs[tabID]...)
	l.mu.Unlock()
	out := []string{}
	seen := map[string]bool{}
	for _, m := range marks {
		if m.at < from || (to > 0 && m.at > to) {
			continue
		}
		p := relToCwd(cwd, m.path)
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// Forget：标签关掉后不再需要
func (l *EditLog) Forget(tabID string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	delete(l.tabs, tabID)
	l.mu.Unlock()
}

// Retain：只保留还开着的标签（编排器标签列表变更时清理已关闭标签的记录）
func (l *EditLog) Retain(liveIDs []string) {
	if l == nil {
		return
	}
	keep := make(map[string]bool, len(liveIDs))
	for _, id := range liveIDs {
		if id != "" {
			keep[id] = true
		}
	}
	l.mu.Lock()
	for id := range l.tabs {
		if !keep[id] {
			delete(l.tabs, id)
		}
	}
	l.mu.Unlock()
}

// relToCwd：cwd 里的绝对路径 → 相对 cwd（统一用 /，与 git status 的列表一致）；相对路径整理一下原样返回
func relToCwd(cwd, p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if !filepath.IsAbs(p) {
		return filepath.ToSlash(filepath.Clean(p))
	}
	if cwd != "" {
		if rel, err := filepath.Rel(filepath.Clean(cwd), filepath.Clean(p)); err == nil &&
			rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return filepath.ToSlash(rel)
		}
		// macOS 的 /var → /private/var 一类：按真实路径再比一次
		if rc, rp := realPath(cwd), realPath(p); rc != "" && rp != "" {
			if rel, err := filepath.Rel(rc, rp); err == nil &&
				rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return filepath.ToSlash(rel)
			}
		}
	}
	return filepath.ToSlash(filepath.Clean(p))
}

// mergeFiles：a 后面接上 b 里 a 没有的（保持先后顺序）
func mergeFiles(a, b []string) []string {
	out := append([]string{}, a...)
	for _, f := range b {
		if f != "" && !contains(out, f) {
			out = append(out, f)
		}
	}
	return out
}
