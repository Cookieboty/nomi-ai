package reminders

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReminderUnknownFieldsRoundTrip(t *testing.T) {
	f := filepath.Join(t.TempDir(), "reminders.json")
	in := `{"version":1,"reminders":[{"text":"hi","x":{"b":1,"a":[2]},"id":"rabc123","dueAt":9e12,"createdAt":1,"status":"pending","firedAt":5}]}`
	_ = os.WriteFile(f, []byte(in), 0o600)
	s := New(f, func() float64 { return 2 }, nil)
	if _, err := s.Snooze("rabc123", 1); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(f)
	flat := strings.Join(strings.Fields(string(got)), "")
	want := `{"version":1,"reminders":[{"text":"hi","x":{"b":1,"a":[2]},"id":"rabc123","dueAt":60002,"createdAt":1,"status":"pending","snoozes":1}]}`
	if flat != want {
		t.Fatalf("got %s", flat)
	}
}
