// Package acprt connects builtin ACP CLIs (e.g. Gemini, Grok, Kimi, MiniMax) to product chat.
// Metadata registration never runs the CLI binary or probes login state.
package acprt

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

// PermissionModes 返回指定 ACP 底座支持的产品侧权限模式列表。
func PermissionModes(backendID string) []string {
	impl := builtin.Impl(backendID)
	if impl == nil || impl.Permissions == nil || len(impl.Permissions.Supported) == 0 {
		return []string{"ask"}
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
	case "ask", "manual", "":
		return "manual"
	case "acceptEdits":
		return "acceptEdits"
	case "auto":
		return "auto"
	case "bypass":
		return "bypass"
	default:
		return "manual"
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

type Factory struct {
	backendID string
	mu        sync.Mutex
	resolve   func(string) (Config, error)
	instances map[string]map[string]*Runtime
}

// New builds a managed runtime factory for a single builtin ACP backend.
func New(backendID string, resolve func(string) (Config, error)) *Factory {
	return &Factory{
		backendID: backendID,
		resolve:   resolve,
		instances: map[string]map[string]*Runtime{},
	}
}

// DefaultConfig performs metadata-only discovery using PATH and default home dirs.
func DefaultConfig(backendID, cwd string) (Config, error) {
	if !builtin.UsesAcp(backendID) {
		return Config{}, fmt.Errorf("%q is not a builtin ACP CLI", backendID)
	}
	var executable string
	if envBin := strings.TrimSpace(os.Getenv(builtin.BinEnv(backendID))); envBin != "" {
		if st, err := os.Stat(envBin); err == nil && !st.IsDir() {
			executable = envBin
		}
	}
	home, homeErr := os.UserHomeDir()
	for _, bin := range builtin.Binaries(backendID) {
		if executable != "" {
			break
		}
		if bin == "" {
			continue
		}
		if p, err := exec.LookPath(bin); err == nil {
			executable = p
			break
		}
		if homeErr == nil && home != "" {
			var candidates []string
			if runtime.GOOS == "windows" {
				localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
				if localAppData == "" {
					localAppData = filepath.Join(home, "AppData", "Local")
				}
				winDir := filepath.Join(localAppData, "agy", "bin")
				candidates = []string{
					filepath.Join(winDir, bin+".exe"),
					filepath.Join(winDir, bin+".cmd"),
					filepath.Join(winDir, bin),
				}
			} else {
				candidates = []string{filepath.Join(home, ".local", "bin", bin)}
			}
			for _, candidate := range candidates {
				st, err := os.Stat(candidate)
				if err != nil || st.IsDir() {
					continue
				}
				if runtime.GOOS != "windows" && st.Mode()&0o111 == 0 {
					continue
				}
				executable = candidate
				break
			}
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

// Target resolves the immutable native identity and compatibility key for one conversation.
func (f *Factory) Target(id string) (cr.Target, error) {
	r, err := f.runtime(id)
	if err != nil {
		return cr.Target{}, err
	}
	return r.target(), nil
}

func (f *Factory) runtime(id string) (*Runtime, error) {
	if f.resolve == nil {
		return nil, errors.New("ACP binding resolver unavailable")
	}
	cfg, err := f.resolve(id)
	if err != nil {
		return nil, err
	}
	if cfg.BackendID == "" {
		cfg.BackendID = f.backendID
	}
	if !builtin.UsesAcp(cfg.BackendID) {
		return nil, fmt.Errorf("%q is not a builtin ACP CLI", cfg.BackendID)
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
	permMode := cfg.PermissionMode
	if permMode == "" {
		permMode = defaultPermissionMode(cfg.BackendID)
	}
	cfg.PermissionMode = permMode
	identity := identityFor(cfg, bin, dir)
	env := cr.CompatibilityKey{Model: cfg.Model, PermissionMode: permMode}
	if env.Model == "" {
		env.Model = "cli-default"
	}
	key := identity.Key(env)
	f.mu.Lock()
	if f.instances[id] == nil {
		f.instances[id] = map[string]*Runtime{}
	}
	r := f.instances[id][key]
	isCached := r != nil
	if r == nil {
		r = &Runtime{config: cfg, identity: identity, env: env}
		f.instances[id][key] = r
	}
	f.mu.Unlock()
	if isCached {
		r.setEffort(cfg.Effort)
	}
	return r, nil
}

func identityFor(cfg Config, bin, dir os.FileInfo) cr.NativeIdentity {
	fp := "acp-managed-v1:" + strings.Join(builtin.AcpArgs(cfg.BackendID), ",") + ":" + directoryIdentity(cfg.Cwd, dir)
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
		Transport:         "official-acp",
		DriverVersion:     fmt.Sprintf("official-acp-adapter-v1:%d:%d", bin.Size(), bin.ModTime().UnixNano()),
		ResumeProtocol:    "acp-session-load-exact-v1",
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
	return identity
}

// Release tears down all cached native ACP runtimes owned by one conversation.
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
