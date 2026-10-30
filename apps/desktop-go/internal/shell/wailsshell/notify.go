package wailsshell

import (
	"log"
	"os"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// notifier = electronPorts.notifications（Electron Notification）：系统通知，点击回调按通知 ID 分发
type notifier struct {
	ns     *notifications.NotificationService
	seq    atomic.Int64
	mu     sync.Mutex
	clicks map[string]func()
	auth   sync.Once
	denied atomic.Bool
}

// newNotifier：mac 上不在 .app 里（开发态直接跑二进制）时通知服务启动会失败并让 Wails 中止应用，此时不建服务、
// 系统通知不可用（桌面服务退回灵动岛 / 气泡）
func newNotifier() *notifier {
	n := &notifier{clicks: map[string]func(){}}
	if goruntime.GOOS == "darwin" && !inMacBundle() {
		return n
	}
	n.ns = notifications.New()
	n.ns.OnNotificationResponse(func(r notifications.NotificationResult) {
		if r.Error != nil || r.Response.ActionIdentifier != notifications.DefaultActionIdentifier {
			return
		}
		n.mu.Lock()
		fn := n.clicks[r.Response.ID]
		delete(n.clicks, r.Response.ID)
		n.mu.Unlock()
		if fn != nil {
			fn()
		}
	})
	return n
}

// inMacBundle：mac 的通知要求有 bundle id，只有从 .app 里启动才有（开发态直接跑二进制没有）
func inMacBundle() bool {
	exe, err := os.Executable()
	return err == nil && strings.Contains(exe, ".app/Contents/MacOS/")
}

// services：要注册到 Wails 应用的通知服务（不可用时为空）
func (n *notifier) services() []application.Service {
	if n.ns == nil {
		return nil
	}
	return []application.Service{application.NewService(n.ns)}
}

// NotifySupported = Notification.isSupported()：mac 需在 .app 里且没被用户拒绝授权
func (w *Wails) NotifySupported() bool {
	return w.notes.ns != nil && !w.notes.denied.Load()
}

// ShowNotification = new Notification({ title, body }).show()，点击时调 onClick
func (w *Wails) ShowNotification(title, body string, onClick func()) {
	n := w.notes
	if n.ns == nil {
		return
	}
	go func() {
		if goruntime.GOOS == "darwin" {
			n.auth.Do(func() {
				if ok, err := n.ns.RequestNotificationAuthorization(); err != nil || !ok {
					n.denied.Store(true)
					log.Printf("[shell] notifications not authorized: %v", err)
				}
			})
			if n.denied.Load() {
				return
			}
		}
		id := "nomi-" + strconv.FormatInt(n.seq.Add(1), 10)
		if onClick != nil {
			n.mu.Lock()
			n.clicks[id] = onClick
			n.mu.Unlock()
		}
		if err := n.ns.SendNotification(notifications.NotificationOptions{ID: id, Title: title, Body: body}); err != nil {
			log.Printf("[shell] notification failed: %v", err)
			n.mu.Lock()
			delete(n.clicks, id)
			n.mu.Unlock()
		}
	}()
}
