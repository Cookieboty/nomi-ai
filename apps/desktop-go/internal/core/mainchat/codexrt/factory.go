// Package codexrt connects the official Codex app-server driver to product chat.
// No credential files, gateway provider or harness tab are involved.
package codexrt

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

// PermissionModes 返回 Codex 底座支持的产品侧权限档位列表。
func PermissionModes() []string {
	supported := codex.Permissions.Supported
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

// OfficialMissingThread is the exact JSON-RPC error.message observed in the
// in-repo official Codex app-server driver fixtures and child-resume path
// (internal/clisdk/drivers/appserver_children.go and its tests). It is not a
// live-CLI survey. Any other resume/error surface is treated as RecoveryUnknown.
const OfficialMissingThread = "thread not found"

// OfficialAppServerArgs are the restricted official flags already used by the
// in-repo account/quota app-server probe. Combined with OfficialLaunch they
// keep sandbox read-only, never auto-approve, and disable analytics.
var OfficialAppServerArgs = []string{"-s", "read-only", "-a", "never", "-c", "analytics.enabled=false", "app-server"}

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
	executable, err := exec.LookPath("codex")
	if err != nil {
		return Config{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	config := os.Getenv("CODEX_HOME")
	if config == "" {
		config = filepath.Join(home, ".codex")
	}
	return Config{Executable: executable, Cwd: cwd, ConfigDir: config}, nil
}

// Target resolves the immutable binding for one conversation. A different
// executable, account/config source or physical project directory is a NEW
// compatibility key; it never reuses or overwrites the old native identity.
func (f *Factory) Target(id string) (cr.Target, error) {
	r, err := f.runtime(id)
	if err != nil {
		return cr.Target{}, err
	}
	return r.target(), nil
}

func (f *Factory) runtime(id string) (*Runtime, error) {
	if f.resolve == nil {
		return nil, errors.New("Codex binding resolver unavailable")
	}
	cfg, err := f.resolve(id)
	if err != nil {
		return nil, err
	}
	for _, s := range []string{cfg.Executable, cfg.Cwd, cfg.ConfigDir} {
		if !filepath.IsAbs(s) {
			return nil, errors.New("Codex binding paths must be absolute")
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
		return nil, errors.New("Codex working directory unavailable")
	}
	identity := identityFor(cfg, bin, dir)
	env := cr.CompatibilityKey{Model: cfg.Model, PermissionMode: effectivePermissionMode(cfg.PermissionMode)}
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
	fp := "read-only-never-approve-v1:" + directoryIdentity(cfg.Cwd, dir)
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
	identity := cr.NativeIdentity{DriverID: "codex", Transport: "official-app-server", DriverVersion: "official-app-server-adapter-v1", ResumeProtocol: "thread-resume-exact-id-v1", Executable: cfg.Executable, Source: source, AccountID: accountID, ConfigDir: cfg.ConfigDir, Cwd: cfg.Cwd, ConfigGen: 1, ExecutableSize: bin.Size(), ExecutableMtimeMS: bin.ModTime().UnixMilli(), LaunchFingerprint: fp}
	// Executable replacement is a different compatibility key, never a native-ID overwrite.
	identity.DriverVersion += fmt.Sprintf(":%d:%d", bin.Size(), bin.ModTime().UnixNano())
	return identity
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

// officialMissingThread is true ONLY for the exact official JSON-RPC message.
// rpc.Error.Error() already returns Msg, so the deepest nested message is what
// the official server said; anything else (empty result, other text, timeout,
// process exit) is NOT proof of a missing session.
func officialMissingThread(err error) bool {
	if err == nil {
		return false
	}
	var rpcErr *rpc.Error
	if errors.As(err, &rpcErr) {
		return rpc.InnermostMessage(rpcErr.Msg) == OfficialMissingThread
	}
	return rpc.InnermostMessage(err.Error()) == OfficialMissingThread
}
