package computer

// 隔离模式：agent-desktop 的沙箱（每个是一台独立的 macOS 虚拟机，只在 Apple Silicon Mac 上）。
// 设置里选了沙箱后，所有操作经 `sandbox exec <名字> --` 在虚拟机里做（agentdesktop.go），不碰这台电脑的桌面。
// 创建沙箱要下载系统镜像并在虚拟机里手动开一次远程登录与辅助功能，这里只列出、启动、停止；创建见文档。

import (
	"context"
	"encoding/json"
	"time"
)

// SandboxInfo：一个沙箱
type SandboxInfo struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	Provider string `json:"provider,omitempty"`
}

// parseSandboxes：sandbox list 的 data（数组，或 {sandboxes: [...]}）
func parseSandboxes(data json.RawMessage) []SandboxInfo {
	var list []SandboxInfo
	if json.Unmarshal(data, &list) == nil {
		return clean(list)
	}
	var wrap struct {
		Sandboxes []SandboxInfo `json:"sandboxes"`
	}
	if json.Unmarshal(data, &wrap) == nil {
		return clean(wrap.Sandboxes)
	}
	return []SandboxInfo{}
}

func clean(list []SandboxInfo) []SandboxInfo {
	out := []SandboxInfo{}
	for _, x := range list {
		if reSandboxName.MatchString(x.Name) {
			out = append(out, x)
		}
	}
	return out
}

// Sandboxes：本机的沙箱；supported = 装的 agent-desktop 有 sandbox 命令（较早的版本没有，如 1.2.0）
func (s *Service) Sandboxes(ctx context.Context) (list []SandboxInfo, supported bool) {
	if s.Bin() == "" {
		return []SandboxInfo{}, false
	}
	data, err := s.callHost(ctx, 15*time.Second, "sandbox", "list")
	if err != nil {
		// 没有这个子命令：INVALID_ARGS（unrecognized subcommand）；其它错误（平台不支持等）也按不能用
		return []SandboxInfo{}, false
	}
	return parseSandboxes(data), true
}

// SandboxAction：start / stop 一个沙箱
func (s *Service) SandboxAction(ctx context.Context, name, action string) error {
	if !reSandboxName.MatchString(name) {
		return errf("INVALID_ARGS", "沙箱名字不对")
	}
	switch action {
	case "start":
		_, err := s.callHost(ctx, 5*time.Minute, "sandbox", "start", name)
		return err
	case "stop":
		_, err := s.callHost(ctx, 2*time.Minute, "sandbox", "stop", name)
		return err
	}
	return errf("INVALID_ARGS", "未知操作 %s", action)
}
