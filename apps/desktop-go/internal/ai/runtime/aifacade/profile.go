package aifacade

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ProfileStore：bundle-ig-base ProfileStore + FileProfileStorage
// （rootDir/ai-chat/memory/user_profile.json；写入走 tmp + rename）。
type ProfileStore struct {
	mu        sync.Mutex
	file      string
	now       func() float64
	profile   any
	loaded    bool
	listeners []func(any)
}

// ProfilePath：Node 的持久化位置
func ProfilePath(rootDir string) string {
	return filepath.Join(rootDir, "ai-chat", "memory", "user_profile.json")
}

func defaultProfile(now float64) *u.Obj {
	o := u.NewObj()
	o.Set("version", 1.0)
	o.Set("identity", u.NewObj())
	o.Set("preferences", u.NewObj())
	o.Set("habits", u.NewObj())
	o.Set("dislikes", []any{})
	o.Set("createdAt", now)
	o.Set("updatedAt", now)
	return o
}

// NewProfileStore：file 为空 = 不持久化
func NewProfileStore(file string, now func() float64) *ProfileStore {
	return &ProfileStore{file: file, now: now, profile: defaultProfile(now())}
}

// OnChanged：userProfile:changed
func (s *ProfileStore) OnChanged(fn func(any)) { s.listeners = append(s.listeners, fn) }

func deepClone(v any) any {
	switch x := v.(type) {
	case *u.Obj:
		o := u.NewObj()
		for _, k := range x.Keys() {
			o.Set(k, deepClone(x.Get(k)))
		}
		return o
	case []any:
		a := make([]any, len(x))
		for j, e := range x {
			a[j] = deepClone(e)
		}
		return a
	}
	return v
}

func jsTypeof(v any) string {
	switch v.(type) {
	case float64:
		return "number"
	case string:
		return "string"
	case bool:
		return "boolean"
	}
	return "object"
}

func jsString(v any) string {
	switch x := v.(type) {
	case float64:
		return u.FormatNumber(x)
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return ""
}

// deepMerge：两边都是普通对象才递归，否则覆盖；undefined 跳过
func deepMerge(base any, patch *u.Obj) (any, error) {
	b, ok := base.(*u.Obj)
	if !ok {
		if _, isArr := base.([]any); isArr {
			return base, nil // 数组上的非下标键赋值对后续校验不可见
		}
		k := "updatedAt"
		if patch.Len() > 0 {
			k = patch.Keys()[0]
		}
		return nil, fmt.Errorf("Cannot create property '%s' on %s '%s'", k, jsTypeof(base), jsString(base))
	}
	for _, k := range patch.Keys() {
		v := patch.Get(k)
		if isUndef(v) {
			continue
		}
		pv, pok := v.(*u.Obj)
		bv, bok := b.Get(k).(*u.Obj)
		if pok && bok && b.Has(k) {
			m, err := deepMerge(bv, pv)
			if err != nil {
				return nil, err
			}
			b.Set(k, m)
		} else {
			b.Set(k, v)
		}
	}
	return b, nil
}

func (s *ProfileStore) read() any {
	if s.file == "" {
		return nil
	}
	data, err := os.ReadFile(s.file)
	if err != nil {
		return nil
	}
	v, err := u.Parse(data)
	if err != nil {
		return nil
	}
	return v
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && x == x
	case string:
		return x != ""
	}
	return true
}

func (s *ProfileStore) ensureLoaded() {
	if s.loaded {
		return
	}
	s.loaded = true
	if p := s.read(); truthy(p) {
		s.profile = p
	}
}

func (s *ProfileStore) write(p any) error {
	if s.file == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp-%d-%s", s.file, os.Getpid(), u.FormatNumber(s.now()))
	if err := os.WriteFile(tmp, []byte(u.StringifyIndent(p, "  ")), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func (s *ProfileStore) fire() {
	snap := deepClone(s.profile)
	for _, fn := range s.listeners {
		fn(snap)
	}
}

// Get：不触发加载
func (s *ProfileStore) Get() any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return deepClone(s.profile)
}

// Export：加载后返回
func (s *ProfileStore) Export() any {
	s.mu.Lock()
	s.ensureLoaded()
	s.mu.Unlock()
	return s.Get()
}

func zodError(iss []*issue) error { return errors.New(IssuesMessage(iss)) }

// Set：patch 为 ProfilePatch.patch
func (s *ProfileStore) Set(patch *u.Obj) (any, error) {
	s.mu.Lock()
	s.ensureLoaded()
	next, err := deepMerge(deepClone(s.profile), patch)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if o, ok := next.(*u.Obj); ok {
		o.Set("updatedAt", s.now())
	}
	out, iss, ok := Parse(userProfileStrict, next)
	if !ok {
		s.mu.Unlock()
		return nil, zodError(iss)
	}
	s.profile = out
	if err := s.write(out); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.mu.Unlock()
	s.fire()
	return s.Get(), nil
}

// Reset：回默认
func (s *ProfileStore) Reset() (any, error) {
	s.mu.Lock()
	s.profile = defaultProfile(s.now())
	err := s.write(s.profile)
	s.loaded = true
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	s.fire()
	return s.Get(), nil
}

// Import：严格校验后整体替换
func (s *ProfileStore) Import(data any) (any, error) {
	out, iss, ok := Parse(userProfileStrict, data)
	if !ok {
		return nil, zodError(iss)
	}
	s.mu.Lock()
	s.profile = out
	err := s.write(out)
	if err == nil {
		s.loaded = true
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	s.fire()
	return s.Get(), nil
}

// GetPath = ProfileStore.getPath：点路径逐段取值（不触发加载；非对象中途返回 undefined）
func (s *ProfileStore) GetPath(path string) any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var cur any = s.profile
	for _, p := range strings.Split(path, ".") {
		switch c := cur.(type) {
		case *u.Obj:
			if !c.Has(p) {
				return Undef
			}
			cur = c.Get(p)
		case []any:
			if p == "length" {
				cur = float64(len(c))
				continue
			}
			n, err := strconv.ParseUint(p, 10, 32)
			if err != nil || strconv.FormatUint(n, 10) != p || n >= uint64(len(c)) {
				return Undef
			}
			cur = c[n]
		default:
			return Undef
		}
	}
	return deepClone(cur)
}
