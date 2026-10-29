package desktop

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/tr"
)

// UndoJournal.ts：可撤销操作的逆操作日志（journal.jsonl）

// InverseOp 逆操作；Op ∈ move | restore | trash | truncate | custom
type InverseOp struct {
	Op            string
	From, To      string
	Stored        string
	Original      string
	Path          string
	ExpectSize    *float64
	ExpectMtimeMs *float64
	Size          float64
	Kind          string
	Payload       json.RawMessage
}

func (o InverseOp) MarshalJSON() ([]byte, error) {
	m := NewOMap()
	m.Set("op", o.Op)
	switch o.Op {
	case "move":
		m.Set("from", o.From)
		m.Set("to", o.To)
	case "restore":
		m.Set("stored", o.Stored)
		m.Set("original", o.Original)
	case "trash":
		m.Set("path", o.Path)
		if o.ExpectSize != nil {
			m.Set("expectSize", *o.ExpectSize)
		}
		if o.ExpectMtimeMs != nil {
			m.Set("expectMtimeMs", *o.ExpectMtimeMs)
		}
	case "truncate":
		m.Set("path", o.Path)
		m.Set("size", o.Size)
		if o.ExpectSize != nil {
			m.Set("expectSize", *o.ExpectSize)
		}
	case "custom":
		m.Set("kind", o.Kind)
		if o.Payload != nil {
			m.Set("payload", o.Payload)
		}
	}
	return m.MarshalJSON()
}

func (o *InverseOp) UnmarshalJSON(b []byte) error {
	var r struct {
		Op            string          `json:"op"`
		From          string          `json:"from"`
		To            string          `json:"to"`
		Stored        string          `json:"stored"`
		Original      string          `json:"original"`
		Path          string          `json:"path"`
		ExpectSize    *float64        `json:"expectSize"`
		ExpectMtimeMs *float64        `json:"expectMtimeMs"`
		Size          float64         `json:"size"`
		Kind          string          `json:"kind"`
		Payload       json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return err
	}
	*o = InverseOp{r.Op, r.From, r.To, r.Stored, r.Original, r.Path, r.ExpectSize, r.ExpectMtimeMs, r.Size, r.Kind, r.Payload}
	return nil
}

// JournalEntry 一条可撤销记录
type JournalEntry struct {
	ID      string      `json:"id"`
	Ts      float64     `json:"ts"`
	Tool    string      `json:"tool"`
	Summary string      `json:"summary"`
	Inverse []InverseOp `json:"inverse"`
}

// JournalItem list() 的元素
type JournalItem struct {
	JournalEntry
	Undone bool `json:"undone"`
}

// CustomUndo 自定义撤销
type CustomUndo struct {
	Check func(payload json.RawMessage) string
	Apply func(payload json.RawMessage) error
}

type UndoJournal struct {
	file   string
	trash  *AppTrash
	now    func() float64
	mu     sync.Mutex
	custom map[string]CustomUndo
}

func NewUndoJournal(file string, trash *AppTrash, now func() float64) *UndoJournal {
	if now == nil {
		now = nowMs
	}
	return &UndoJournal{file: file, trash: trash, now: now, custom: map[string]CustomUndo{}}
}

func (j *UndoJournal) RegisterCustom(kind string, h CustomUndo) {
	j.mu.Lock()
	j.custom[kind] = h
	j.mu.Unlock()
}

func (j *UndoJournal) read() ([]JournalEntry, map[string]bool) {
	entries := []JournalEntry{}
	undone := map[string]bool{}
	b, err := os.ReadFile(j.file)
	if err != nil {
		return entries, undone
	}
	for _, l := range strings.Split(string(b), "\n") {
		if jsTrim(l) == "" {
			continue
		}
		var probe map[string]json.RawMessage
		if json.Unmarshal([]byte(l), &probe) != nil {
			continue
		}
		if u, ok := probe["undoOf"]; ok {
			var s string
			_ = json.Unmarshal(u, &s)
			undone[s] = true
			continue
		}
		var e JournalEntry
		if json.Unmarshal([]byte(l), &e) == nil {
			entries = append(entries, e)
		}
	}
	return entries, undone
}

func appendLine(file string, v any, mode os.FileMode) error {
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(compactJSON(v) + "\n")
	return err
}

func (j *UndoJournal) Record(tool, summary string, inverse []InverseOp) JournalEntry {
	if inverse == nil {
		inverse = []InverseOp{}
	}
	e := JournalEntry{ID: randomUUID(), Ts: j.now(), Tool: tool, Summary: summary, Inverse: inverse}
	_ = os.MkdirAll(filepath.Dir(j.file), 0o777)
	_ = appendLine(j.file, e, 0o600)
	return e
}

func (j *UndoJournal) List(limit int) []JournalItem {
	entries, undone := j.read()
	if len(entries) > limit {
		entries = entries[len(entries)-limit:]
	}
	out := make([]JournalItem, 0, len(entries))
	for i := len(entries) - 1; i >= 0; i-- {
		out = append(out, JournalItem{entries[i], undone[entries[i].ID]})
	}
	return out
}

func (j *UndoJournal) Last() *JournalEntry {
	entries, undone := j.read()
	for i := len(entries) - 1; i >= 0; i-- {
		if !undone[entries[i].ID] {
			return &entries[i]
		}
	}
	return nil
}

func mtimeMs(fi os.FileInfo) float64 {
	t := fi.ModTime()
	return float64(t.Unix())*1e3 + float64(t.Nanosecond())/1e6
}

func (j *UndoJournal) Check(e JournalEntry) string {
	virt := map[string]bool{}
	present := func(p string) bool {
		if v, ok := virt[p]; ok {
			return v
		}
		return exists(p)
	}
	for _, op := range e.Inverse {
		switch op.Op {
		case "move":
			if !present(op.From) || present(op.To) {
				return tr.T("electron.common.couldn-t-move-back", op.From)
			}
			virt[op.From], virt[op.To] = false, true
		case "restore":
			if !present(op.Stored) || present(op.Original) {
				return tr.T("electron.common.couldn-t-restore", op.Original)
			}
			virt[op.Stored], virt[op.Original] = false, true
		case "trash":
			if !present(op.Path) {
				return tr.T("electron.common.file-no-longer-exists", op.Path)
			}
			if _, inVirt := virt[op.Path]; op.ExpectSize != nil && !inVirt {
				st, err := os.Stat(op.Path)
				if err != nil || float64(st.Size()) != *op.ExpectSize || (op.ExpectMtimeMs != nil && mtimeMs(st) != *op.ExpectMtimeMs) {
					return tr.T("electron.common.the-file-was-modified-afterwards", op.Path)
				}
			}
			virt[op.Path] = false
		case "custom":
			j.mu.Lock()
			h, ok := j.custom[op.Kind]
			j.mu.Unlock()
			if !ok {
				return tr.T("electron.common.can-t-undo", op.Kind)
			}
			if p := h.Check(op.Payload); p != "" {
				return p
			}
		case "truncate":
			st, err := os.Stat(op.Path)
			if err != nil || op.ExpectSize == nil || float64(st.Size()) != *op.ExpectSize {
				return tr.T("electron.common.the-file-was-modified-afterwards", op.Path)
			}
		}
	}
	return ""
}

func (j *UndoJournal) Undo(e JournalEntry) (err error) {
	if p := j.Check(e); p != "" {
		return toolErr("conflict", p)
	}
	var rollback []func() error
	defer func() {
		if err != nil {
			for i := len(rollback) - 1; i >= 0; i-- {
				_ = rollback[i]()
			}
		}
	}()
	for _, op := range e.Inverse {
		switch op.Op {
		case "move":
			if err = MoveNoOverwrite(op.From, op.To); err != nil {
				return err
			}
			from, to := op.From, op.To
			rollback = append(rollback, func() error { return MoveNoOverwrite(to, from) })
		case "restore":
			if err = j.trash.Restore(op.Stored, op.Original); err != nil {
				return err
			}
		case "trash":
			rec, e2 := j.trash.Trash(op.Path)
			if e2 != nil {
				err = e2
				return err
			}
			rollback = append(rollback, func() error { return j.trash.Restore(rec.Stored, rec.Original) })
		case "truncate":
			if err = os.Truncate(op.Path, int64(op.Size)); err != nil {
				return err
			}
		case "custom":
			j.mu.Lock()
			h := j.custom[op.Kind]
			j.mu.Unlock()
			if err = h.Apply(op.Payload); err != nil {
				return err
			}
		}
	}
	return appendLine(j.file, struct {
		UndoOf string  `json:"undoOf"`
		Ts     float64 `json:"ts"`
	}{e.ID, j.now()}, 0o666)
}

var _ = bytes.MinRead
