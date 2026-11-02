package desktop

import (
	"encoding/json"
	"os"
	"testing"
)

func TestClassifyCommandSharedCases(t *testing.T) {
	b, err := os.ReadFile("testdata/command-class.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Command string  `json:"command"`
			Class   *string `json:"class"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Cases {
		want := ""
		if c.Class != nil {
			want = *c.Class
		}
		if got := ClassifyCommand(c.Command); got != want {
			t.Errorf("%q: got %q want %q", c.Command, got, want)
		}
	}
}
