package computer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Settings：Computer Use 的设置（userData/desktop/computer.json）
type Settings struct {
	// CliEnabled：允许编程助手（Claude Code、Codex、Gemini…）经 Nomi 的 MCP 使用 computer_* 工具。
	// 默认开（没装 agent-desktop 时不注入）；每个操作照样要在 Nomi 里确认
	CliEnabled bool `json:"cliEnabled"`
	// VisionModel：视觉兜底用的模型（<供应商 id>/<模型 id>）；"" = 不用视觉兜底（computer_locate 不提供）
	VisionModel string `json:"visionModel,omitempty"`
	// BlockedApps：用户另外禁止操作的应用（名字或 bundle id，不区分大小写）；内置的黑名单之外再加，不能放开内置的
	BlockedApps []string `json:"blockedApps,omitempty"`
	// Redact：读界面时隐去输入框里的内容（只留长度），名字和按钮照常
	Redact bool `json:"redact,omitempty"`
	// Sandbox：隔离模式：所有操作都在这个 agent-desktop 沙箱（独立的 macOS 虚拟机）里做；"" = 直接操作这台电脑
	Sandbox string `json:"sandbox,omitempty"`
	// StopShortcut：紧急停止的系统级快捷键（Wails 写法）；"" = 默认 DefaultStopShortcut，"off" = 不注册
	StopShortcut string `json:"stopShortcut,omitempty"`
}

// DefaultStopShortcut：紧急停止的默认快捷键（⌘⇧. / Ctrl+Shift+.；不和系统的强制退出、任务管理器冲突）
const DefaultStopShortcut = "CmdOrCtrl+Shift+."

// EffectiveStopShortcut：实际要注册的快捷键（"" = 不注册）
func (st Settings) EffectiveStopShortcut() string {
	switch st.StopShortcut {
	case "":
		return DefaultStopShortcut
	case "off":
		return ""
	}
	return st.StopShortcut
}

var reAccel = regexp.MustCompile(`^[A-Za-z]+(\+[A-Za-z]+)*\+([A-Za-z0-9]+|[!-~])$`)

var reSandboxName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

const maxBlockedApps = 100

func (s *Service) loadSettings() {
	if s.settingsPath == "" {
		return
	}
	b, err := os.ReadFile(s.settingsPath)
	if err != nil {
		return
	}
	st := s.settings // 文件里没有的项保留默认值（如 cliEnabled 默认开）
	if json.Unmarshal(b, &st) == nil {
		s.settings = sanitizeSettings(st)
	}
}

func sanitizeSettings(st Settings) Settings {
	seen := map[string]bool{}
	apps := []string{}
	for _, a := range st.BlockedApps {
		a = strings.TrimSpace(a)
		if a == "" || len([]rune(a)) > 200 || seen[strings.ToLower(a)] || len(apps) >= maxBlockedApps {
			continue
		}
		seen[strings.ToLower(a)] = true
		apps = append(apps, a)
	}
	st.BlockedApps = apps
	if st.Sandbox != "" && !reSandboxName.MatchString(st.Sandbox) {
		st.Sandbox = ""
	}
	if len(st.VisionModel) > 300 || (st.VisionModel != "" && !strings.Contains(st.VisionModel, "/")) {
		st.VisionModel = ""
	}
	st.StopShortcut = strings.TrimSpace(st.StopShortcut)
	if st.StopShortcut != "" && st.StopShortcut != "off" && (len(st.StopShortcut) > 60 || !reAccel.MatchString(st.StopShortcut)) {
		st.StopShortcut = ""
	}
	return st
}

// Settings：当前设置
func (s *Service) Settings() Settings {
	s.setMu.Lock()
	defer s.setMu.Unlock()
	st := s.settings
	st.BlockedApps = append([]string(nil), st.BlockedApps...)
	return st
}

// SettingsPatch：要改的项（nil = 不改）
type SettingsPatch struct {
	CliEnabled  *bool     `json:"cliEnabled"`
	VisionModel *string   `json:"visionModel"`
	BlockedApps *[]string `json:"blockedApps"`
	Redact      *bool     `json:"redact"`
	Sandbox     *string   `json:"sandbox"`
	// StopShortcut：紧急停止快捷键；"" = 恢复默认，"off" = 关闭
	StopShortcut *string `json:"stopShortcut"`
}

// UpdateSettings：改设置并保存，返回改后的设置
func (s *Service) UpdateSettings(p SettingsPatch) (Settings, error) {
	s.setMu.Lock()
	st := s.settings
	if p.CliEnabled != nil {
		st.CliEnabled = *p.CliEnabled
	}
	if p.VisionModel != nil {
		st.VisionModel = strings.TrimSpace(*p.VisionModel)
	}
	if p.BlockedApps != nil {
		st.BlockedApps = *p.BlockedApps
	}
	if p.Redact != nil {
		st.Redact = *p.Redact
	}
	if p.Sandbox != nil {
		st.Sandbox = strings.TrimSpace(*p.Sandbox)
	}
	if p.StopShortcut != nil {
		st.StopShortcut = *p.StopShortcut
	}
	st = sanitizeSettings(st)
	sandboxChanged := st.Sandbox != s.settings.Sandbox
	s.settings = st
	err := s.saveLocked()
	s.setMu.Unlock()
	if sandboxChanged {
		// 换了操作的桌面：旧的 ref 都不能用了
		s.mu.Lock()
		s.refs, s.snaps, s.snapApp = map[string]RefInfo{}, nil, map[string]string{}
		s.mu.Unlock()
	}
	s.setMu.Lock()
	ls := append([]func(Settings){}, s.setListeners...)
	s.setMu.Unlock()
	cur := s.Settings()
	for _, fn := range ls {
		fn(cur)
	}
	return cur, err
}

// OnSettingsChange：设置改了之后回调（重新注册快捷键等）
func (s *Service) OnSettingsChange(fn func(Settings)) {
	s.setMu.Lock()
	s.setListeners = append(s.setListeners, fn)
	s.setMu.Unlock()
}

// SetCliEnabled：打开 / 关闭编程助手使用 computer_*（之后启动的编程助手进程生效）
func (s *Service) SetCliEnabled(v bool) error {
	_, err := s.UpdateSettings(SettingsPatch{CliEnabled: &v})
	return err
}

func (s *Service) saveLocked() error {
	if s.settingsPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.settingsPath), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(s.settings, "", "  ")
	tmp := s.settingsPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.settingsPath)
}

// userBlocked：用户另外禁止的应用。名字按包含匹配、不分大小写（填「Slack」也拦「Slack Helper」，
// 填「微信」拦「微信」「微信输入法」）；bundle id 按整段或前缀匹配（填「com.tencent.」拦这家的所有应用）
func (s *Service) userBlocked(name, bundleID string) string {
	n := strings.ToLower(strings.Join(strings.Fields(name), " "))
	b := strings.ToLower(strings.TrimSpace(bundleID))
	for _, a := range s.Settings().BlockedApps {
		x := strings.ToLower(strings.Join(strings.Fields(a), " "))
		if x == "" {
			continue
		}
		hit := n != "" && strings.Contains(n, x)
		if !hit && b != "" {
			hit = b == x || (strings.HasSuffix(x, ".") && strings.HasPrefix(b, x)) || strings.HasPrefix(b, x+".")
		}
		if hit {
			return "「" + name + "」在你设置的禁止操作列表里"
		}
	}
	return ""
}
