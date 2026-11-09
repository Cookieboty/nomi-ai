// Package builtin：内置编程助手的注册表——内核里要按 CLI 区分的名单、显示名、能力都从这里取，不在各处写死
// （docs/development/coding-agents.md「内置助手注册表」）。
// 数据（清单、顺序、host 信息）只来自 cliplugins/catalog（由 packages/cli-catalog 生成）；这里只登记代码：
// 每个 CLI 的主进程实现（CreateMain）与会话记录解析。
package builtin

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/catalog"
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

// Entry：一个内置 CLI 的代码部分（数据都在清单里：cliplugins/catalog，唯一来源是 packages/cli-catalog）
type Entry struct {
	// CreateMain：主进程实现（启动、权限、账号、历史、斜杠命令、终端……）
	CreateMain func() *clisdk.CliMainImpl
	// Transcript：会话记录 → 消息（历史、接着聊）；nil = 不能读历史（清单 capabilities.history 要与它一致）
	Transcript func(text string, fallbackAt float64) []sh.Json
}

// entries：每个内置 CLI 的代码；id 必须与 catalog 的清单一一对应（测试检查）
var entries = map[string]Entry{
	"claude":  {CreateMain: claude.CreateMain, Transcript: claude.ParseTranscript},
	"codex":   {CreateMain: codex.CreateMain, Transcript: codex.ParseTranscript},
	"dsh":     {CreateMain: dsh.CreateMain, Transcript: dsh.ParseTranscript},
	"gemini":  {CreateMain: gemini.CreateMain, Transcript: gemini.ParseTranscript},
	"grok":    {CreateMain: grok.CreateMain, Transcript: grok.ParseTranscript},
	"kimi":    {CreateMain: kimi.CreateMain},
	"minimax": {CreateMain: minimax.CreateMain},
}

// IDs：内置 CLI 的 id，按 id 排序（与 cli-catalog 的 BUILTIN_CLI_IDS 一致）
var IDs = catalog.IDs

// Ordered：界面与名单里的顺序（cli-catalog 的 BUILTIN_CLI_ORDER）
var Ordered = catalog.Order

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

// Manifests = BUILTIN_MANIFESTS（与 catalog 同一对象；调用方需修改时 Clone）。
var Manifests = func() *util.Obj {
	o := util.NewObj()
	for _, id := range IDs {
		o.Set(id, catalog.Manifest(id))
	}
	return o
}()

// Renderers = BUILTIN_RENDERER。
var Renderers = func() *util.Obj {
	o := util.NewObj()
	for _, id := range IDs {
		o.Set(id, sh.RendererInfo(catalog.Manifest(id)))
	}
	return o
}()

func Manifest(id string) *util.Obj { return catalog.Manifest(id) }

// Plugins：内置插件（插件宿主用）。Main 返回 Impl(id) 那一份：宿主和直接调 Impl 的地方（账号、权限、模型参数、
// 历史、斜杠命令……）用的是同一个实例，不会各建一份、状态分叉
var Plugins = func() map[string]clisdk.CliPlugin {
	out := map[string]clisdk.CliPlugin{}
	for _, id := range IDs {
		out[id] = clisdk.CliPlugin{Manifest: catalog.Manifest(id),
			Main: func(clisdk.CliMainHost) (*clisdk.CliMainImpl, error) { return Impl(id), nil }}
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

// FullName：完整名称（「Gemini CLI」：清单 fullName，缺省 = 显示名）；不是内置的返回空
func FullName(id string) string {
	if m := Manifest(id); m != nil {
		if f := util.Str(m.Get("fullName")); f != "" {
			return f
		}
	}
	return DisplayName(id)
}

// 清单 host 段：内核运行它要知道的事

// MinNode：要求的最低 Node 主版本（0 = 不检查）
func MinNode(id string) int { n, _ := catalog.Host(id).Get("minNode").(float64); return int(n) }

// SelfUpdate：能不能用 `<bin> update` 自己更新：""（只走 npm）、"native"（原生安装 / 来源不明时）、"always"
func SelfUpdate(id string) string { return util.Str(catalog.Host(id).Get("selfUpdate")) }

// Vendor：官方账号的模型厂商（网关 provider id）
func Vendor(id string) string { return util.Str(catalog.Host(id).Get("vendor")) }

// AcpArgs：以 ACP 长驻会话启动时的参数
func AcpArgs(id string) []string { return catalog.HostList(id, "acpArgs") }

// HomeEnv：指定 CLI 主目录的环境变量（账号目录 / 第三方私有目录经它传入）
func HomeEnv(id string) string { return util.Str(catalog.Host(id).Get("homeEnv")) }

// PlanFollowUp：计划模式一轮做完后由 Nomi 提供「执行这个计划」
func PlanFollowUp(id string) bool { b, _ := catalog.Host(id).Get("planFollowUp").(bool); return b }

// NomiCommand：有 ~/.nomi/bin 下的 nomi-<id> 命令
func NomiCommand(id string) bool { b, _ := catalog.Host(id).Get("nomiCommand").(bool); return b }

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

// WithHistory：能列历史会话（清单 capabilities.history；插件的 History 与 Transcript 要与它一致，测试检查）
func WithHistory(id string) bool { return Capability(id, "history") }

// WithThirdParty：能接第三方模型（清单 thirdParty；经 Nomi 网关）
func WithThirdParty(id string) bool { return Capability(id, "thirdParty") }

// WithQuota：能查订阅额度（清单 usageQuota）
func WithQuota(id string) bool { return Capability(id, "usageQuota") }
