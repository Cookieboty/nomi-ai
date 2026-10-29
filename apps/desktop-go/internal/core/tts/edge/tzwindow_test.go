package edge

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestJSDateStringTZWindow：2024–2037 窗口内全部 IANA 区，对 Electron 44.9.3 录制的
// (偏移, 括号名) 分段逐例比对（每变化点 ±48h 逐小时 + 变化前 1 秒 + 2000 随机时刻）。
// golden：scripts/parity/record-tz-window.mjs → testdata/tz-window.json。
func TestJSDateStringTZWindow(t *testing.T) {
	b, err := os.ReadFile("testdata/tz-window.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		From, To int64
		Random   []int64
		Zones    map[string][][3]any
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TZ", "UTC")
	oldLocal := time.Local
	defer func() { time.Local = oldLocal }()
	n, bad := 0, 0
	for z, segs := range g.Zones {
		// 窗口内实现不读 Go tzdata；仍设 time.Local 以证明结果与本机 tzdata 无关（新区可能不在 Go 的 zoneinfo 中）
		if loc, err := time.LoadLocation(z); err == nil {
			time.Local = loc
		}
		os.Setenv("TZ", z)
		at := func(u int64) (int, string) {
			s := segs[0]
			for _, x := range segs {
				if int64(x[0].(float64)) <= u {
					s = x
				}
			}
			return int(s[1].(float64)), s[2].(string)
		}
		check := append([]int64(nil), g.Random...)
		for _, s := range segs[1:] {
			bt := int64(s[0].(float64))
			check = append(check, bt-1)
			for h := int64(-48); h <= 48; h++ {
				check = append(check, bt+h*3600)
			}
		}
		for _, u := range check {
			if u < g.From || u > g.To {
				continue
			}
			n++
			off, name := at(u)
			a := off
			sign := '+'
			if a < 0 {
				sign, a = '-', -a
			}
			want := fmt.Sprintf("GMT%c%02d%02d (%s)", sign, a/60, a%60, name)
			got := JSDateString(time.Unix(u, 0))
			if !strings.HasSuffix(got, want) {
				if bad++; bad <= 30 {
					t.Errorf("%s %d: got %q want …%q", z, u, got, want)
				}
			}
		}
	}
	if bad > 0 {
		t.Fatalf("%d/%d mismatches", bad, n)
	}
	t.Logf("tz window cases: %d zones, %d instants", len(g.Zones), n)
}
