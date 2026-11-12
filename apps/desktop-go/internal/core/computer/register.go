package computer

import (
	"context"
	"encoding/json"
	"runtime"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
)

// VisionOption：设置页里可选的视觉模型
type VisionOption struct {
	Ref      string `json:"ref"`
	Label    string `json:"label"`
	Provider string `json:"provider"`
}

// RegisterOptions：处理函数用到的外部依赖
type RegisterOptions struct {
	// VisionModels：能看图的模型（网关）；nil = 空列表
	VisionModels func() []VisionOption
	// Stop：完整的紧急停止（与快捷键同一个流程：停命令、中止那几轮对话、编程助手的 MCP 会话、撤确认卡）；
	// nil = 只停这台服务里的命令
	Stop func()
	// Shortcut：紧急停止快捷键：注册上的（"" = 没有）与失败原因
	Shortcut func() (accel, err string)
	// AutoApprove / SetAutoApprove：桌面操作是否「始终允许」（desktop 的工具权限）
	AutoApprove    func() bool
	SetAutoApprove func(bool)
}

// Register：契约 media 域 computer.* 过程（设置 → Computer Use），并把「谁在操作桌面」推给对话窗口
func Register(r *contract.Router, s *Service, o RegisterOptions) {
	r.Call("computer.state", func(ctx context.Context, _ contract.Caller, in json.RawMessage) (any, error) {
		var p struct {
			Refresh bool `json:"refresh"`
		}
		_ = json.Unmarshal(in, &p)
		return s.State(ctx, p.Refresh, o), nil
	})
	r.Call("computer.install", func(ctx context.Context, _ contract.Caller, in json.RawMessage) (any, error) {
		var p struct {
			Scope string `json:"scope"`
		}
		_ = json.Unmarshal(in, &p)
		res, err := s.Install(ctx, p.Scope)
		if err != nil {
			return InstallResult{Log: err.Error()}, nil
		}
		return res, nil
	})
	r.Call("computer.openGuide", func(ctx context.Context, _ contract.Caller, _ json.RawMessage) (any, error) {
		g, err := s.OpenGuide(ctx)
		if err != nil {
			return map[string]string{"guide": "error: " + err.Error()}, nil
		}
		return map[string]string{"guide": g}, nil
	})
	r.Call("computer.updateSettings", func(ctx context.Context, _ contract.Caller, in json.RawMessage) (any, error) {
		var p SettingsPatch
		if err := json.Unmarshal(in, &p); err != nil {
			return nil, err
		}
		var auto struct {
			AutoApprove *bool `json:"autoApprove"`
		}
		_ = json.Unmarshal(in, &auto)
		if auto.AutoApprove != nil && o.SetAutoApprove != nil {
			o.SetAutoApprove(*auto.AutoApprove)
		}
		if _, err := s.UpdateSettings(p); err != nil {
			return nil, err
		}
		return s.State(ctx, false, o), nil
	})
	r.Call("computer.active", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return map[string]any{"active": s.Active()}, nil
	})
	r.Call("computer.stop", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		if o.Stop != nil {
			o.Stop()
		} else {
			s.StopAll()
		}
		return true, nil
	})
	r.Call("computer.sandboxAction", func(ctx context.Context, _ contract.Caller, in json.RawMessage) (any, error) {
		var p struct {
			Name, Action string
		}
		_ = json.Unmarshal(in, &p)
		if err := s.SandboxAction(ctx, p.Name, p.Action); err != nil {
			return map[string]any{"ok": false, "message": err.Error()}, nil
		}
		return map[string]any{"ok": true, "message": ""}, nil
	})
	s.OnActivity(func() { r.Emit("computer.activity", map[string]any{"active": s.Active()}) })
	s.OnStateChange(func() { r.Emit("computer.changed", map[string]any{}) })
}

// State：Computer Use 页的状态
func (s *Service) State(ctx context.Context, refresh bool, o RegisterOptions) map[string]any {
	v := s.Versions(ctx, refresh)
	perms := map[string]string{}
	sandboxes, sandboxSupported := []SandboxInfo{}, false
	permApp := s.PermissionApp()
	if v.Installed {
		perms = s.Permissions(ctx)
		if runtime.GOOS == "darwin" {
			sandboxes, sandboxSupported = s.Sandboxes(ctx)
		}
	}
	vm := []VisionOption{}
	if o.VisionModels != nil {
		vm = o.VisionModels()
	}
	st := s.Settings()
	accel, accelErr := "", ""
	if o.Shortcut != nil {
		accel, accelErr = o.Shortcut()
	}
	blocked := st.BlockedApps
	if blocked == nil {
		blocked = []string{}
	}
	return map[string]any{
		"platform": runtime.GOOS, "installed": v.Installed, "path": v.Path, "version": v.Version, "latest": v.Latest,
		"updateAvailable": v.UpdateAvailable, "newerMajor": v.NewerMajor, "supportedMajor": v.SupportedMajor,
		"unsupported": v.Unsupported, "npmAvailable": v.NpmAvailable, "installing": v.Installing,
		"permissions": perms, "permissionApp": permApp, "wayland": s.Wayland(), "cliEnabled": st.CliEnabled,
		"active": s.Active(), "visionModel": st.VisionModel, "visionModels": vm, "blockedApps": blocked,
		"redact": st.Redact, "sandbox": st.Sandbox, "sandboxes": sandboxes, "sandboxSupported": sandboxSupported,
		"stopShortcut": st.StopShortcut, "stopShortcutActive": accel, "stopShortcutError": accelErr,
		"defaultStopShortcut": DefaultStopShortcut, "autoApprove": o.AutoApprove != nil && o.AutoApprove(),
	}
}
