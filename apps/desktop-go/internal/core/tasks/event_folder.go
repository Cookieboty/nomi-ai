package tasks

// `folder` 事件源（§6.2），对应 src/tasks/events/sources/folder.ts：本机文件夹的新文件 / 改动。
// 目录必须在任务授权的路径里。扫描最多 3 层、2000 个文件，跳过隐藏目录与 node_modules。
// 与 Node 的差别：Go 模块没有 fsnotify（不为此加依赖），这里没有 Watch，只靠 5 分钟一次的扫描。

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

type FolderFilter struct {
	Path      string `json:"path"`
	Recursive *bool  `json:"recursive,omitempty"`
}

const (
	folderMaxFiles = 2000
	folderMaxDepth = 3
)

func pathInside(root, p string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(p))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

// ScanFolder：相对路径（/ 分隔）→ `mtimeMs:size`
func ScanFolder(root string, recursive bool) map[string]string {
	out := map[string]string{}
	n := 0
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		ents, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range ents {
			if n >= folderMaxFiles {
				return
			}
			name := e.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" {
				continue
			}
			p := filepath.Join(dir, name)
			if e.IsDir() {
				if recursive && depth < folderMaxDepth {
					walk(p, depth+1)
				}
			} else if e.Type().IsRegular() {
				st, err := os.Stat(p)
				if err != nil {
					continue // 扫描途中被删
				}
				rel, _ := filepath.Rel(root, p)
				out[filepath.ToSlash(rel)] = fmt.Sprintf("%d:%d", st.ModTime().UnixMilli(), st.Size())
				n++
			}
		}
	}
	walk(root, 1)
	return out
}

type FolderSourceDeps struct {
	Now func() int64
	T   i18n.Translate
}

func NewFolderSource(d FolderSourceDeps) *EventSource {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.T == nil {
		d.T = i18n.T
	}
	return &EventSource{
		ID:            "folder",
		MinIntervalMs: 5 * 60_000,
		Validate: func(filter json.RawMessage, t Task) string {
			var f FolderFilter
			if len(filter) == 0 || json.Unmarshal(filter, &f) != nil || f.Path == "" || !filepath.IsAbs(f.Path) {
				return "absolute path required"
			}
			ok := false
			for _, g := range t.Grant.Paths {
				if pathInside(g, f.Path) {
					ok = true
					break
				}
			}
			if !ok {
				return "path not granted: " + f.Path
			}
			st, err := os.Stat(f.Path)
			if err != nil {
				return "not found"
			}
			if !st.IsDir() {
				return "not a directory"
			}
			return ""
		},
		Poll: func(_ context.Context, filter json.RawMessage, cursor *string, _ Task) (PollResult, error) {
			var f FolderFilter
			if err := json.Unmarshal(filter, &f); err != nil {
				return PollResult{}, err
			}
			var prev map[string]string
			if cursor != nil {
				_ = json.Unmarshal([]byte(*cursor), &prev)
			}
			cur := ScanFolder(f.Path, f.Recursive == nil || *f.Recursive)
			events := []SourceEvent{}
			if prev != nil {
				rels := make([]string, 0, len(cur))
				for rel := range cur {
					rels = append(rels, rel)
				}
				sort.Strings(rels) // Go 的 map 无序：按路径排，结果稳定
				for _, rel := range rels {
					sig := cur[rel]
					old, had := prev[rel]
					if had && old == sig {
						continue
					}
					at, _ := strconv.ParseInt(strings.SplitN(sig, ":", 2)[0], 10, 64)
					if at == 0 {
						at = d.Now()
					}
					change, summary := "modified", d.T("electron.common.task-event-file-changed", rel)
					if !had {
						change, summary = "new", d.T("electron.common.task-event-file-new", rel)
					}
					events = append(events, SourceEvent{
						Key:        "folder:" + rel + ":" + sig,
						OccurredAt: at,
						Summary:    summary,
						Payload:    map[string]any{"folder": f.Path, "file": rel, "change": change},
					})
				}
			}
			return PollResult{Events: events, Cursor: jsonCursor(cur), Baseline: prev == nil}, nil
		},
	}
}
