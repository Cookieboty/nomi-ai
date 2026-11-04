package diagnostics

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 与 Node tests/unit/diagnostics/devtools.test.ts 同样的用例（输出 JSON 逐字一致）

var devT0 = time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC).UnixMilli()

func devISO(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

func writeDevDay(t *testing.T, dir string, lines []string) {
	t.Helper()
	name := "cli-" + devISO(devT0)[:10] + ".jsonl"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadCliRecordsWindowAndTab(t *testing.T) {
	dir := t.TempDir()
	writeDevDay(t, dir, []string{
		fmt.Sprintf(`{"t":%q,"pid":1,"cli":"claude","tab":"a","ev":"out","data":"early"}`, devISO(devT0-CliWindowSlackMs-1)),
		fmt.Sprintf(`{"t":%q,"pid":1,"cli":"claude","tab":"a","ev":"spawn","args":["-p","x"]}`, devISO(devT0)),
		fmt.Sprintf(`{"t":%q,"pid":1,"cli":"claude","tab":"b","ev":"out","data":"other tab"}`, devISO(devT0+10)),
		`not json {"tab":"a"}`,
		fmt.Sprintf(`{"t":%q,"pid":1,"cli":"claude","tab":"a","ev":"in","data":"{\"x\":1}"}`, devISO(devT0+20)),
		fmt.Sprintf(`{"t":%q,"pid":1,"cli":"claude","tab":"a","ev":"exit","code":null,"signal":"SIGTERM"}`, devISO(devT0+30)),
		fmt.Sprintf(`{"t":%q,"tab":"a","ev":"out","data":"late"}`, devISO(devT0+5000+CliWindowSlackMs+1)),
	})
	r := ReadCliRecords(dir, CliRecordsQuery{TabID: "a", From: float64(devT0), To: float64(devT0 + 5000)}, true)
	got, _ := json.Marshal(r)
	want := fmt.Sprintf(`{"enabled":true,"records":[`+
		`{"t":%q,"ev":"spawn","pid":1,"cli":"claude","args":["-p","x"]},`+
		`{"t":%q,"ev":"in","pid":1,"cli":"claude","data":"{\"x\":1}"},`+
		`{"t":%q,"ev":"exit","pid":1,"cli":"claude","code":null,"signal":"SIGTERM"}`+
		`],"truncated":false}`, devISO(devT0), devISO(devT0+20), devISO(devT0+30))
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestReadCliRecordsCapAndBadTab(t *testing.T) {
	dir := t.TempDir()
	lines := make([]string, 2005)
	for i := range lines {
		lines[i] = fmt.Sprintf(`{"t":%q,"tab":"a","ev":"out","data":"x"}`, devISO(devT0+int64(i)))
	}
	writeDevDay(t, dir, lines)
	r := ReadCliRecords(dir, CliRecordsQuery{TabID: "a", From: float64(devT0), To: float64(devT0 + 10_000)}, false)
	if len(r.Records) != MaxCliRecords || !r.Truncated || r.Enabled {
		t.Fatalf("cap: %d %v %v", len(r.Records), r.Truncated, r.Enabled)
	}
	bad := ReadCliRecords(dir, CliRecordsQuery{TabID: "../x", From: float64(devT0), To: float64(devT0 + 10)}, true)
	if len(bad.Records) != 0 {
		t.Fatal("bad tab id should read nothing")
	}
	none, _ := json.Marshal(ReadCliRecords(t.TempDir(), CliRecordsQuery{TabID: "a"}, true))
	if string(none) != `{"enabled":true,"records":[],"truncated":false}` {
		t.Fatalf("empty: %s", none)
	}
}

func TestReadGatewayTrace(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "20261104T100000-claude-abc-123.json"), []byte(`{"request":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"abc-123": `{"found":true,"text":"{\"request\":{}}"}`,
		"nope":    `{"found":false}`,
		"../etc":  `{"found":false}`,
	}
	for id, want := range cases {
		got, _ := json.Marshal(ReadGatewayTrace(dir, id))
		if string(got) != want {
			t.Fatalf("%s: got %s want %s", id, got, want)
		}
	}
	if ReadGatewayTrace(filepath.Join(dir, "missing"), "abc-123").Found {
		t.Fatal("missing dir")
	}
}
