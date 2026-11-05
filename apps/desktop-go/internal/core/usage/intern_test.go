package usage

import (
	"encoding/json"
	"slices"
	"testing"
)

// 去重后两条记录共用键序列与字符串，但改一条（加键 / 删键 / 改值）不影响另一条
func TestInternSharedRecordsStayIndependent(t *testing.T) {
	line := `{"key":"k1","ts":1,"source":"claude","via":"log","model":"m","input":1,"output":2,"cacheRead":0,"cacheWrite":0,"session":"s","project":"p"}`
	var a, b UsageRecord
	if err := json.Unmarshal([]byte(line), &a); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(line), &b); err != nil {
		t.Fatal(err)
	}
	if &a.keys[0] != &b.keys[0] || a.Session != b.Session {
		t.Fatal("expected shared key sequence and session pointer")
	}
	want := slices.Clone(b.keys)
	a.addKey("est")
	a.delOwn("project")
	if !slices.Equal(b.keys, want) {
		t.Fatalf("b.keys changed: %v", b.keys)
	}
	if *b.Session != "s" || *b.Project != "p" {
		t.Fatal("b values changed")
	}
	out, _ := json.Marshal(&b)
	var round map[string]any
	_ = json.Unmarshal(out, &round)
	if round["session"] != "s" || round["model"] != "m" || round["key"] != "k1" {
		t.Fatalf("round trip: %s", out)
	}
}
