package usage

import (
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
	"github.com/klauspost/compress/zstd"
)

type scanStep struct {
	Op  string          `json:"op"`
	P   string          `json:"p"`
	B   string          `json:"b"`
	M   float64         `json:"m"`
	N   int             `json:"n"`
	C   json.RawMessage `json:"c"`
	R   json.RawMessage `json:"r"`
	Res json.RawMessage `json:"res"`
}

type scanScenario struct {
	Name      string            `json:"name"`
	Now       float64           `json:"now"`
	Env       map[string]string `json:"env"`
	Retention string            `json:"retention"`
	ClearedAt float64           `json:"clearedAt"`
	Busy      []string          `json:"busy"`
	Steps     []scanStep        `json:"steps"`
}

type warnLog struct{ files *[]any }

func (w warnLog) Info(string, any) {}
func (w warnLog) Warn(_ string, d any) {
	*w.files = append(*w.files, d.(map[string]any)["file"])
}

func genBig(n int) []byte {
	var b bytes.Buffer
	pad := strings.Repeat("x", 300)
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, `{"type":"assistant","timestamp":"2025-05-20T00:00:00Z","message":{"id":"msg_g%d","model":"claude-sonnet-4-5","usage":{"input_tokens":1,"output_tokens":1}},"pad":"%s"}`+"\n", i, pad)
	}
	return b.Bytes()
}

// 测试解码器（生产装配注入 cli.ZstdDecode；本包不能 import core/cli）
func extZstd(b []byte) (string, error) {
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return "", err
	}
	defer dec.Close()
	out, err := dec.DecodeAll(b, nil)
	return string(out), err
}

func digest(recs []map[string]any) map[string]any {
	keys := make([]string, len(recs))
	sum := 0.0
	for i, r := range recs {
		keys[i] = r["key"].(string)
		for _, k := range []string{"input", "output", "cacheRead", "cacheWrite", "ts"} {
			if v, ok := r[k].(float64); ok {
				sum += v
			}
		}
	}
	h := sha1.Sum([]byte(strings.Join(keys, "\n")))
	return map[string]any{"n": float64(len(recs)), "keys": hex.EncodeToString(h[:]), "sum": sum}
}

func setM(t *testing.T, p string, m float64) {
	tm := time.UnixMilli(int64(m))
	if err := os.Chtimes(p, tm, tm); err != nil {
		t.Fatal(err)
	}
}

func TestUsageScannerParity(t *testing.T) {
	path, _ := paritytest.Golden(t, "usage-scanner.json", "testdata/usage-scanner.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var scs []scanScenario
	if err := json.Unmarshal(raw, &scs); err != nil {
		t.Fatal(err)
	}
	steps := 0
	for _, sc := range scs {
		t.Run(sc.Name, func(t *testing.T) {
			home := t.TempDir()
			envm := map[string]string{}
			for k, v := range sc.Env {
				if v == "DSHROOT" {
					v = filepath.Join(home, "dsh2")
				}
				envm[k] = v
			}
			eb, _ := json.Marshal(envm)
			envAny, _ := util.ParseString(string(eb))
			flushMs := 3_600_000.0
			now := sc.Now
			l := NewUsageLedger(LedgerDeps{Root: filepath.Join(home, "__ledger"), FlushMs: &flushMs, Now: func() float64 { return now }})
			defer l.Close()
			var news []string
			var quotas []any
			var warns []any
			grok := filepath.Join(home, ".grok")
			s := NewUsageLogScanner(ScannerDeps{
				Ledger: l, Home: &home, Env: envAny.(*util.Obj), GrokHome: &grok, Now: func() float64 { return now },
				Retention: func() Retention { return sc.Retention }, ClearedAt: func() float64 { return sc.ClearedAt },
				RouteBusy: func(src UsageSource) bool {
					for _, b := range sc.Busy {
						if b == src {
							return true
						}
					}
					return false
				},
				OnNew:      func(r *UsageRecord) { news = append(news, r.Key) },
				OnQuota:    func(q *CodexRateLimits) { quotas = append(quotas, normJSON(t, q)) },
				Logger:     warnLog{&warns},
				ZstdDecode: extZstd,
			})
			rel := func(p string) string { return filepath.ToSlash(p[len(home)+1:]) }
			for i, st := range sc.Steps {
				abs := ""
				if st.P != "" {
					abs = filepath.Join(append([]string{home}, strings.Split(st.P, "/")...)...)
				}
				var got any = "__none__"
				switch st.Op {
				case "write", "append", "gen":
					_ = os.MkdirAll(filepath.Dir(abs), 0o755)
					var data []byte
					if st.Op == "gen" {
						data = genBig(st.N)
					} else {
						data, _ = base64.StdEncoding.DecodeString(st.B)
					}
					flag := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
					if st.Op == "append" {
						flag = os.O_CREATE | os.O_WRONLY | os.O_APPEND
					}
					f, err := os.OpenFile(abs, flag, 0o644)
					if err != nil {
						t.Fatal(err)
					}
					f.Write(data)
					f.Close()
					setM(t, abs, st.M)
				case "rewriteSameSize":
					b, _ := os.ReadFile(abs)
					if b[len(b)-2] == 0x7d {
						b[len(b)-2] = 0x20
					} else {
						b[len(b)-2] = 0x7d
					}
					os.WriteFile(abs, b, 0o644)
					setM(t, abs, st.M)
				case "touch":
					setM(t, abs, st.M)
				case "rm":
					os.Remove(abs)
				case "cursor":
					c := l.Cursor(abs)
					var kind string
					var next *FileCursor
					if json.Unmarshal(st.C, &kind) == nil {
						next = copyCursor(c)
						switch kind {
						case "dropFp":
							next.Fp, next.FpLen = nil, nil
						case "badIno":
							next.Ino, next.Dev = f64p(12345), f64p(1)
						case "rev1":
							ns := map[string]any{}
							for k, v := range c.State {
								ns[k] = v
							}
							ns["rev"] = float64(1)
							next.State = ns
						}
					} else {
						next = un[*FileCursor](t, st.C)
					}
					l.SetCursor(abs, next)
				case "route":
					l.Upsert(un[*UsageRecord](t, st.R))
				case "detected":
					got = normJSON(t, s.Detected())
				case "scan":
					news, quotas, warns = []string{}, []any{}, []any{}
					r := s.Scan()
					recs := []map[string]any{}
					for _, x := range l.All() {
						recs = append(recs, normJSON(t, x).(map[string]any))
					}
					sort.SliceStable(recs, func(i, j int) bool { return recs[i]["key"].(string) < recs[j]["key"].(string) })
					curs := map[string]any{}
					for _, p := range l.CursorPaths() {
						c := normJSON(t, l.Cursor(p)).(map[string]any)
						_, has := c["ino"]
						c["hasId"] = has
						delete(c, "ino")
						delete(c, "dev")
						curs[rel(p)] = c
					}
					res := map[string]any{"r": normJSON(t, r), "quotas": quotas, "warns": warns, "curs": curs}
					if len(recs) > 200 {
						nr := make([]map[string]any, len(news))
						for i, k := range news {
							nr[i] = map[string]any{"key": k}
						}
						res["news"] = digest(nr)
						res["recs"] = digest(recs)
					} else {
						res["news"] = normJSON(t, news)
						res["recs"] = normJSON(t, recs)
					}
					got = normJSON(t, res)
				}
				if got == "__none__" {
					continue
				}
				steps++
				want := rawAny(t, st.Res)
				if !deepEq(got, want) {
					gb, _ := json.Marshal(got)
					wb, _ := json.Marshal(want)
					t.Fatalf("step %d (%s %s):\n got %s\nwant %s", i, st.Op, st.P, trunc(gb), trunc(wb))
				}
			}
		})
	}
	t.Logf("scanner parity: %d scenarios, %d checked steps", len(scs), steps)
}

func trunc(b []byte) string {
	if len(b) > 6000 {
		return string(b[:6000]) + "…"
	}
	return string(b)
}
