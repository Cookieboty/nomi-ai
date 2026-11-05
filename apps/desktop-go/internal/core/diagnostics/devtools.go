package diagnostics

// 开发者工具（工作台消息旁的「执行轨迹」抽屉）读诊断日志。
// - ReadCliRecords：logs/cli-YYYY-MM-DD.jsonl 里某个标签一段时间的子进程原始收发；
// - ReadGatewayTrace：按追踪 id 读网关正文追踪文件（gateway/trace/<时间>-<客户端>-<id>.json）。

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	MaxCliRecords        = 2000
	MaxCliChars          = 2_000_000
	CliWindowSlackMs     = 2000
	MaxGatewayTraceChars = 4_000_000
	maxDevtoolsDays      = 7
	dayMs                = 86_400_000
)

var (
	devTabID   = regexp.MustCompile(`^[A-Za-z0-9_:.-]{1,80}$`)
	devTraceID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

type CliRecordsQuery struct {
	TabID string  `json:"tabId"`
	From  float64 `json:"from"`
	To    float64 `json:"to"`
}

// CliRecord：字段序固定
type CliRecord struct {
	T      string    `json:"t"`
	Ev     *string   `json:"ev,omitempty"`
	Pid    *float64  `json:"pid,omitempty"`
	Cli    *string   `json:"cli,omitempty"`
	Data   *string   `json:"data,omitempty"`
	Args   *[]string `json:"args,omitempty"`
	Code   *rawNull  `json:"code,omitempty"`
	Signal *rawNull  `json:"signal,omitempty"`
	Note   *string   `json:"note,omitempty"`
}

// rawNull：保留 number / string / null 原样（code、signal 可以是 null）
type rawNull struct{ v json.RawMessage }

func (r rawNull) MarshalJSON() ([]byte, error) { return r.v, nil }

type CliRecordsResult struct {
	Enabled   bool        `json:"enabled"`
	Records   []CliRecord `json:"records"`
	Truncated bool        `json:"truncated"`
}

type GatewayTraceResult struct {
	Found     bool   `json:"found"`
	Text      string `json:"text,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

func pickCliRecord(raw map[string]json.RawMessage) (CliRecord, bool) {
	var r CliRecord
	if json.Unmarshal(raw["t"], &r.T) != nil {
		return r, false
	}
	str := func(k string) *string {
		var s string
		if v, ok := raw[k]; ok && json.Unmarshal(v, &s) == nil {
			return &s
		}
		return nil
	}
	r.Ev, r.Cli, r.Data, r.Note = str("ev"), str("cli"), str("data"), str("note")
	if v, ok := raw["pid"]; ok {
		var f float64
		if json.Unmarshal(v, &f) == nil {
			r.Pid = &f
		}
	}
	if v, ok := raw["args"]; ok {
		var arr []any
		if json.Unmarshal(v, &arr) == nil {
			out := []string{}
			for _, a := range arr {
				if s, ok := a.(string); ok {
					out = append(out, s)
				}
			}
			r.Args = &out
		}
	}
	keep := func(k string, want func(any) bool) *rawNull {
		v, ok := raw[k]
		if !ok {
			return nil
		}
		var x any
		if json.Unmarshal(v, &x) != nil || !(x == nil || want(x)) {
			return nil
		}
		return &rawNull{v: v}
	}
	r.Code = keep("code", func(x any) bool { _, ok := x.(float64); return ok })
	r.Signal = keep("signal", func(x any) bool { _, ok := x.(string); return ok })
	return r, true
}

// ReadCliRecords = readCliRecords
func ReadCliRecords(dir string, q CliRecordsQuery, enabled bool) CliRecordsResult {
	out := CliRecordsResult{Enabled: enabled, Records: []CliRecord{}}
	if !devTabID.MatchString(q.TabID) || math.IsNaN(q.From) || math.IsInf(q.From, 0) ||
		math.IsNaN(q.To) || math.IsInf(q.To, 0) {
		return out
	}
	from := q.From - CliWindowSlackMs
	to := math.Max(q.To, q.From) + CliWindowSlackMs
	firstDay := int64(math.Floor(from / dayMs))
	lastDay := int64(math.Floor(to / dayMs))
	if lastDay > firstDay+maxDevtoolsDays-1 {
		lastDay = firstDay + maxDevtoolsDays - 1
	}
	tabJSON, _ := json.Marshal(q.TabID)
	needle := `"tab":` + string(tabJSON)
	chars := 0
	for day := firstDay; day <= lastDay; day++ {
		name := "cli-" + time.UnixMilli(day*dayMs).UTC().Format("2006-01-02") + ".jsonl"
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 1<<20), 8<<20)
		for sc.Scan() {
			line := sc.Text()
			if !strings.Contains(line, needle) {
				continue
			}
			var raw map[string]json.RawMessage
			if json.Unmarshal([]byte(line), &raw) != nil {
				continue
			}
			var tab, ts string
			if json.Unmarshal(raw["tab"], &tab) != nil || tab != q.TabID ||
				json.Unmarshal(raw["t"], &ts) != nil {
				continue
			}
			at, err := time.Parse(time.RFC3339Nano, ts)
			if err != nil {
				continue
			}
			ms := float64(at.UnixMilli())
			if !(ms >= from && ms <= to) {
				continue
			}
			rec, ok := pickCliRecord(raw)
			if !ok {
				continue
			}
			size := 0
			if rec.Data != nil {
				size += utf16Len(*rec.Data)
			}
			if rec.Args != nil {
				size += utf16Len(strings.Join(*rec.Args, " "))
			}
			if len(out.Records) >= MaxCliRecords || chars+size > MaxCliChars {
				out.Truncated = true
				f.Close()
				return out
			}
			chars += size
			out.Records = append(out.Records, rec)
		}
		f.Close()
	}
	return out
}

// utf16Len：与 JS string.length 同口径
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// ReadGatewayTrace = readGatewayTrace
func ReadGatewayTrace(dir, traceID string) GatewayTraceResult {
	if !devTraceID.MatchString(traceID) {
		return GatewayTraceResult{}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return GatewayTraceResult{}
	}
	suffix := "-" + traceID + ".json"
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), suffix) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return GatewayTraceResult{}
		}
		text := string(b)
		if utf16Len(text) > MaxGatewayTraceChars {
			// 按 UTF-16 单位截断（同 JS slice）
			n, cut := 0, len(text)
			for i, r := range text {
				w := 1
				if r >= 0x10000 {
					w = 2
				}
				if n+w > MaxGatewayTraceChars {
					cut = i
					break
				}
				n += w
			}
			return GatewayTraceResult{Found: true, Text: text[:cut], Truncated: true}
		}
		return GatewayTraceResult{Found: true, Text: text}
	}
	return GatewayTraceResult{}
}

// CliRecords：开发者工具，某个标签一段时间里的子进程原始收发
func (s *Service) CliRecords(q CliRecordsQuery) CliRecordsResult {
	if s.FlushTrace != nil {
		s.FlushTrace()
	}
	return ReadCliRecords(s.logDir, q, s.Enabled())
}

// GatewayTrace：开发者工具，按追踪 id 读网关请求 / 响应正文
func (s *Service) GatewayTrace(traceID string) GatewayTraceResult {
	dir := s.d.TraceDir
	if dir == "" {
		dir = filepath.Join(s.d.UserData, "gateway", "trace")
	}
	return ReadGatewayTrace(dir, traceID)
}
