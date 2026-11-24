// Package claudert connects the official Claude stream-json driver to product chat.
// No credential files, gateway provider or harness tab are involved.
package claudert

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

// PermissionModes 返回 Claude Code 底座支持的产品侧权限档位列表。
func PermissionModes() []string {
	supported := claude.Permissions.Supported
	seen := make(map[string]struct{}, len(supported))
	modes := make([]string, 0, len(supported))
	for _, raw := range supported {
		mode := toManagedPermissionMode(raw)
		if mode == "" {
			continue
		}
		if _, ok := seen[mode]; ok {
			continue
		}
		seen[mode] = struct{}{}
		modes = append(modes, mode)
	}
	if len(modes) == 0 {
		return []string{"ask"}
	}
	return modes
}

func toManagedPermissionMode(cliMode string) string {
	switch cliMode {
	case "plan", "deny":
		return "deny"
	case "manual", "ask":
		return "ask"
	case "acceptEdits":
		return "acceptEdits"
	case "auto":
		return "auto"
	case "bypass":
		return "bypass"
	default:
		return ""
	}
}

func toCliPermissionMode(managedMode string) string {
	switch managedMode {
	case "deny", "plan":
		return "plan"
	case "ask", "manual":
		return "manual"
	case "acceptEdits":
		return "acceptEdits"
	case "auto", "":
		return "auto"
	case "bypass":
		return "bypass"
	default:
		return "manual"
	}
}

func defaultPermissionMode() string {
	supported := PermissionModes()
	for _, want := range []string{"auto", "acceptEdits", "ask"} {
		for _, m := range supported {
			if m == want {
				return want
			}
		}
	}
	return supported[0]
}

func effectivePermissionMode(mode string) string {
	if mode == "" {
		return defaultPermissionMode()
	}
	return mode
}

func effectiveNativeMode(permMode, source string) string {
	cliMode := toCliPermissionMode(effectivePermissionMode(permMode))
	native := sh.ClaudeMode[cliMode]
	if native == "" {
		native = "default"
	}
	// Claude 原生 auto 依赖官方服务端分类器；第三方网关统一降级为 acceptEdits。
	if source == "thirdParty" && native == "auto" {
		return "acceptEdits"
	}
	return native
}

type ComputerMcpConfig struct {
	Name    string
	Command string
	Args    []string
}

type Config struct {
	Executable, Cwd, ConfigDir string
	Model                      string
	Effort                     string
	PermissionMode             string
	Source                     string
	AccountID                  string
	ExtraEnv                   map[string]string
	StripEnv                   []string
	ExtraArgs                  []string
	ModelInConfig              bool
	LaunchSig                  string
	OnRelease                  func()
	ComputerMcp                *ComputerMcpConfig
}
type Factory struct {
	mu        sync.Mutex
	resolve   func(string) (Config, error)
	instances map[string]map[string]*Runtime
}

func New(resolve func(string) (Config, error)) *Factory {
	return &Factory{resolve: resolve, instances: map[string]map[string]*Runtime{}}
}

// DefaultConfig performs metadata-only discovery. Login is intentionally unverified;
// only the official CLI may consult its own login when the user sends a turn.
func DefaultConfig(cwd string) (Config, error) {
	executable, err := exec.LookPath("claude")
	if err != nil {
		return Config{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	config := os.Getenv("CLAUDE_CONFIG_DIR")
	if config == "" {
		config = filepath.Join(home, ".claude")
	}
	return Config{Executable: executable, Cwd: cwd, ConfigDir: config}, nil
}
func (f *Factory) Target(id string) (cr.Target, error) {
	cfg, err := f.resolve(id)
	if err != nil {
		return cr.Target{}, err
	}
	for _, s := range []string{cfg.Executable, cfg.Cwd, cfg.ConfigDir} {
		if !filepath.IsAbs(s) {
			return cr.Target{}, errors.New("Claude binding paths must be absolute")
		}
	}
	cfg.Executable, err = filepath.EvalSymlinks(cfg.Executable)
	if err != nil {
		return cr.Target{}, err
	}
	cfg.Cwd, err = filepath.EvalSymlinks(cfg.Cwd)
	if err != nil {
		return cr.Target{}, err
	}
	if physical, e := filepath.EvalSymlinks(cfg.ConfigDir); e == nil {
		cfg.ConfigDir = physical
	}
	bin, err := os.Stat(cfg.Executable)
	if err != nil {
		return cr.Target{}, err
	}
	dir, err := os.Stat(cfg.Cwd)
	if err != nil || !dir.IsDir() {
		return cr.Target{}, errors.New("Claude working directory unavailable")
	}
	fingerprint := "safe-mode-restricted-read-only-v1:" + directoryIdentity(cfg.Cwd, dir)
	if cfg.ComputerMcp != nil && cfg.ComputerMcp.Name != "" {
		fingerprint += ":mcp:" + cfg.ComputerMcp.Name
	}
	if cfg.LaunchSig != "" {
		fingerprint += ":" + cfg.LaunchSig
	}
	source := cfg.Source
	if source == "" {
		source = "official-default-login-unverified"
	}
	accountID := "config-source:" + cfg.ConfigDir
	switch cfg.Source {
	case "official":
		if cfg.AccountID != "" {
			accountID = cfg.AccountID
		}
	case "thirdParty":
		accountID = "thirdParty"
	case "local":
		accountID = "local"
	}
	identity := cr.NativeIdentity{DriverID: "claude", Transport: "official-stream-json", DriverVersion: "contract-2.1.318-v1", ResumeProtocol: "confirmed-warm-only-v1", Executable: cfg.Executable, Source: source, AccountID: accountID, ConfigDir: cfg.ConfigDir, Cwd: cfg.Cwd, ConfigGen: 1, ExecutableSize: bin.Size(), ExecutableMtimeMS: bin.ModTime().UnixMilli(), LaunchFingerprint: fingerprint}
	// Executable replacement is a different compatibility key, never a native-ID overwrite.
	identity.DriverVersion += fmt.Sprintf(":%d:%d", bin.Size(), bin.ModTime().UnixNano())
	mode := effectivePermissionMode(cfg.PermissionMode)
	env := cr.CompatibilityKey{Model: cfg.Model, PermissionMode: mode}
	if env.Model == "" {
		env.Model = "cli-default"
	}
	key := identity.Key(env)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.instances[id] == nil {
		f.instances[id] = map[string]*Runtime{}
	}
	r := f.instances[id][key]
	if r == nil {
		r = &Runtime{config: cfg}
		f.instances[id][key] = r
	}
	return cr.Target{Runtime: r, Identity: identity, Env: env, Effort: cfg.Effort}, nil
}
func (f *Factory) Release(id string) {
	f.mu.Lock()
	runtimes := f.instances[id]
	delete(f.instances, id)
	f.mu.Unlock()
	for _, r := range runtimes {
		r.close()
		if r.config.OnRelease != nil {
			r.config.OnRelease()
		}
	}
}
