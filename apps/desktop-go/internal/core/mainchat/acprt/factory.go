// Package acprt connects builtin ACP CLIs (e.g. Gemini, Grok, Kimi, MiniMax) to product chat.
// Metadata registration never runs the CLI binary or probes login state.
package acprt

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	identity := identityFor(cfg, bin, dir)
	env := cr.CompatibilityKey{Model: cfg.Model, PermissionMode: "ask"}
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

func identityFor(cfg Config, bin, dir os.FileInfo) cr.NativeIdentity {
	fp := "acp-managed-v1:" + strings.Join(builtin.AcpArgs(cfg.BackendID), ",") + ":" + directoryIdentity(cfg.Cwd, dir)
	identity := cr.NativeIdentity{
		DriverID:          cfg.BackendID,
		Transport:         "official-acp",
		DriverVersion:     fmt.Sprintf("official-acp-adapter-v1:%d:%d", bin.Size(), bin.ModTime().UnixNano()),
		ResumeProtocol:    "acp-session-load-exact-v1",
		Executable:        cfg.Executable,
		Source:            "official-default-login-unverified",
		AccountID:         "config-source:" + cfg.ConfigDir,
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
	}
}
