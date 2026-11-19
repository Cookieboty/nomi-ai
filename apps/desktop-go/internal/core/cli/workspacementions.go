package cli

// workspacementions.go：输入框 @ 路径补全。依赖 / 缓存目录不进「文件」树，但可以作为引用候选。

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	workspaceMentionVisitCap     = 5000
	workspaceMentionDefaultLimit = 50
	workspaceMentionMaxLimit     = 200
)

type mentionHit struct {
	path, name, kind string
	score            int
}

func MentionLimit(v any) int {
	n := 0
	switch x := v.(type) {
	case float64:
		n = int(x)
	case int:
		n = x
	case int64:
		n = int(x)
	default:
		return workspaceMentionDefaultLimit
	}
	if n < 1 || n > workspaceMentionMaxLimit {
		return workspaceMentionDefaultLimit
	}
	return n
}

func mentionScore(rel, name, q string) int {
	if q == "" {
		return 1
	}
	if strings.Contains(strings.ToLower(name), q) {
		return 2
	}
	if strings.Contains(strings.ToLower(rel), q) {
		return 1
	}
	return 0
}

func mentionRel(dir, name string) string {
	if dir == "" {
		return name
	}
	return dir + "/" + name
}

func isSymlinkEntry(e os.DirEntry) bool {
	return e.Type()&os.ModeSymlink != 0
}

func isDirNoFollow(e os.DirEntry) bool {
	return !isSymlinkEntry(e) && e.IsDir()
}

func addMention(hits *[]mentionHit, rel, name, kind, q string, score2 *int) {
	s := mentionScore(rel, name, q)
	if s == 0 {
		return
	}
	*hits = append(*hits, mentionHit{path: rel, name: name, kind: kind, score: s})
	if s == 2 {
		*score2++
	}
}

func sortMentionHits(hits []mentionHit, limit int) []mentionHit {
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].path < hits[j].path
	})
	if len(hits) > limit {
		return hits[:limit]
	}
	return hits
}

// ListWorkspaceMentionPaths：给输入框 @ 补全用的短列表（不是整棵文件树）。
// 始终包含工作区内已有的依赖 / 缓存 / .next 目录节点本身（不含 .git 等版本库目录、不含垃圾文件）。
// query 非空时再在这些目录内部搜索（不跟随符号链接目录，visited 上限约 5000），
// 打分与前端 filterAtPathOptions 一致：basename 子串 = 2，路径子串 = 1，再按路径排序，截到 limit。
func ListWorkspaceMentionPaths(cwd, query string, limit int) *util.Obj {
	root := resolveFrom(absOf("."), cwd)
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return util.NewObj("ok", false, "error", "invalid cwd", "code", "invalid")
	}
	if limit < 1 || limit > workspaceMentionMaxLimit {
		limit = workspaceMentionDefaultLimit
	}
	q := strings.ToLower(strings.TrimSpace(query))
	hits := collectMentionHits(root, q, limit)
	entries := make([]any, 0, len(hits))
	for _, h := range hits {
		entries = append(entries, util.NewObj("path", h.path, "kind", h.kind, "name", h.name))
	}
	return util.NewObj("ok", true, "entries", entries)
}

func collectMentionHits(root, q string, limit int) []mentionHit {
	hits := []mentionHit{}
	score2 := 0
	skipTops := []string{}

	// 与 walkDisk 一样扫可见树：遇到依赖 / 缓存 / .next 只记下目录节点，不递归进「文件」树会跳过的大目录。
	// 版本库目录完全跳过；符号链接目录不跟随，但名称是依赖 / 缓存目录时仍作为候选（例如链接出来的 node_modules）。
	level := []string{""}
	for len(level) > 0 {
		next := []string{}
		for _, relDir := range level {
			es, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(relDir)))
			if err != nil {
				continue
			}
			for _, e := range es {
				name := e.Name()
				if wsVcsDirs[name] {
					continue
				}
				rel := mentionRel(relDir, name)
				if !wsInsideRel(filepath.FromSlash(rel)) {
					continue
				}
				link := isSymlinkEntry(e)
				if wsSkipDepOrCache(name) {
					addMention(&hits, rel, name, "dir", q, &score2)
					if q != "" && !link {
						skipTops = append(skipTops, rel)
					}
					continue
				}
				if link {
					continue
				}
				if e.IsDir() {
					next = append(next, rel)
				}
			}
		}
		level = next
	}

	if q == "" || score2 >= limit {
		return sortMentionHits(hits, limit)
	}

	visited := 0
	interior := skipTops
	for len(interior) > 0 && visited <= workspaceMentionVisitCap && score2 < limit {
		next := []string{}
		for _, relDir := range interior {
			if visited > workspaceMentionVisitCap || score2 >= limit {
				break
			}
			es, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(relDir)))
			if err != nil {
				continue
			}
			for _, e := range es {
				if visited > workspaceMentionVisitCap || score2 >= limit {
					break
				}
				visited++
				name := e.Name()
				if wsVcsDirs[name] || wsJunk[name] {
					continue
				}
				rel := mentionRel(relDir, name)
				if !wsInsideRel(filepath.FromSlash(rel)) {
					continue
				}
				link := isSymlinkEntry(e)
				if isDirNoFollow(e) {
					addMention(&hits, rel, name, "dir", q, &score2)
					next = append(next, rel)
					continue
				}
				if link {
					continue
				}
				if e.Type().IsRegular() {
					addMention(&hits, rel, name, "file", q, &score2)
				}
			}
		}
		interior = next
	}
	return sortMentionHits(hits, limit)
}
