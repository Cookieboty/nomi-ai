package desktop

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

// register.go：contract/media.ts 「桌面能力」一节的 20 个过程

func obj(raw json.RawMessage) map[string]json.RawMessage {
	m := map[string]json.RawMessage{}
	_ = json.Unmarshal(raw, &m)
	return m
}

func field(raw json.RawMessage, k string) any { return jsAny(obj(raw)[k]) }

// Register 把桌面能力过程挂到 router 上
func Register(r *contract.Router, s *Service) {
	call := func(name string, f func(c contract.Caller, in json.RawMessage) any) {
		r.Call(name, func(_ context.Context, c contract.Caller, in json.RawMessage) (any, error) {
			return f(c, in), nil
		})
	}
	call("desktop.state", func(contract.Caller, json.RawMessage) any { return s.State() })
	call("desktop.grant", func(_ contract.Caller, in json.RawMessage) any {
		if sc := s.GrantFolder(field(in, "mode")); sc != nil {
			return sc
		}
		return nil
	})
	call("desktop.revoke", func(_ contract.Caller, in json.RawMessage) any { return s.RevokeScope(field(in, "id")) })
	call("desktop.setPolicy", func(_ contract.Caller, in json.RawMessage) any {
		return s.SetToolPolicy(field(in, "tool"), field(in, "policy"))
	})
	call("desktop.setLocalOnly", func(_ contract.Caller, in json.RawMessage) any { return s.SetLocalOnly(field(in, "value")) })
	call("desktop.audit", func(_ contract.Caller, in json.RawMessage) any { return s.AuditList(field(in, "limit")) })
	call("desktop.auditClear", func(contract.Caller, json.RawMessage) any { return s.ClearAudit() })
	call("desktop.journal", func(contract.Caller, json.RawMessage) any { return s.JournalList() })
	call("desktop.undoLast", func(contract.Caller, json.RawMessage) any { return s.UndoLast() })
	call("desktop.resetAll", func(contract.Caller, json.RawMessage) any { return s.ResetAll() })
	call("desktop.resetCloudAcks", func(contract.Caller, json.RawMessage) any { return s.ResetCloudAcks() })
	call("desktop.remindersList", func(_ contract.Caller, in json.RawMessage) any { return s.RemindersList(field(in, "all")) })
	call("desktop.remindersCreate", func(_ contract.Caller, in json.RawMessage) any {
		if r := s.CreateReminder(obj(in)); r != nil {
			return r
		}
		return nil
	})
	call("desktop.remindersUpdate", func(_ contract.Caller, in json.RawMessage) any {
		o := obj(in)
		if r := s.UpdateReminder(jsAny(o["id"]), obj(o["patch"])); r != nil {
			return r
		}
		return nil
	})
	call("desktop.remindersCancel", func(_ contract.Caller, in json.RawMessage) any { return s.CancelReminder(field(in, "id")) })
	call("desktop.remindersSnooze", func(_ contract.Caller, in json.RawMessage) any {
		return s.SnoozeReminder(field(in, "id"), field(in, "minutes"))
	})
	call("desktop.confirmAnswer", func(c contract.Caller, in json.RawMessage) any {
		s.AnswerConfirm(c.Surface, field(in, "id"), field(in, "allow"), field(in, "remember"))
		return nil
	})
	call("desktop.reminderAction", func(c contract.Caller, in json.RawMessage) any {
		s.ReminderAction(c.Surface, field(in, "id"), field(in, "action"), field(in, "minutes"))
		return nil
	})
	call("desktop.takeMissedReminders", func(c contract.Caller, _ json.RawMessage) any { return s.TakeMissedFor(c.Surface) })
	call("desktop.takePendingSummary", func(contract.Caller, json.RawMessage) any { return s.TakePendingSummary() })
}
