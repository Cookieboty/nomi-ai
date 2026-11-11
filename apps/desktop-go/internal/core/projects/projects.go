// Package projects：项目 = 有名字的一组文件夹（userData/projects.json）。
//
// Primary 是主文件夹：会话的工作目录、相对路径的基准、git / worktree / AGENTS.md 的来源；
// Folders 是其余文件夹（不含 Primary，顺序即显示顺序），Nomi 与编程助手在里面同样能读写。
// 会话只记 projectId，目录由这里实时取（Roots），改了项目下一轮 / 下次启动起生效。
//
// 项目里的文件夹就是用户授权给 agent 的范围：新建 / 编辑时逐个过 Check（过宽的根、受保护目录、
// 不存在的目录都拒），同一项目里的文件夹不能彼此嵌套。之后文件夹被删、被加进受保护列表时，
// Roots 每次重新检查：主文件夹不行则整个项目不可用，其余文件夹不行则跳过（List 里标 Missing）。
package projects

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
)

// Project：落盘的项目
type Project struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Primary   string   `json:"primary"`
	Folders   []string `json:"folders"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
}

// View：给视图的项目（Missing = 此刻不能用的文件夹）
type View struct {
	Project
	Missing []string `json:"missing,omitempty"`
}

// Roots：一个项目此刻可用的目录（都是 realpath）。Primary 为空 = 不可用
type Roots struct {
	Primary string
	Extra   []string
}

// All：主文件夹在前
func (r Roots) All() []string {
	if r.Primary == "" {
		return nil
	}
	return append([]string{r.Primary}, r.Extra...)
}

// Empty：没有可用目录
func (r Roots) Empty() bool { return r.Primary == "" }

// Errors
var (
	ErrNotFound = errors.New("project not found")
)

// FolderError：某个文件夹不能当项目目录
type FolderError struct {
	Dir    string
	Reason string
}

func (e *FolderError) Error() string { return e.Dir + ": " + e.Reason }

// Deps：Check 返回 realpath 或不能用的原因（给用户看的文案）；Inside 判断 child 是否在 parent 里（含相等）
type Deps struct {
	File   string
	Check  func(dir string) (real string, reason string)
	Inside func(child, parent string) bool
	Emit   func([]View)
	Now    func() int64
}

type doc struct {
	Version  int       `json:"version"`
	Projects []Project `json:"projects"`
}

// Store：项目列表
type Store struct {
	d        Deps
	mu       sync.Mutex
	list     []Project
	existed  bool
	onChange []func(id string)
}

// OnChange：某个项目的文件夹变了或被移除（编排器据此让用它的标签按新的文件夹重启）
func (s *Store) OnChange(fn func(id string)) {
	s.mu.Lock()
	s.onChange = append(s.onChange, fn)
	s.mu.Unlock()
}

func (s *Store) changed(id string) {
	s.mu.Lock()
	fns := slices.Clone(s.onChange)
	s.mu.Unlock()
	for _, f := range fns {
		f(id)
	}
}

// New：读 projects.json（没有 = 空列表；Existed 为 false，首启迁移据此只做一次）
func New(d Deps) *Store {
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	if d.Inside == nil {
		d.Inside = func(c, p string) bool {
			rel, err := filepath.Rel(p, c)
			return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
		}
	}
	s := &Store{d: d}
	if b, err := os.ReadFile(d.File); err == nil {
		s.existed = true
		var dc doc
		if json.Unmarshal(b, &dc) == nil {
			for _, p := range dc.Projects {
				if p.ID == "" || p.Primary == "" {
					continue
				}
				if p.Folders == nil {
					p.Folders = []string{}
				}
				s.list = append(s.list, p)
			}
		}
	}
	return s
}

// Existed：启动时 projects.json 已经在（不再做首启迁移）
func (s *Store) Existed() bool { return s.existed }

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "p_" + hex.EncodeToString(b)
}

func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(doc{Version: 1, Projects: s.list}, "", "  ")
	if err != nil {
		return err
	}
	if err := utils.WritePrivateFileAtomic(s.d.File, b); err != nil {
		return err
	}
	s.existed = true
	return nil
}

func (s *Store) emit() {
	if s.d.Emit != nil {
		s.d.Emit(s.List())
	}
}

func (s *Store) check(dir string) (string, string) {
	if s.d.Check == nil {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return "", err.Error()
		}
		return abs, ""
	}
	return s.d.Check(dir)
}

func (s *Store) view(p Project) View {
	v := View{Project: p}
	v.Folders = slices.Clone(p.Folders)
	for _, f := range append([]string{p.Primary}, p.Folders...) {
		if _, reason := s.check(f); reason != "" {
			v.Missing = append(v.Missing, f)
		}
	}
	return v
}

// List：全部项目（创建先后）
func (s *Store) List() []View {
	s.mu.Lock()
	list := slices.Clone(s.list)
	s.mu.Unlock()
	out := make([]View, 0, len(list))
	for _, p := range list {
		out = append(out, s.view(p))
	}
	return out
}

// Get：按 id
func (s *Store) Get(id string) (Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.list {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}

// Roots：项目此刻可用的目录（每次重新检查）。项目不在或主文件夹不能用 → 空
func (s *Store) Roots(id string) Roots {
	p, ok := s.Get(id)
	if !ok {
		return Roots{}
	}
	prim, reason := s.check(p.Primary)
	if reason != "" {
		return Roots{}
	}
	r := Roots{Primary: prim}
	for _, f := range p.Folders {
		if real, reason := s.check(f); reason == "" && !slices.Contains(r.Extra, real) && real != prim {
			r.Extra = append(r.Extra, real)
		}
	}
	return r
}

// Contains：dir 是否在某个项目的某个文件夹里（含文件夹本身）；按存下的路径与 realpath 都比
func (s *Store) Contains(dir string) bool {
	if dir == "" {
		return false
	}
	real, _ := s.check(dir)
	s.mu.Lock()
	list := slices.Clone(s.list)
	s.mu.Unlock()
	for _, p := range list {
		for _, f := range append([]string{p.Primary}, p.Folders...) {
			if s.d.Inside(dir, f) || (real != "" && s.d.Inside(real, f)) {
				return true
			}
			if fr, reason := s.check(f); reason == "" && (s.d.Inside(dir, fr) || (real != "" && s.d.Inside(real, fr))) {
				return true
			}
		}
	}
	return false
}

// FindContaining：dir 所在的项目（在它的某个文件夹里，含文件夹本身）。几个项目都包含时取文件夹最深的那个，
// 例如项目 A 是 ~/ai、项目 B 是 ~/ai/app，~/ai/app/src 归 B。按存下的路径与 realpath 都比。
func (s *Store) FindContaining(dir string) (Project, bool) {
	if dir == "" {
		return Project{}, false
	}
	real, _ := s.check(dir)
	s.mu.Lock()
	list := slices.Clone(s.list)
	s.mu.Unlock()
	var best Project
	bestLen := -1
	for _, p := range list {
		for _, f := range append([]string{p.Primary}, p.Folders...) {
			cands := []string{f}
			if fr, reason := s.check(f); reason == "" && fr != f {
				cands = append(cands, fr)
			}
			for _, c := range cands {
				hit := s.d.Inside(dir, c) || (real != "" && s.d.Inside(real, c))
				if hit && len(c) > bestLen {
					best, bestLen = p, len(c)
				}
			}
		}
	}
	return best, bestLen >= 0
}

// FindByPrimary：主文件夹是 dir 的项目（迁移、「选择文件夹…」快捷建项目时复用）
func (s *Store) FindByPrimary(dir string) (Project, bool) {
	real, _ := s.check(dir)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.list {
		if same(p.Primary, dir) || (real != "" && same(p.Primary, real)) {
			return p, true
		}
		if pr, reason := s.check(p.Primary); reason == "" && real != "" && same(pr, real) {
			return p, true
		}
	}
	return Project{}, false
}

func same(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	return isCaseInsensitiveFS() && strings.EqualFold(a, b)
}

// normalize：校验并整理文件夹（去重、去掉与主文件夹相同的、拒绝彼此嵌套）；返回存的路径（原样的绝对路径）
func (s *Store) normalize(primary string, folders []string) (string, []string, error) {
	primary = strings.TrimSpace(primary)
	if primary == "" {
		return "", nil, &FolderError{Dir: "", Reason: "missing primary folder"}
	}
	type item struct{ dir, real string }
	all := []item{}
	add := func(dir string) error {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return nil
		}
		real, reason := s.check(dir)
		if reason != "" {
			return &FolderError{Dir: dir, Reason: reason}
		}
		for _, it := range all {
			if same(it.real, real) {
				return nil // 重复：忽略
			}
			if s.d.Inside(real, it.real) || s.d.Inside(it.real, real) {
				return &FolderError{Dir: dir, Reason: "nested:" + it.dir}
			}
		}
		all = append(all, item{filepath.Clean(dir), real})
		return nil
	}
	if err := add(primary); err != nil {
		return "", nil, err
	}
	for _, f := range folders {
		if err := add(f); err != nil {
			return "", nil, err
		}
	}
	out := make([]string, 0, len(all)-1)
	for _, it := range all[1:] {
		out = append(out, it.dir)
	}
	return all[0].dir, out, nil
}

func defaultName(primary, name string) string {
	if n := strings.TrimSpace(name); n != "" {
		return n
	}
	return filepath.Base(filepath.Clean(primary))
}

// Create：新建
func (s *Store) Create(name, primary string, folders []string) (View, error) {
	prim, rest, err := s.normalize(primary, folders)
	if err != nil {
		return View{}, err
	}
	now := s.d.Now()
	p := Project{ID: newID(), Name: defaultName(prim, name), Primary: prim, Folders: rest, CreatedAt: now, UpdatedAt: now}
	s.mu.Lock()
	s.list = append(s.list, p)
	err = s.saveLocked()
	if err != nil {
		s.list = s.list[:len(s.list)-1]
	}
	s.mu.Unlock()
	if err != nil {
		return View{}, err
	}
	s.emit()
	return s.view(p), nil
}

// Update：给了哪项改哪项（nil = 不改）；folders 是完整的新列表（不含 primary）
func (s *Store) Update(id string, name, primary *string, folders []string, foldersSet bool) (View, error) {
	cur, ok := s.Get(id)
	if !ok {
		return View{}, ErrNotFound
	}
	next := cur
	if name != nil {
		next.Name = defaultName(cur.Primary, *name)
	}
	prim := cur.Primary
	if primary != nil {
		prim = *primary
	}
	rest := cur.Folders
	if foldersSet {
		rest = folders
	}
	if primary != nil || foldersSet {
		p, r, err := s.normalize(prim, rest)
		if err != nil {
			return View{}, err
		}
		next.Primary, next.Folders = p, r
	}
	next.UpdatedAt = s.d.Now()
	s.mu.Lock()
	idx := slices.IndexFunc(s.list, func(p Project) bool { return p.ID == id })
	if idx < 0 {
		s.mu.Unlock()
		return View{}, ErrNotFound
	}
	s.list[idx] = next
	err := s.saveLocked()
	if err != nil {
		s.list[idx] = cur
	}
	s.mu.Unlock()
	if err != nil {
		return View{}, err
	}
	s.emit()
	if primary != nil || foldersSet {
		s.changed(id)
	}
	return s.view(next), nil
}

// Remove：只删记录，不碰磁盘
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	idx := slices.IndexFunc(s.list, func(p Project) bool { return p.ID == id })
	if idx < 0 {
		s.mu.Unlock()
		return ErrNotFound
	}
	old := s.list
	s.list = slices.Delete(slices.Clone(s.list), idx, idx+1)
	err := s.saveLocked()
	if err != nil {
		s.list = old
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	s.emit()
	s.changed(id)
	return nil
}

// Seed：迁移——把以前的单目录工作区各建成一个单文件夹项目（已有同主文件夹的复用、此刻不能用的跳过）。
// 返回 原路径 → 项目 id（跳过的不在里面）。可以重复调用：中途失败、目录后来又能用时，迁移会再跑
func (s *Store) Seed(dirs []string) (map[string]string, error) {
	out := map[string]string{}
	now := s.d.Now()
	s.mu.Lock()
	old := slices.Clone(s.list)
	for _, d := range dirs {
		d = strings.TrimSpace(d)
		if d == "" {
			continue
		}
		if _, ok := out[d]; ok {
			continue
		}
		real, reason := s.check(d)
		if reason != "" {
			continue
		}
		found := ""
		for _, p := range s.list {
			if same(p.Primary, d) || same(p.Primary, real) {
				found = p.ID
				break
			}
		}
		if found == "" {
			p := Project{ID: newID(), Name: defaultName(d, ""), Primary: filepath.Clean(d), Folders: []string{}, CreatedAt: now, UpdatedAt: now}
			s.list = append(s.list, p)
			found = p.ID
		}
		out[d] = found
	}
	var err error
	added := len(s.list) != len(old)
	if added || !s.existed {
		err = s.saveLocked()
	}
	if err != nil {
		s.list = old
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if !added {
		return out, nil
	}
	s.emit()
	return out, nil
}
