package cli

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const sessionModelsFile = "session-models.json"

// MaxSessions = MAX_SESSIONS。
const MaxSessions = 5000

// SessionModelTable = SessionModelTable（有序 map：最近用过的在最后）。
type SessionModelTable struct {
	mu   sync.Mutex
	root string
	warn func(msg string, err error)
	keys []string
	m    map[string]string

	wq       sync.Mutex
	pending  string
	writing  bool
	inflight sync.WaitGroup
}

func NewSessionModelTable(root string, warn func(string, error)) *SessionModelTable {
	if warn == nil {
		warn = func(string, error) {}
	}
	return &SessionModelTable{root: root, warn: warn}
}

func (s *SessionModelTable) load() {
	if s.m != nil {
		return
	}
	s.m = map[string]string{}
	b, err := os.ReadFile(filepath.Join(s.root, sessionModelsFile))
	if err != nil {
		return
	}
	v, err := util.ParseString(string(b))
	if err != nil {
		return
	}
	o, ok := v.(*util.Obj)
	if !ok {
		return
	}
	arr, ok := o.Get("sessions").([]any)
	if !ok {
		return
	}
	for _, e := range arr {
		p, ok := e.([]any)
		if !ok || len(p) < 2 {
			continue
		}
		k, ok1 := p[0].(string)
		val, ok2 := p[1].(string)
		if ok1 && ok2 {
			s.set(k, val)
		}
	}
}

// set = Map.set（已存在的键保持原位置）
func (s *SessionModelTable) set(k, v string) {
	if _, ok := s.m[k]; !ok {
		s.keys = append(s.keys, k)
	}
	s.m[k] = v
}

func (s *SessionModelTable) del(k string) {
	if _, ok := s.m[k]; !ok {
		return
	}
	delete(s.m, k)
	for i, x := range s.keys {
		if x == k {
			s.keys = append(s.keys[:i:i], s.keys[i+1:]...)
			break
		}
	}
}

// Get（"" , false = undefined）。
func (s *SessionModelTable) Get(backend, sessionID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	v, ok := s.m[backend+":"+sessionID]
	return v, ok
}

// Note 记下这个会话这一轮用的模型；没变就不写。
func (s *SessionModelTable) Note(backend, sessionID, ref string) {
	sid := util.JSTrim(sessionID)
	if sid == "" || ref == "" {
		return
	}
	s.mu.Lock()
	s.load()
	key := backend + ":" + sid
	if v, ok := s.m[key]; ok && v == ref {
		s.mu.Unlock()
		return
	}
	s.del(key)
	s.set(key, ref)
	for len(s.keys) > MaxSessions {
		s.del(s.keys[0])
	}
	pairs := make([]any, len(s.keys))
	for i, k := range s.keys {
		pairs[i] = []any{k, s.m[k]}
	}
	data := util.Stringify(util.NewObj("version", 1.0, "sessions", pairs))
	s.mu.Unlock()
	file := filepath.Join(s.root, sessionModelsFile)
	// 异步落盘（writePrivateFileAtomicAsync）；按调用顺序串行，最后一次 note 的内容最终落盘
	s.wq.Lock()
	s.pending = data
	if !s.writing {
		s.writing = true
		s.inflight.Add(1)
		go s.drain(file)
	}
	s.wq.Unlock()
}

func (s *SessionModelTable) drain(file string) {
	for {
		s.wq.Lock()
		data := s.pending
		s.pending = ""
		if data == "" {
			s.writing = false
			s.wq.Unlock()
			s.inflight.Done()
			return
		}
		s.wq.Unlock()
		if err := utils.WritePrivateFileAtomic(file, []byte(data)); err != nil {
			s.warn("session-models write failed", err)
		}
	}
}

// Flush 等待已排队的异步落盘完成（测试 / 退出前用；Node 无对应，不影响可观察行为）。
func (s *SessionModelTable) Flush() { s.inflight.Wait() }
