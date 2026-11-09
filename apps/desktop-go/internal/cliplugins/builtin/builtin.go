// Package builtin：内置编程助手的注册表——内核里要按 CLI 区分的名单、显示名、能力都从这里取，不在各处写死
// （docs/development/coding-agents.md「加一个内置助手」）。
// 每个内置 CLI 一条 Entry：清单（与 packages/cli-catalog/src/<id>/manifest.ts 一致）、渲染信息、网关条目、
// 主进程实现（CreateMain）与少数不在插件契约里的函数（会话记录解析）。
package builtin

import (
	"slices"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/dsh"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/kimi"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/minimax"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Entry：一个内置 CLI
type Entry struct {
	Manifest   *util.Obj
	Renderer   *util.Obj
	Gateway    any // 网关条目（gateway/clients 的 ClientSpec 形状）
	CreateMain func() *clisdk.CliMainImpl
	// FullName：完整名称（看板、用量、灵动岛）；空 = 清单的 displayName
	FullName string
	// Transcript：会话记录 → 消息（历史、接着聊）；nil = 不能读历史
	Transcript func(text string, fallbackAt float64) []sh.Json
	// MinNode：要求的最低 Node 主版本（npm 装的 CLI；0 = 不检查）
	MinNode int
	// AcpArgs：以 ACP 长驻会话启动时的参数（清单 transport 为 acp 的）
	AcpArgs []string
	// Vendor：官方账号的模型厂商（网关 provider id：anthropic / openai / xai / google / deepseek）
	Vendor string
	// PlanFollowUp：计划模式这一轮做完后，由 Nomi 提供「执行这个计划」（CLI 自己没有批准计划的环节）
	PlanFollowUp bool
	// SelfUpdate：能不能用 `<bin> update` 自己更新：""（不能，只走 npm）、"native"（原生安装 / 来源不明时）、"always"
	SelfUpdate string
}

// entries：注册顺序即 IDs 的顺序（按 id 排序，与 packages/cli-catalog/src/generated/ids.ts 一致）
var entries = map[string]Entry{
	"claude": {Manifest: claude.Manifest, Renderer: claude.Renderer, Gateway: claude.Gateway, CreateMain: claude.CreateMain,
		Transcript: claude.ParseTranscript, MinNode: 22, SelfUpdate: "native", Vendor: "anthropic"},
	"codex": {Manifest: codex.Manifest, Renderer: codex.Renderer, Gateway: codex.Gateway, CreateMain: codex.CreateMain,
		Transcript: codex.ParseTranscript, MinNode: 16, SelfUpdate: "native", Vendor: "openai", PlanFollowUp: true},
	"dsh": {Manifest: dsh.Manifest, Renderer: dsh.Renderer, Gateway: dsh.Gateway, CreateMain: dsh.CreateMain,
		Transcript: dsh.ParseTranscript, MinNode: 24, Vendor: "deepseek", PlanFollowUp: true},
	"gemini": {Manifest: gemini.Manifest, Renderer: gemini.Renderer, Gateway: gemini.Gateway, CreateMain: gemini.CreateMain,
		FullName: "Gemini CLI", Transcript: gemini.ParseTranscript, MinNode: 20, Vendor: "google", AcpArgs: []string{"--acp"}},
	"grok": {Manifest: grok.Manifest, Renderer: grok.Renderer, Gateway: grok.Gateway, CreateMain: grok.CreateMain,
		Transcript: grok.ParseTranscript, MinNode: 18, SelfUpdate: "always", Vendor: "xai", PlanFollowUp: true, AcpArgs: []string{"agent", "stdio"}},
	// ACP 助手：不能读历史会话（Transcript nil），只用官方账号；会话在标签里用 session/load 接着聊
	"kimi": {Manifest: kimi.Manifest, Renderer: kimi.Renderer, CreateMain: kimi.CreateMain,
		MinNode: 22, Vendor: "moonshot", AcpArgs: []string{"acp"}},
	"minimax": {Manifest: minimax.Manifest, Renderer: minimax.Renderer, CreateMain: minimax.CreateMain,
		MinNode: 22, SelfUpdate: "always", Vendor: "minimax", AcpArgs: []string{"acp"}},
}

// IDs：内置 CLI 的 id（与 packages/cli-catalog/src/generated/ids.ts 一致：目录名，排好序）。
var IDs = func() []string {
	ids := make([]string, 0, len(entries))
	for id := range entries {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}()

// Ordered：界面与名单里的顺序（先来的在前，新加的接在后面）；IDs 是按 id 排序的
var Ordered = []string{"claude", "codex", "grok", "gemini", "dsh", "kimi", "minimax"}

// IsBuiltinCliID：v 是否内置 CLI 的 id。
func IsBuiltinCliID(v any) bool {
	s, ok := v.(string)
	_, known := entries[s]
	return ok && known
}

// Get：id 对应的条目（不是内置的 ok=false）
func Get(id string) (Entry, bool) {
	e, ok := entries[id]
	return e, ok
}

// Manifests = BUILTIN_MANIFESTS（与各插件 Manifest 同一对象；调用方需修改时 Clone）。
var Manifests = func() *util.Obj {
	o := util.NewObj()
	for _, id := range IDs {
		o.Set(id, entries[id].Manifest)
	}
	return o
}()

// Renderers = BUILTIN_RENDERER。
var Renderers = func() *util.Obj {
	o := util.NewObj()
	for _, id := range IDs {
		o.Set(id, entries[id].Renderer)
	}
	return o
}()

// GatewayEntries：各内置 CLI 的网关条目（顺序同 IDs）。
var GatewayEntries = func() []any {
	out := make([]any, 0, len(IDs))
	for _, id := range IDs {
		out = append(out, entries[id].Gateway)
	}
	return out
}()

func Manifest(id string) *util.Obj { m, _ := Manifests.Get(id).(*util.Obj); return m }

// Plugins：内置插件（插件宿主用）。
var Plugins = func() map[string]clisdk.CliPlugin {
	out := map[string]clisdk.CliPlugin{}
	for _, id := range IDs {
		create := entries[id].CreateMain
		out[id] = clisdk.CliPlugin{Manifest: entries[id].Manifest,
			Main: func(clisdk.CliMainHost) (*clisdk.CliMainImpl, error) { return create(), nil }}
	}
	return out
}()

var (
	implMu sync.Mutex
	impls  = map[string]*clisdk.CliMainImpl{}
)

// Impl：id 的主进程实现（插件能力：权限、账号、历史、斜杠命令、终端……；每个 id 只建一次）；不是内置的返回 nil
func Impl(id string) *clisdk.CliMainImpl {
	e, ok := entries[id]
	if !ok {
		return nil
	}
	implMu.Lock()
	defer implMu.Unlock()
	if m := impls[id]; m != nil {
		return m
	}
	m := e.CreateMain()
	impls[id] = m
	return m
}

// DisplayName：清单的显示名（「Gemini」）；不是内置的返回空
func DisplayName(id string) string {
	if m := Manifest(id); m != nil {
		return util.Str(m.Get("displayName"))
	}
	return ""
}

// FullName：完整名称（「Gemini CLI」）；不是内置的返回空
func FullName(id string) string {
	if e, ok := entries[id]; ok && e.FullName != "" {
		return e.FullName
	}
	return DisplayName(id)
}

// Capability：清单 capabilities 里的布尔能力（officialAccount、thirdParty、usageQuota、terminalCommand……）
func Capability(id, name string) bool {
	m := Manifest(id)
	if m == nil {
		return false
	}
	caps, _ := m.Get("capabilities").(*util.Obj)
	if caps == nil {
		return false
	}
	b, _ := caps.Get(name).(bool)
	return b
}

// Transport：清单的传输（stream-json / app-server / acp / exec / dsh）
func Transport(id string) string {
	if m := Manifest(id); m != nil {
		return util.Str(m.Get("transport"))
	}
	return ""
}

// Binaries：可执行文件名（清单 binary.names）
func Binaries(id string) []string {
	m := Manifest(id)
	if m == nil {
		return nil
	}
	b, _ := m.Get("binary").(*util.Obj)
	if b == nil {
		return nil
	}
	out := []string{}
	if names, ok := b.Get("names").([]any); ok {
		for _, n := range names {
			out = append(out, util.Str(n))
		}
	}
	return out
}

// NpmPackage：npm 包名（清单 binary.install.npm）；不是 npm 装的返回空
func NpmPackage(id string) string {
	m := Manifest(id)
	if m == nil {
		return ""
	}
	b, _ := m.Get("binary").(*util.Obj)
	if b == nil {
		return ""
	}
	in, _ := b.Get("install").(*util.Obj)
	if in == nil {
		return ""
	}
	return util.Str(in.Get("npm"))
}

// BinEnv：指定可执行文件路径的环境变量（NOMI_<ID>_BIN）
func BinEnv(id string) string { return "NOMI_" + strings.ToUpper(id) + "_BIN" }

// Where：满足条件的内置 id（按 Ordered）
func Where(pred func(id string) bool) []string {
	out := []string{}
	for _, id := range Ordered {
		if pred(id) {
			out = append(out, id)
		}
	}
	return out
}

// All：所有内置 id（按 Ordered）
func All(string) bool { return true }

// UsesAcp：清单的传输是 ACP（长驻会话走 ACP 驱动）
func UsesAcp(id string) bool { return Transport(id) == "acp" }

// WithAccounts：能多账号（插件有 Accounts）
func WithAccounts(id string) bool { return Impl(id) != nil && Impl(id).Accounts != nil }

// WithHistory：能列历史会话（插件有 History，且能解析会话记录）
func WithHistory(id string) bool {
	e, ok := entries[id]
	return ok && e.Transcript != nil && Impl(id).History != nil
}

// WithThirdParty：能接第三方模型（清单 thirdParty；经 Nomi 网关）
func WithThirdParty(id string) bool { return Capability(id, "thirdParty") }

// WithQuota：能查订阅额度（清单 usageQuota）
func WithQuota(id string) bool { return Capability(id, "usageQuota") }
