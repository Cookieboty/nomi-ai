package tasks

// golden：scripts/parity/record-tasks-store.mjs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type nopLog struct{ n int }

func (l *nopLog) Warn(string, ...any) { l.n++ }

type storeGolden struct {
	Files       map[string]string          `json:"files"`
	Saved       []json.RawMessage          `json:"saved"`
	LoadAll     json.RawMessage            `json:"loadAll"`
	Journal     map[string]json.RawMessage `json:"journal"`
	Archived    map[string]json.RawMessage `json:"archived"`
	Unconfirmed []struct {
		ID        string `json:"id"`
		AttemptID string `json:"attemptId"`
		Value     bool   `json:"value"`
	} `json:"unconfirmed"`
	WarnCount int `json:"warnCount"`
}

func loadStoreGolden(t *testing.T) storeGolden {
	t.Helper()
	gp, _ := paritytest.Golden(t, "tasks-store.json", filepath.Join("testdata", "tasks-store.json"))
	b, err := os.ReadFile(gp)
	if err != nil {
		t.Fatal(err)
	}
	var g storeGolden
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func eqJSON(t *testing.T, label string, got any, want json.RawMessage) {
	t.Helper()
	if g, w := canon(t, got), raw(t, want); !reflect.DeepEqual(g, w) {
		t.Fatalf("%s:\n go:   %v\n node: %v", label, g, w)
	}
}

func TestStoreReadsNodeFiles(t *testing.T) {
	g := loadStoreGolden(t)
	dir := t.TempDir()
	for name, c := range g.Files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	log := &nopLog{}
	s := NewStore(dir, log)
	eqJSON(t, "loadAll", s.LoadAll(), g.LoadAll)
	if log.n != g.WarnCount {
		t.Fatalf("warn count go=%d node=%d", log.n, g.WarnCount)
	}
	for id, want := range g.Journal {
		eqJSON(t, "journal "+id, s.Journal(id), want)
	}
	for id, want := range g.Archived {
		eqJSON(t, "archived "+id, s.ArchivedAttempts(id), want)
	}
	for _, u := range g.Unconfirmed {
		if got := s.UnconfirmedExternal(u.ID, u.AttemptID); got != u.Value {
			t.Fatalf("unconfirmed %s/%s go=%v node=%v", u.ID, u.AttemptID, got, u.Value)
		}
	}
}

// Go 写出的快照与 Node 写出的按 JSON 相等（Node 读 Go 写的文件就是读同一份 JSON）
func TestStoreWritesNodeFormat(t *testing.T) {
	g := loadStoreGolden(t)
	dir := t.TempDir()
	s := NewStore(dir, &nopLog{})
	for _, saved := range g.Saved {
		var r Record
		if err := json.Unmarshal(saved, &r); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Save(r); err != nil {
			t.Fatal(err)
		}
		name := r.Task.ID + ".json"
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		var got, want any
		_ = json.Unmarshal(b, &got)
		_ = json.Unmarshal([]byte(g.Files[name]), &want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s differs:\n go:   %s\n node: %s", name, b, g.Files[name])
		}
		if st, _ := os.Stat(filepath.Join(dir, name)); st.Mode().Perm()&0o077 != 0 && !isWindows() {
			t.Fatalf("%s mode %v", name, st.Mode())
		}
	}
}

func isWindows() bool { return filepath.Separator == '\\' }

func TestStoreCrashPoints(t *testing.T) {
	origW, origA := writeAtomic, appendRaw
	t.Cleanup(func() { writeAtomic, appendRaw = origW, origA })
	crash := errors.New("crash")
	mk := func(title string, n int) Record {
		r := Record{Task: Task{ID: "task_a", Title: title, Status: StatusIdle, SchemaVersion: 1,
			Grant: Grant{Paths: []string{}, Connections: []ConnectionGrant{}}}, Attempts: []Attempt{}}
		for i := 1; i <= n; i++ {
			r.Attempts = append(r.Attempts, Attempt{ID: "att_" + string(rune('0'+i%10)) + string(rune('a'+i/10)), Gen: i})
		}
		return r
	}

	t.Run("快照写临时文件时崩溃：读到旧版本", func(t *testing.T) {
		s := NewStore(t.TempDir(), &nopLog{})
		if _, err := s.Save(mk("v1", 0)); err != nil {
			t.Fatal(err)
		}
		writeAtomic = func(file string, data []byte) error {
			_ = os.WriteFile(file+".tmp", data[:20], 0o600)
			return crash
		}
		defer func() { writeAtomic = origW }()
		if _, err := s.Save(mk("v2", 0)); !errors.Is(err, crash) {
			t.Fatal(err)
		}
		r, _ := s.Load("task_a")
		if r == nil || r.Task.Title != "v1" {
			t.Fatalf("got %+v", r)
		}
	})

	t.Run("归档追加后、快照写入前崩溃：快照仍是旧的", func(t *testing.T) {
		s := NewStore(t.TempDir(), &nopLog{})
		if _, err := s.Save(mk("v1", 0)); err != nil {
			t.Fatal(err)
		}
		writeAtomic = func(string, []byte) error { return crash }
		defer func() { writeAtomic = origW }()
		if _, err := s.Save(mk("v1", KeepAttempts+1)); !errors.Is(err, crash) {
			t.Fatal(err)
		}
		r, _ := s.Load("task_a")
		if r == nil || len(r.Attempts) != 0 || len(s.ArchivedAttempts("task_a")) != 1 {
			t.Fatalf("got %+v archived=%d", r, len(s.ArchivedAttempts("task_a")))
		}
	})

	t.Run("日志追加崩溃留下半行，后续追加不受影响", func(t *testing.T) {
		dir := t.TempDir()
		s := NewStore(dir, &nopLog{})
		one := 1
		if err := s.Append("task_a", JournalEntry{T: "intent", At: 1, AttemptID: "att_1", Seq: &one, Action: "x", Hash: "h"}); err != nil {
			t.Fatal(err)
		}
		f, _ := os.OpenFile(filepath.Join(dir, "task_a.events.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
		_, _ = f.WriteString(`{"t":"done","at":1,"atte`)
		_ = f.Close()
		if !s.UnconfirmedExternal("task_a", "att_1") {
			t.Fatal("want unconfirmed")
		}
		if err := s.Append("task_a", JournalEntry{T: "done", At: 2, AttemptID: "att_1", Seq: &one}); err != nil {
			t.Fatal(err)
		}
		if s.UnconfirmedExternal("task_a", "att_1") || len(s.Journal("task_a")) != 2 {
			t.Fatalf("journal %+v", s.Journal("task_a"))
		}
	})

	t.Run("非法 id", func(t *testing.T) {
		s := NewStore(t.TempDir(), &nopLog{})
		if _, err := s.Load("../x"); err == nil {
			t.Fatal("want error")
		}
		if _, err := s.Save(Record{Task: Task{ID: "task_../x"}}); err == nil {
			t.Fatal("want error")
		}
	})
}
