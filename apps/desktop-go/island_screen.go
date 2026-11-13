package main

// 灵动岛的「工作台此刻在不在屏幕上、你正看着哪个会话」：island.ShouldShow 的输入。
// 对话窗口可见且没最小化 = 工作台在屏幕上（各平台都拿不到被别的窗口盖住的信息，盖住也算在屏幕上）；
// 窗口在前台时，编排器的当前标签就是你正看着的会话。当前标签随编排器的 tabs 事件记下（原子读，不进 GIL：
// 通知可能就是在 GIL 里发出的）。

import (
	"sync/atomic"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// islandActiveTab：编排器的当前标签（未接编排器时是主对话）
var islandActiveTab atomic.Value

func islandCurrentTab() string {
	if v, ok := islandActiveTab.Load().(string); ok && v != "" {
		return v
	}
	return harness.MainTabID
}

// trackIslandActiveTab：跟着编排器记当前标签（tabs 事件的负载就是 ListTabs，带 activeTabId）
func trackIslandActiveTab(o *harness.Orchestrator) {
	if o == nil {
		return
	}
	set := func(v any) {
		if id, ok := util.AsObj(v).Get("activeTabId").(string); ok {
			islandActiveTab.Store(id)
		}
	}
	jsrt.Run(func() {
		set(o.ListTabs())
		o.Events().On("tabs", set)
	})
}

// chatOnScreen：对话窗口可见、没最小化
func chatOnScreen(sh shell.Shell) bool {
	if sh == nil {
		return false
	}
	if g, ok := sh.(interface {
		Shown(shell.WindowKind) (bool, bool)
	}); ok {
		v, min := g.Shown(shell.Chat)
		return v && !min
	}
	return sh.Visible(shell.Chat)
}

// islandScreenOf：此刻工作台的状态
func islandScreenOf(sh shell.Shell) island.Screen {
	sc := island.Screen{WorkbenchVisible: chatOnScreen(sh)}
	if !sc.WorkbenchVisible {
		return sc
	}
	if f, ok := sh.(WindowFocus); ok && f.AnyFocused() {
		sc.ForegroundSession = islandCurrentTab()
	}
	return sc
}

// islandNoticeAllowed：desktop.Windows.NoticeAllowed（灵动岛与退回的系统通知共用这一个判断）
func islandNoticeAllowed(sh shell.Shell, n desktop.IslandNotice) bool {
	return island.ShouldShow(island.Classify(n.Kind, n.Status), n.Session, islandScreenOf(sh))
}
