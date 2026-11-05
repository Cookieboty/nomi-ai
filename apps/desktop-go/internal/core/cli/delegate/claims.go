package delegate

// claims.go：同一个 git 仓库里直接改（in-place）的并行委派：按文件登记谁在改。
// 两个任务改到同一个文件时按优先级裁决（urgent > high > medium > low；同级先来的优先），
// 让路的一方收到插话（steer）：别再动这个文件。收尾时这个文件算赢的一方的改动，
// 别的任务同时改的文件也不算进自己的改动列表。
// 改了哪个文件来自编程助手的工具事件（Edit / Write / apply_patch 等的入参）；跑命令改的文件认不出来，
// 收尾时按 git 列出、又没被别人登记的仍算自己的。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// PriorityRank：数字越小越优先；没填 = medium
func PriorityRank(p string) int {
	switch p {
	case "urgent":
		return 0
	case "high":
		return 1
	case "low":
		return 3
	}
	return 2
}

type claimRun struct {
	tabID, root, cwd, label string
	rank                    int
	start, end              int64 // 逻辑时钟；end = 0 表示还在跑
	owned                   map[string]bool
	yielded                 map[string]string // 文件 → 赢的一方
	warned                  map[string]bool
}

// Claims：并行直接改的文件登记处（进程内一份，委派与持续任务共用）
type Claims struct {
	mu    sync.Mutex
	clock int64
	runs  map[string]*claimRun
	done  []*claimRun
	steer func(tabID, text string) bool
}

func NewClaims() *Claims { return &Claims{runs: map[string]*claimRun{}} }

// SetSteer：给正在跑的标签插话（编排器的 SteerTab）；不设则只登记不插话
func (c *Claims) SetSteer(fn func(tabID, text string) bool) {
	c.mu.Lock()
	c.steer = fn
	c.mu.Unlock()
}

// Register：标签开始在 root（git 仓库根）里直接改；同一个标签再登记（追问、退回重做）重新开始一段
func (c *Claims) Register(tabID, root, cwd, priority, label string) {
	if c == nil || tabID == "" || root == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.clock++
	c.runs[tabID] = &claimRun{tabID: tabID, root: realPath(root), cwd: realPath(cwd), label: label,
		rank: PriorityRank(priority), start: c.clock,
		owned: map[string]bool{}, yielded: map[string]string{}, warned: map[string]bool{}}
}

// Active：标签是否登记着（事件过滤用）
func (c *Claims) Active(tabID string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.runs[tabID] != nil
}

func (c *Claims) abs(r *claimRun, p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(r.cwd, p)
	}
	p = filepath.Clean(p)
	if _, err := os.Lstat(p); err == nil {
		return realPath(p)
	}
	return filepath.Join(realPath(filepath.Dir(p)), filepath.Base(p))
}

func inside(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// wins：a 比 b 优先
func wins(a, b *claimRun) bool {
	if a.rank != b.rank {
		return a.rank < b.rank
	}
	return a.start < b.start
}

func yieldText(file, winner string) string {
	return "（Nomi 协调）文件 " + file + " 正由另一个优先级更高的任务「" + winner + "」修改。" +
		"不要再改这个文件；已经改过的保持原样，不要撤回。如果你的任务还需要改它，在汇报的「没做完的」里写清楚要改什么。"
}

// Touch：标签改了这些文件（绝对路径或相对它的工作目录）。和同仓库里别的运行中任务撞上时裁决，输的一方插话
func (c *Claims) Touch(tabID string, paths []string) {
	if c == nil || len(paths) == 0 {
		return
	}
	type note struct{ tab, text string }
	var notes []note
	c.mu.Lock()
	me := c.runs[tabID]
	if me == nil {
		c.mu.Unlock()
		return
	}
	for _, raw := range paths {
		f := c.abs(me, raw)
		if f == "" || !inside(me.root, f) || me.owned[f] {
			continue
		}
		if _, gave := me.yielded[f]; gave {
			continue
		}
		var holder *claimRun
		for _, o := range c.runs {
			if o != me && o.root == me.root && o.owned[f] {
				holder = o
				break
			}
		}
		rel, _ := filepath.Rel(me.root, f)
		switch {
		case holder == nil:
			me.owned[f] = true
		case wins(me, holder):
			delete(holder.owned, f)
			holder.yielded[f] = me.label
			me.owned[f] = true
			if !holder.warned[f] {
				holder.warned[f] = true
				notes = append(notes, note{holder.tabID, yieldText(rel, me.label)})
			}
		default:
			me.yielded[f] = holder.label
			if !me.warned[f] {
				me.warned[f] = true
				notes = append(notes, note{me.tabID, yieldText(rel, holder.label)})
			}
		}
	}
	steer := c.steer
	c.mu.Unlock()
	if steer != nil {
		for _, n := range notes {
			go steer(n.tab, n.text)
		}
	}
}

// ClaimOutcome：一段直接改结束时的归属
type ClaimOutcome struct {
	cwd     string
	yielded map[string]string // 让给了别人的文件 → 赢的一方
	foreign map[string]bool   // 同期别的任务改的文件
}

// Finish：标签这一段结束；返回归属（没登记过返回 nil）
func (c *Claims) Finish(tabID string) *ClaimOutcome {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	me := c.runs[tabID]
	if me == nil {
		return nil
	}
	delete(c.runs, tabID)
	c.clock++
	me.end = c.clock
	out := &ClaimOutcome{cwd: me.cwd, yielded: me.yielded, foreign: map[string]bool{}}
	overlap := func(o *claimRun) bool {
		return o != me && o.root == me.root && (o.end == 0 || o.end > me.start)
	}
	for _, o := range c.runs {
		if overlap(o) {
			for f := range o.owned {
				out.foreign[f] = true
			}
		}
	}
	for _, o := range c.done {
		if overlap(o) {
			for f := range o.owned {
				out.foreign[f] = true
			}
		}
	}
	for f := range me.owned {
		delete(out.foreign, f)
	}
	c.done = append(c.done, me)
	// 结束了的段只为和它同期的任务保留：同仓库里没有比它早开始的运行中任务就丢掉
	kept := c.done[:0]
	for _, d := range c.done {
		need := false
		for _, o := range c.runs {
			if o.root == d.root && o.start < d.end {
				need = true
				break
			}
		}
		if need {
			kept = append(kept, d)
		}
	}
	c.done = kept
	return out
}

// Filter：把改动列表（相对工作目录）分成自己的、让给了别人的（附赢的一方）
func (o *ClaimOutcome) Filter(changed []string) (mine []string, yielded []string) {
	mine = []string{}
	yielded = []string{}
	if o == nil {
		return append(mine, changed...), yielded
	}
	for _, rel := range changed {
		f := filepath.Clean(filepath.Join(o.cwd, rel))
		if w, ok := o.yielded[f]; ok {
			yielded = append(yielded, rel+"（让给了「"+w+"」）")
			continue
		}
		if o.foreign[f] {
			continue
		}
		mine = append(mine, rel)
	}
	return mine, yielded
}

var (
	editToolRe  = regexp.MustCompile(`(?i)edit|write|patch|create|delete|remove|rename|move|replace|insert|file_?change|notebook`)
	patchFileRe = regexp.MustCompile(`(?m)^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$`)
	pathKeys    = map[string]bool{"file_path": true, "filePath": true, "path": true, "notebook_path": true,
		"target_file": true, "targetFile": true, "filename": true, "file": true, "abs_path": true, "absolute_path": true,
		"new_path": true, "newPath": true, "old_path": true, "destination": true}
)

// EditedPaths：改文件类工具事件的入参里认出被改的文件（Claude 的 file_path、Codex file_change 的 changes[].path、
// apply_patch 的文件头……）；不是改文件的工具返回空
func EditedPaths(name, input string) []string {
	if !editToolRe.MatchString(name) || strings.TrimSpace(input) == "" {
		return nil
	}
	out := []string{}
	seen := map[string]bool{}
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p != "" && !seen[p] && !strings.ContainsAny(p, "\n\x00") {
			seen[p] = true
			out = append(out, p)
		}
	}
	var walk func(v any, depth int)
	walk = func(v any, depth int) {
		if depth > 6 {
			return
		}
		switch x := v.(type) {
		case *util.Obj:
			for _, k := range x.Keys() {
				val := x.Get(k)
				if s, ok := val.(string); ok {
					if pathKeys[k] {
						add(s)
					} else if strings.Contains(s, "*** ") {
						for _, m := range patchFileRe.FindAllStringSubmatch(s, -1) {
							add(m[1] + m[2])
						}
					}
					continue
				}
				walk(val, depth+1)
			}
		case []any:
			for _, it := range x {
				walk(it, depth+1)
			}
		}
	}
	if v, err := util.ParseString(input); err == nil {
		walk(v, 0)
	} else {
		for _, m := range patchFileRe.FindAllStringSubmatch(input, -1) {
			add(m[1] + m[2])
		}
	}
	return out
}
