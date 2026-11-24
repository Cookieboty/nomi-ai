// Package dshrt connects headless dsh (DeepSeek Harness) to product chat in a
// restricted read-only mode. Metadata registration never executes the CLI binary.
package dshrt

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/catalog"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

type Config struct {
	BackendID, Executable, Cwd, ConfigDir string
	Model                                 string
	Effort                                string
	PermissionMode                        string
	Source                                string
	AccountID                             string
	ExtraEnv                              map[string]string
	StripEnv                              []string
	ExtraArgs                             []string
	ModelInConfig                         bool
	LaunchSig                             string
	OnRelease                             func()
}

// PermissionModes 返回指定 DSH 底座支持的产品侧权限模式列表。
func PermissionModes(backendID string) []string {
	impl := builtin.Impl(backendID)
	if impl == nil || impl.Permissions == nil || len(impl.Permissions.Supported) == 0 {
		return []string{"deny"}
	}
	seen := make(map[string]struct{}, len(impl.Permissions.Supported))
	modes := make([]string, 0, len(impl.Permissions.Supported))
	for _, raw := range impl.Permissions.Supported {
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
		return []string{"deny"}
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

func defaultPermissionMode(backendID string) string {
	supported := PermissionModes(backendID)
	for _, want := range []string{"auto", "acceptEdits", "ask"} {
		for _, m := range supported {
			if m == want {
				return want
			}
		}
	}
	return supported[0]
}

func dshPermissionEnv(mode string) string {
	switch mode {
	case "acceptEdits":
		return "workspace-write"
	case "bypass":
		return "danger-full-access"
	default:
		return "read-only"
	}
}

type Factory struct {
	backendID string
	mu        sync.Mutex
	resolve   func(string) (Config, error)
	instances map[string]map[string]*Runtime
}

func New(backendID string, resolve func(string) (Config, error)) *Factory {
	return &Factory{
		backendID: backendID,
		resolve:   resolve,
		instances: map[string]map[string]*Runtime{},
	}
}

// DefaultConfig performs metadata-only discovery via PATH without executing dsh.
func DefaultConfig(backendID, cwd string) (Config, error) {
	if builtin.Transport(backendID) != "exec" {
		return Config{}, fmt.Errorf("%q is not a builtin exec CLI", backendID)
	}
	var executable string
	for _, bin := range builtin.Binaries(backendID) {
		if bin == "" {
			continue
		}
		if p, err := exec.LookPath(bin); err == nil {
			executable = p
			break
		}
	}
	if executable == "" {
		return Config{}, fmt.Errorf("%s executable not found on PATH", builtin.FullName(backendID))
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	cfgDir := ""
	if envVar := builtin.HomeEnv(backendID); envVar != "" {
		cfgDir = os.Getenv(envVar)
	}
	if cfgDir == "" {
		homeDirs := catalog.HostList(backendID, "homeDirs")
		if len(homeDirs) > 0 && homeDirs[0] != "" {
			cfgDir = filepath.Join(home, homeDirs[0])
		} else {
			cfgDir = filepath.Join(home, "."+backendID)
		}
	}
	return Config{
		BackendID:  backendID,
		Executable: executable,
		Cwd:        cwd,
		ConfigDir:  cfgDir,
	}, nil
}

func (f *Factory) Target(id string) (cr.Target, error) {
	r, err := f.runtime(id)
	if err != nil {
		return cr.Target{}, err
	}
	return r.target(), nil
}

func (f *Factory) runtime(id string) (*Runtime, error) {
	if f.resolve == nil {
		return nil, errors.New("dsh binding resolver unavailable")
	}
	cfg, err := f.resolve(id)
	if err != nil {
		return nil, err
	}
	if cfg.BackendID == "" {
		cfg.BackendID = f.backendID
	}
	if builtin.Transport(cfg.BackendID) != "exec" {
		return nil, fmt.Errorf("%q is not a builtin exec CLI", cfg.BackendID)
	}
	for _, s := range []string{cfg.Executable, cfg.Cwd, cfg.ConfigDir} {
		if !filepath.IsAbs(s) {
			return nil, fmt.Errorf("%s binding paths must be absolute", builtin.FullName(cfg.BackendID))
		}
	}
	cfg.Executable, err = filepath.EvalSymlinks(cfg.Executable)
	if err != nil {
		return nil, err
	}
	cfg.Cwd, err = filepath.EvalSymlinks(cfg.Cwd)
	if err != nil {
		return nil, err
	}
	if physical, e := filepath.EvalSymlinks(cfg.ConfigDir); e == nil {
		cfg.ConfigDir = physical
	}
	bin, err := os.Stat(cfg.Executable)
	if err != nil {
		return nil, err
	}
	dir, err := os.Stat(cfg.Cwd)
	if err != nil || !dir.IsDir() {
		return nil, fmt.Errorf("%s working directory unavailable", builtin.FullName(cfg.BackendID))
	}
	fp := "dsh-read-only-headless-v1:" + directoryIdentity(cfg.Cwd, dir)
	if cfg.LaunchSig != "" {
		fp += ":" + cfg.LaunchSig
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
	identity := cr.NativeIdentity{
		DriverID:          cfg.BackendID,
		Transport:         "official-headless-exec",
		DriverVersion:     fmt.Sprintf("official-headless-exec-v1:%d:%d", bin.Size(), bin.ModTime().UnixNano()),
		ResumeProtocol:    "stateless-bounded-handoff-v1",
		Executable:        cfg.Executable,
		Source:            source,
		AccountID:         accountID,
		ConfigDir:         cfg.ConfigDir,
		Cwd:               cfg.Cwd,
		ConfigGen:         1,
		ExecutableSize:    bin.Size(),
		ExecutableMtimeMS: bin.ModTime().UnixMilli(),
		LaunchFingerprint: fp,
	}
	permMode := cfg.PermissionMode
	if permMode == "" {
		permMode = defaultPermissionMode(cfg.BackendID)
	}
	cfg.PermissionMode = permMode
	env := cr.CompatibilityKey{Model: cfg.Model, PermissionMode: permMode}
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
		r = &Runtime{config: cfg, identity: identity, env: env}
		f.instances[id][key] = r
	}
	return r, nil
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
