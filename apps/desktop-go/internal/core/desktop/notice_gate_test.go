package desktop

import "testing"

// NoticeAllowed 说不弹：灵动岛和退回的系统通知都不出；说弹：照常先走灵动岛，岛不接再退回系统通知。
// 桌面角色在桌面上时仍是她的气泡（不经过这个判断）
func TestNotifyRespectsNoticeAllowed(t *testing.T) {
	var islands, systems []string
	var seen []IslandNotice
	allowed := false
	islandOK := true
	s := CreateService(t.TempDir(), Ports{
		NotifySupported:  func() bool { return true },
		ShowNotification: func(title, _ string, _ func()) { systems = append(systems, title) },
	}, func(string, any, string) bool { return true })
	s.AttachWindows(&Windows{
		Main:         func() bool { return false },
		MascotHidden: func() bool { return true },
		Island: func(n IslandNotice) bool {
			islands = append(islands, n.Title)
			return islandOK
		},
		NoticeAllowed: func(n IslandNotice) bool {
			seen = append(seen, n)
			return allowed
		},
	})
	if via := s.Notify(DesktopNotice{Kind: "agent", Status: "done", Title: "done", Session: "tab-a"}); via != "none" {
		t.Fatalf("suppressed notice went to %q", via)
	}
	if len(islands) != 0 || len(systems) != 0 {
		t.Fatalf("suppressed notice must not reach island %v or system notification %v", islands, systems)
	}
	if len(seen) != 1 || seen[0].Session != "tab-a" || seen[0].Kind != "agent" || seen[0].Status != "done" {
		t.Fatalf("policy input = %+v", seen)
	}
	allowed = true
	if via := s.Notify(DesktopNotice{Kind: "agent", Status: "failed", Title: "failed"}); via != "island" || len(islands) != 1 {
		t.Fatalf("allowed notice via %q islands=%v", via, islands)
	}
	islandOK = false
	if via := s.Notify(DesktopNotice{Kind: "agent", Status: "failed", Title: "fallback"}); via != "notification" || len(systems) != 1 {
		t.Fatalf("allowed notice falls back to the system notification: via %q systems=%v", via, systems)
	}
}
