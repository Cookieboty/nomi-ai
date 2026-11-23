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

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

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
	identity := cr.NativeIdentity{DriverID: "codex", Transport: "official-app-server", DriverVersion: "official-app-server-adapter-v1", ResumeProtocol: "thread-resume-exact-id-v1", Executable: cfg.Executable, Source: "official-default-login-unverified", AccountID: "config-source:" + cfg.ConfigDir, ConfigDir: cfg.ConfigDir, Cwd: cfg.Cwd, ConfigGen: 1, ExecutableSize: bin.Size(), ExecutableMtimeMS: bin.ModTime().UnixMilli(), LaunchFingerprint: "read-only-never-approve-v1:" + directoryIdentity(cfg.Cwd, dir)}
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
