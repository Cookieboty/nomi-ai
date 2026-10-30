package desktop

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

func newTestService(t *testing.T) (*Service, *[]string) {
	t.Helper()
	var mu sync.Mutex
	events := []string{}
	s := CreateService(t.TempDir(), Ports{Home: t.TempDir()}, func(ev string, _ any, _ string) bool {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
		return false
	})
	return s, &events
}

func TestReminderLifecycleAndUndo(t *testing.T) {
	s, _ := newTestService(t)
	r := s.CreateReminder(map[string]json.RawMessage{"text": json.RawMessage(`"  喝水  "`), "inMinutes": json.RawMessage(`5`)})
	if r == nil || r.Text != "喝水" || r.Status != "pending" {
		t.Fatalf("create: %+v", r)
	}
	if got := s.RemindersList(false); len(got) != 1 {
		t.Fatalf("list: %v", got)
	}
	if !s.CancelReminder(r.ID) {
		t.Fatal("cancel failed")
	}
	if got := s.RemindersList(false); len(got) != 0 {
		t.Fatalf("after cancel: %v", got)
	}
	if u := s.UndoLast(); !u.OK {
		t.Fatalf("undo: %+v", u)
	}
	if got := s.RemindersList(false); len(got) != 1 || got[0].Status != "pending" {
		t.Fatalf("after undo: %+v", got)
	}
	if s.CreateReminder(map[string]json.RawMessage{"text": json.RawMessage(`""`), "inMinutes": json.RawMessage(`5`)}) != nil {
		t.Fatal("empty text accepted")
	}
	if len(s.AuditList(nil)) < 2 {
		t.Fatal("audit not written")
	}
}

func TestRegisterAllProcedures(t *testing.T) {
	s, _ := newTestService(t)
	r := contract.NewRouter()
	Register(r, s)
	reg := r.Registered()
	for _, n := range []string{"desktop.state", "desktop.grant", "desktop.revoke", "desktop.setPolicy", "desktop.setLocalOnly", "desktop.audit", "desktop.auditClear", "desktop.journal", "desktop.undoLast", "desktop.resetAll", "desktop.resetCloudAcks", "desktop.remindersList", "desktop.remindersCreate", "desktop.remindersUpdate", "desktop.remindersCancel", "desktop.remindersSnooze", "desktop.confirmAnswer", "desktop.reminderAction", "desktop.takeMissedReminders", "desktop.takePendingSummary"} {
		if _, ok := reg[n]; !ok {
			t.Errorf("missing %s", n)
		}
	}
	_ = context.Background()
	b, err := json.Marshal(s.State())
	if err != nil || len(b) < 10 {
		t.Fatalf("state: %s %v", b, err)
	}
	if !s.SetLocalOnly(true) || !s.State().LocalOnly {
		t.Fatal("localOnly")
	}
}
