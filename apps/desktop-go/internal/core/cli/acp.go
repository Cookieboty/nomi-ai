package cli

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// AcpDisplayName 返回内置 ACP CLI 的界面名称；缺省返回 "CLI"。
func AcpDisplayName(backend string) string {
	if name := strings.TrimSpace(builtin.DisplayName(backend)); name != "" {
		return name
	}
	return "CLI"
}

// AcpTimeoutMessageFor 返回用于 ACP RPC 请求超时的多语言提示构造器。
func AcpTimeoutMessageFor(backend string) func(string, int) string {
	name := AcpDisplayName(backend)
	return func(_ string, timeoutMs int) string {
		secs := math.Floor(float64(timeoutMs)/1000 + 0.5)
		return i18n.T("electron.common.cli-did-not-respond-for-seconds-so-the", name, secs)
	}
}

// ApplyAcpCapability 将插件声明的 AcpCapability 注入通用 AcpDriverOptions。
func ApplyAcpCapability(opts *drivers.AcpDriverOptions, backend string) {
	if opts == nil {
		return
	}
	cap := builtin.Acp(backend)
	if cap == nil {
		return
	}
	if cap.ClientInfo != nil {
		opts.ClientInfo = cap.ClientInfo()
	}
	if cap.ClientCapabilities != nil {
		opts.ClientCapabilities = cap.ClientCapabilities()
	}
	if cap.DisableElicitation {
		opts.DisableElicitation = true
	}
	if cap.SteerMethod != "" {
		opts.SteerMethod = cap.SteerMethod
	}
	if cap.SessionNotifyMethod != nil {
		opts.SessionNotifyMethod = cap.SessionNotifyMethod
	}
	if cap.ExtractToolName != nil {
		opts.ExtractToolName = cap.ExtractToolName
	}
}

// AcpExtraArgs 返回插件为 ACP 会话额外目录生成的命令行参数。
func AcpExtraArgs(backend string, extraDirs []string) []string {
	if len(extraDirs) == 0 {
		return nil
	}
	cap := builtin.Acp(backend)
	if cap == nil || cap.ExtraArgs == nil {
		return nil
	}
	return cap.ExtraArgs(extraDirs)
}

// AcpInitializeParams 构造轻量 ACP RPC 探测（模型发现、本机登录探测等）所需的 initialize 参数。
func AcpInitializeParams(backend string) *util.Obj {
	caps := util.NewObj()
	var clientInfo *util.Obj
	if cap := builtin.Acp(backend); cap != nil {
		if cap.ClientCapabilities != nil {
			if c := cap.ClientCapabilities(); c != nil {
				caps = c
			}
		}
		if cap.ClientInfo != nil {
			clientInfo = cap.ClientInfo()
		}
	}
	params := util.NewObj(
		"protocolVersion", float64(1),
		"clientCapabilities", caps,
	)
	if clientInfo != nil {
		params.Set("clientInfo", clientInfo)
	}
	return params
}

// ParseAcpSessionCatalog 将 ACP session/new / session/load 响应解析为统一的模型目录。
// 优先采用插件自定义的 ParseSession；否则退回标准 ACP 协议解析器。
func ParseAcpSessionCatalog(backend string, sessionRaw *util.Obj) *util.Obj {
	if sessionRaw == nil {
		return nil
	}
	if impl := builtin.Impl(backend); impl != nil && impl.Models != nil && impl.Models.ParseSession != nil {
		return impl.Models.ParseSession(sessionRaw)
	}
	return shared.ParseAcpSessionModels(backend, sessionRaw)
}

// ResolveAcpOverride 将用户选择的模型与思考深度解析为 ACP 协议下发参数。
// 返回值 hasCustomResolver 为 true 时表示由插件自身提供 ResolveOverride。
func ResolveAcpOverride(backend string, catalog *util.Obj, modelID, effort string) (ov clisdk.ModelOverride, hasCustomResolver bool) {
	if impl := builtin.Impl(backend); impl != nil && impl.Models != nil && impl.Models.ResolveOverride != nil {
		return impl.Models.ResolveOverride(catalog, modelID, effort), true
	}
	return shared.ResolveAcpModelOverride(catalog, modelID, effort), false
}
