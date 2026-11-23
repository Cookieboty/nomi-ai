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

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

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
	mode := cfg.PermissionMode
	if mode == "" {
		mode = "ask"
	}
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
