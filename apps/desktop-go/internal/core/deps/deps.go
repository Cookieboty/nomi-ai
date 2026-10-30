// Package deps 汇总批次 8（知识库 / 记忆 / 定时 / 扩展 / 本地模型）对其它批次的依赖接口。
//
// Node 里这些服务直接拿 DesktopService（批次 6）、AI runtime（批次 4/5）、HostPorts 的实例；
// Go 侧按「消费方定义接口」收窄成这里的小接口，由 main.go 装配。尚未移植的部分在
// fakes.go / noop 实现里给出空行为，并在 docs/design/migrate-2.0.5-go.md §3.4 D-B8-* 记录。
package deps

import (
	"context"
	"log"
)

// Msg 对应 Node 里传给 complete() 的 { role, content }
type Msg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// CompleteFunc：对话模型补全（Node createCore 的 complete()，main.go 接到 ChatFacade）
type CompleteFunc func(ctx context.Context, messages []Msg) (string, error)

// Events 对应 core/appEvents 的 publish（契约事件推给订阅窗口）
type Events interface {
	Publish(event string, payload any)
}

// EventsFunc 让 router.Emit 直接当 Events 用
type EventsFunc func(event string, payload any)

func (f EventsFunc) Publish(event string, payload any) { f(event, payload) }

// AuditEntry 对应 desktop/audit 的 append 入参（字段顺序 = Node 对象字面量顺序）
type AuditEntry struct {
	Tool     string `json:"tool"`
	Args     any    `json:"args"`
	Decision string `json:"decision"`
	Result   string `json:"result"`
	Ms       *int64 `json:"ms,omitempty"`
	Provider string `json:"provider,omitempty"`
	Source   string `json:"source"`
}

// Audit：desktop.audit.append（批次 6）
type Audit interface{ Append(e AuditEntry) }

// Notice：desktop.notify 入参
type Notice struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
	Text  string `json:"text"`
}

// Reminder：desktop.reminders.today() 的条目（只用到这两个字段）
type Reminder struct {
	DueAt int64  `json:"dueAt"`
	Text  string `json:"text"`
}

// NotifyPolicy：SchedulerService 注入给 DesktopService 的免打扰策略
type NotifyPolicy struct {
	Quiet       func() bool
	QuietEndsAt func() int64
}

// GuardResult：broker.guard(path, 'read')
type GuardResult struct {
	OK      bool
	Real    string
	Code    string
	Message string
}

// Broker：PermissionBroker 里批次 8 用到的部分
type Broker interface {
	Guard(ctx context.Context, path, mode string) GuardResult
	// Grant：用户在对话框里选了文件夹 → 记为已授权
	Grant(path string)
	LocalOnly() bool
	// CheckSend：'ok' | 'local_only' | 'user_denied'；p 为 nil 表示没有对话模型（同 Node 的 undefined）
	CheckSend(ctx context.Context, p *SendTarget) string
	OnChange(fn func()) (off func())
}

// SendTarget：chatProvider() 的 { id, name, local }
type SendTarget struct {
	ID    string
	Name  string
	Local bool
}

// Desktop：DesktopService 的切片（main.go 传 knowledgehandlers.DesktopAdapter）
type Desktop interface {
	Audit
	Notify(n Notice)
	SetNotifyPolicy(p NotifyPolicy)
	FlushDeferred()
	DeferredCount() int
	RemindersToday() []Reminder
	Broker() Broker
}

// Dialogs / Shell / Power：HostPorts 的切片
type Ports interface {
	PickDirectory(ctx context.Context, title, buttonLabel string) (string, error)
	SaveFile(ctx context.Context, title, defaultName string, filters []FileFilter) (string, error)
	OpenPath(path string) string
	ShowItemInFolder(path string)
	IdleSeconds() int
}

type FileFilter struct {
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

// Logger 与 Node 的 { info, warn } 对齐
type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
}

// LevelLogger = ILoggerService（error / warn / info / debug）；services.LoggerService 实现
type LevelLogger interface {
	Logger
	Error(msg string, kv ...any)
	Debug(msg string, kv ...any)
}

// Root：宿主启动时装上的 LoggerService（Node 各服务拿到的都是同一个 logger，不带 context）。
// StdLogger 的 Prefix 只在 Root 未装（单元测试）时用于标准库 log 输出。
var Root LevelLogger

type StdLogger struct{ Prefix string }

func (l StdLogger) Info(m string, kv ...any) {
	if Root != nil {
		Root.Info(m, kv...)
		return
	}
	log.Println(append([]any{l.Prefix, m}, kv...)...)
}
func (l StdLogger) Warn(m string, kv ...any) {
	if Root != nil {
		Root.Warn(m, kv...)
		return
	}
	log.Println(append([]any{l.Prefix, "WARN", m}, kv...)...)
}
func (l StdLogger) Error(m string, kv ...any) {
	if Root != nil {
		Root.Error(m, kv...)
		return
	}
	log.Println(append([]any{l.Prefix, "ERROR", m}, kv...)...)
}
func (l StdLogger) Debug(m string, kv ...any) {
	if Root != nil {
		Root.Debug(m, kv...)
	}
}

// AvatarGesture / AvatarEmotion：ai/mascotCommand（契约事件 avatar.event）
func AvatarGesture(ev Events, name string) {
	if ev != nil {
		ev.Publish("avatar.event", map[string]any{"type": "gesture", "name": name})
	}
}

func AvatarEmotion(ev Events, name string) {
	if ev != nil {
		ev.Publish("avatar.event", map[string]any{"type": "emotion", "name": name})
	}
}
