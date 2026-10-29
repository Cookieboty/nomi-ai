package desktop

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// AuditLog.ts：desktop-YYYY-MM.jsonl（本地月份），参数脱敏

// AuditEntry 一条审计（字段顺序见 D-B6-6）
type AuditEntry struct {
	Tool     string  `json:"tool"`
	Args     *OMap   `json:"args"`
	Decision string  `json:"decision"`
	Result   string  `json:"result"`
	Ms       *int64  `json:"ms,omitempty"`
	Source   string  `json:"source,omitempty"`
	Provider string  `json:"provider,omitempty"`
	Ts       float64 `json:"ts"`
}

var textKeys = map[string]bool{"text": true, "content": true, "body": true, "notes": true, "code": true, "stdin": true}

// RedactArgs：args 是 JSON 对象（*OMap / json.RawMessage / map），其它 → {}
func RedactArgs(args any) *OMap {
	out := NewOMap()
	var in *OMap
	switch a := args.(type) {
	case *OMap:
		in = a
	case json.RawMessage:
		var arr []any
		if json.Unmarshal(a, &arr) == nil {
			return RedactArgs(arr)
		}
		in, _ = ParseOMap(a)
	case nil:
	case []any:
		// JS 里数组也是对象：Object.entries → "0","1",...
		in = NewOMap()
		for i, v := range a {
			in.Set(fmt.Sprint(i), v)
		}
	default:
		if arr, ok := jsArray(a); ok {
			return RedactArgs(arr)
		}
		raw := compactJSON(a)
		in, _ = ParseOMap([]byte(raw))
	}
	if in == nil {
		return out
	}
	for _, k := range in.Keys {
		raw := in.Vals[k]
		var v any
		_ = json.Unmarshal(raw, &v)
		switch x := v.(type) {
		case string:
			if textKeys[k] {
				h := sha256.Sum256([]byte(x))
				o := NewOMap()
				o.Set("sha256", hex.EncodeToString(h[:])[:12])
				o.Set("length", u16len(x))
				out.Set(k, o)
			} else if u16len(x) > 300 {
				out.Set(k, u16slice(x, 0, 300)+"…")
			} else {
				out.Set(k, x)
			}
		case float64, bool, nil:
			out.Set(k, raw)
		default:
			out.Set(k, "[object]")
		}
	}
	return out
}

type AuditLog struct {
	dir string
	now func() float64
}

func NewAuditLog(dir string, now func() float64) *AuditLog {
	if now == nil {
		now = nowMs
	}
	return &AuditLog{dir: dir, now: now}
}

func (l *AuditLog) fileFor(ts float64) string {
	return filepath.Join(l.dir, "desktop-"+time.UnixMilli(int64(ts)).Format("2006-01")+".jsonl")
}

// Append 写一条；Args 传原始参数（会脱敏）
func (l *AuditLog) Append(e AuditEntry, rawArgs any) AuditEntry {
	if e.Ts == 0 {
		e.Ts = l.now()
	}
	e.Args = RedactArgs(rawArgs)
	_ = os.MkdirAll(l.dir, 0o777)
	f, err := os.OpenFile(l.fileFor(e.Ts), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		_, _ = fmt.Fprintf(f, "%s\n", compactJSON(e))
		_ = f.Close()
	}
	return e
}

var reAuditFile = regexp.MustCompile(`^desktop-\d{4}-\d{2}\.jsonl$`)

// List：最新在前，原样返回每行对象
func (l *AuditLog) List(limit int) []json.RawMessage {
	out := []json.RawMessage{}
	ents, err := os.ReadDir(l.dir)
	if err != nil {
		return out
	}
	files := []string{}
	for _, e := range ents {
		if reAuditFile.MatchString(e.Name()) {
			files = append(files, e.Name())
		}
	}
	slices.Sort(files)
	slices.Reverse(files)
	for _, f := range files {
		b, _ := os.ReadFile(filepath.Join(l.dir, f))
		lines := []string{}
		for _, s := range strings.Split(string(b), "\n") {
			if s != "" {
				lines = append(lines, s)
			}
		}
		slices.Reverse(lines)
		for _, s := range lines {
			if json.Valid([]byte(s)) {
				out = append(out, json.RawMessage(s))
			}
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

func (l *AuditLog) Clear() { _ = os.RemoveAll(l.dir) }

func (l *AuditLog) Rotate() {
	ents, err := os.ReadDir(l.dir)
	if err != nil {
		return
	}
	cutoff := time.UnixMilli(int64(l.now())).AddDate(0, -6, 0)
	keep := filepath.Base(l.fileFor(float64(cutoff.UnixMilli())))
	for _, e := range ents {
		if reAuditFile.MatchString(e.Name()) && e.Name() < keep {
			_ = os.Remove(filepath.Join(l.dir, e.Name()))
		}
	}
}

func jsArray(a any) ([]any, bool) {
	var arr []any
	if json.Unmarshal([]byte(compactJSON(a)), &arr) == nil {
		return arr, true
	}
	return nil, false
}
