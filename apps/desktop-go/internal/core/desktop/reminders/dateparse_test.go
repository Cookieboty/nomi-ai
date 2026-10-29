package reminders

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

// testdata/dateparse_node.txt：每行 "<TZ> <JSON[[input, Date.parse(input)]]>"，由 Node 生成
func TestDateParseNodeFixtures(t *testing.T) {
	f, err := os.Open("testdata/dateparse_node.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	old := time.Local
	defer func() { time.Local = old }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		zone, js, _ := strings.Cut(sc.Text(), " ")
		loc, err := time.LoadLocation(zone)
		if err != nil {
			t.Skip(err)
		}
		time.Local = loc
		var cases [][2]any
		if err := json.Unmarshal([]byte(js), &cases); err != nil {
			t.Fatal(err)
		}
		for _, c := range cases {
			in := c[0].(string)
			got, ok := DateParse(in)
			if c[1] == nil {
				if ok {
					t.Errorf("%s %q: want NaN got %v", zone, in, got)
				}
				continue
			}
			want := c[1].(float64)
			if !ok || got != want || math.IsNaN(got) {
				t.Errorf("%s %q: want %v got %v ok=%v", zone, in, want, got, ok)
			}
		}
	}
}
