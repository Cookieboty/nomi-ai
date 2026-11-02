package tasks

// 持续任务的存储，移植 src/tasks/TaskStore.ts（docs/design/persistent-tasks.md §4.3），读写同一格式：
// <id>.json（任务 + 最近 KeepAttempts 次执行，原子写）、<id>.events.jsonl（只追加的事件日志）、
// <id>.attempts.jsonl（旧执行归档）。读 jsonl 时跳过崩溃留下的半行；追加前若文件不以换行结尾先补换行。

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// KeepAttempts：快照里保留的执行条数
const KeepAttempts = 50

type Record struct {
	Task     Task      `json:"task"`
	Attempts []Attempt `json:"attempts"`
}

// JournalEntry 对应 TaskStore.ts 的 JournalEntry 判别联合（按 T 区分）
type JournalEntry struct {
	T         string `json:"t"`
	At        int64  `json:"at"`
	Event     string `json:"event,omitempty"`
	From      string `json:"from,omitempty"`
	To        string `json:"to,omitempty"`
	Gen       *int   `json:"gen,omitempty"`
	AttemptID string `json:"attemptId,omitempty"`
	Seq       *int   `json:"seq,omitempty"`
	Action    string `json:"action,omitempty"`
	Hash      string `json:"hash,omitempty"`
	// Key：幂等键 taskId:attemptId:seq（2.1.0 起；写进外部内容供自动核对）
	Key string `json:"key,omitempty"`
	// Summary：intent 给人看的摘要
	Summary string `json:"summary,omitempty"`
	// Target：核对用的目标（仓库、编号、分支、MCP 服务器与工具），保持键顺序
	Target     *u.Obj  `json:"target,omitempty"`
	ExternalID *string `json:"externalId,omitempty"`
	Msg        string  `json:"msg,omitempty"`
	// By：done / failed 由谁关闭（reconcile = 自动核对，user = 用户核对；执行中写的没有）
	By string `json:"by,omitempty"`
}

type Logger interface {
	Warn(msg string, kv ...any)
}

var idRE = regexp.MustCompile(`^task_[A-Za-z0-9_-]{1,80}$`)

func IsTaskID(id string) bool { return idRE.MatchString(id) }

// 单测注入：模拟写到一半崩溃
var (
	writeAtomic = func(file string, data []byte) error { return utils.WritePrivateFileAtomic(file, data) }
	appendRaw   = func(file string, data []byte) error {
		f, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		_, err = f.Write(data)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		return err
	}
)

type Store struct {
	dir string
	log Logger
	// appendMu：事件日志的追加来自运行时与执行中的对外工具（副作用日志），串行化
	appendMu sync.Mutex
}

func NewStore(dir string, log Logger) *Store { return &Store{dir: dir, log: log} }

func (s *Store) file(id, suffix string) (string, error) {
	if !IsTaskID(id) {
		return "", errors.New("invalid task id: " + id)
	}
	return filepath.Join(s.dir, id+suffix), nil
}

func (s *Store) ensureDir() error { return os.MkdirAll(s.dir, 0o700) }

func appendLines(file string, data []byte) error {
	if f, err := os.Open(file); err == nil {
		st, serr := f.Stat()
		if serr == nil && st.Size() > 0 {
			b := make([]byte, 1)
			if _, rerr := f.ReadAt(b, st.Size()-1); rerr == nil && b[0] != '\n' {
				data = append([]byte{'\n'}, data...)
			}
		}
		_ = f.Close()
	}
	return appendRaw(file, data)
}

func readJsonl[T any](file string) []T {
	b, err := os.ReadFile(file)
	if err != nil {
		return []T{}
	}
	out := []T{}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var v T
		if json.Unmarshal([]byte(line), &v) == nil {
			out = append(out, v)
		}
	}
	return out
}

// LoadAll：读全部任务，坏文件记日志后跳过，按 id 排序
func (s *Store) LoadAll() []Record {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return []Record{}
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	out := []Record{}
	for _, name := range names {
		id, ok := strings.CutSuffix(name, ".json")
		if !ok || !IsTaskID(id) {
			continue
		}
		if r, err := s.Load(id); err == nil && r != nil {
			out = append(out, *r)
		}
	}
	return out
}

// Load：文件不存在或格式不对返回 nil（格式不对记日志）；id 不合法返回错误
func (s *Store) Load(id string) (*Record, error) {
	f, err := s.file(id, ".json")
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(f)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.log.Warn("任务文件读取失败", "id", id, "error", err.Error())
		}
		return nil, nil
	}
	var probe struct {
		Task *struct {
			ID            string  `json:"id"`
			Status        *string `json:"status"`
			SchemaVersion int     `json:"schemaVersion"`
		} `json:"task"`
		Attempts json.RawMessage `json:"attempts"`
	}
	var r Record
	if json.Unmarshal(b, &probe) != nil || probe.Task == nil || probe.Task.ID != id ||
		probe.Task.Status == nil || probe.Task.SchemaVersion != SchemaVersion ||
		!bytes.HasPrefix(bytes.TrimSpace(probe.Attempts), []byte("[")) || json.Unmarshal(b, &r) != nil {
		s.log.Warn("任务文件格式不对，已跳过", "id", id)
		return nil, nil
	}
	if r.Attempts == nil {
		r.Attempts = []Attempt{}
	}
	return &r, nil
}

// Save：原子写快照；执行超过 KeepAttempts 时最旧的先追加进归档再截掉
func (s *Store) Save(r Record) (Record, error) {
	if err := s.ensureDir(); err != nil {
		return r, err
	}
	attempts := r.Attempts
	if attempts == nil {
		attempts = []Attempt{}
	}
	if len(attempts) > KeepAttempts {
		f, err := s.file(r.Task.ID, ".attempts.jsonl")
		if err != nil {
			return r, err
		}
		var buf bytes.Buffer
		for _, a := range attempts[:len(attempts)-KeepAttempts] {
			line, err := json.Marshal(a)
			if err != nil {
				return r, err
			}
			buf.Write(line)
			buf.WriteByte('\n')
		}
		if err := appendLines(f, buf.Bytes()); err != nil {
			return r, err
		}
		attempts = attempts[len(attempts)-KeepAttempts:]
	}
	next := Record{Task: r.Task, Attempts: attempts}
	f, err := s.file(r.Task.ID, ".json")
	if err != nil {
		return r, err
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return r, err
	}
	return next, writeAtomic(f, append(data, '\n'))
}

func (s *Store) Append(id string, e JournalEntry) error {
	if err := s.ensureDir(); err != nil {
		return err
	}
	f, err := s.file(id, ".events.jsonl")
	if err != nil {
		return err
	}
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	s.appendMu.Lock()
	defer s.appendMu.Unlock()
	return appendLines(f, append(line, '\n'))
}

func (s *Store) Journal(id string) []JournalEntry {
	f, err := s.file(id, ".events.jsonl")
	if err != nil {
		return []JournalEntry{}
	}
	return readJsonl[JournalEntry](f)
}

func (s *Store) ArchivedAttempts(id string) []Attempt {
	f, err := s.file(id, ".attempts.jsonl")
	if err != nil {
		return []Attempt{}
	}
	return readJsonl[Attempt](f)
}

// UnconfirmedExternal：这次执行有没有写了 intent 却没有 done / failed 的对外动作
func (s *Store) UnconfirmedExternal(id, attemptID string) bool {
	open := map[int]bool{}
	for _, e := range s.Journal(id) {
		if e.AttemptID != attemptID || e.Seq == nil {
			continue
		}
		switch e.T {
		case "intent":
			open[*e.Seq] = true
		case "done", "failed":
			delete(open, *e.Seq)
		}
	}
	return len(open) > 0
}

var attemptIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

// AppendTrace：一次执行的运行轨迹（工具调用与结果摘要），一行一个步骤
func (s *Store) AppendTrace(id, attemptID string, line map[string]any) error {
	if !attemptIDRE.MatchString(attemptID) {
		return errors.New("invalid attempt id: " + attemptID)
	}
	if err := s.ensureDir(); err != nil {
		return err
	}
	f, err := s.file(id, "."+attemptID+".trace.jsonl")
	if err != nil {
		return err
	}
	b, err := json.Marshal(line)
	if err != nil {
		return err
	}
	return appendLines(f, append(b, '\n'))
}

func (s *Store) Trace(id, attemptID string) []map[string]any {
	if !attemptIDRE.MatchString(attemptID) {
		return []map[string]any{}
	}
	f, err := s.file(id, "."+attemptID+".trace.jsonl")
	if err != nil {
		return []map[string]any{}
	}
	return readJsonl[map[string]any](f)
}

// Remove：删除任务的全部文件（快照、日志、归档、运行轨迹）
func (s *Store) Remove(id string) error {
	for _, suf := range []string{".json", ".events.jsonl", ".attempts.jsonl"} {
		f, err := s.file(id, suf)
		if err != nil {
			return err
		}
		if err := os.Remove(f); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	ents, _ := os.ReadDir(s.dir)
	for _, e := range ents {
		if n := e.Name(); strings.HasPrefix(n, id+".") && strings.HasSuffix(n, ".trace.jsonl") {
			_ = os.Remove(filepath.Join(s.dir, n))
		}
	}
	return nil
}
