package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// LauncherSettings applies to a CLI's official source, not the model gateway.
type LauncherSettings struct {
	Enabled       bool   `json:"enabled"`
	Command       string `json:"command"`
	AccountSource string `json:"accountSource"`
}

var launchers struct {
	sync.RWMutex
	file  string
	items map[string]LauncherSettings
}

type launcherStore struct {
	Version   int                         `json:"version"`
	Launchers map[string]LauncherSettings `json:"launchers"`
}

func ConfigureLaunchers(userData string) {
	launchers.Lock()
	defer launchers.Unlock()
	launchers.file = ""
	launchers.items = map[string]LauncherSettings{}
	if userData == "" {
		return
	}
	launchers.file = filepath.Join(userData, "cli-launcher.json")
	if b, err := os.ReadFile(launchers.file); err == nil {
		var saved launcherStore
		if json.Unmarshal(b, &saved) != nil {
			return
		}
		if saved.Launchers != nil {
			for kind, s := range saved.Launchers {
				if builtin.WithAccounts(kind) && validLauncher(s) == nil {
					launchers.items[kind] = s
				}
			}
		} else {
			// Read the initial Claude-only preview format without changing its login choice.
			var old struct {
				Enabled     bool
				Command     string
				ManageLogin bool
			}
			if json.Unmarshal(b, &old) == nil {
				s := LauncherSettings{Enabled: old.Enabled, Command: old.Command, AccountSource: "nomi"}
				if old.Enabled && old.ManageLogin {
					s.AccountSource = "local"
				}
				if validLauncher(s) == nil {
					launchers.items["claude"] = s
				}
			}
		}
	}
}

func LauncherFor(kind string) LauncherSettings {
	launchers.RLock()
	defer launchers.RUnlock()
	if s, ok := launchers.items[kind]; ok {
		return s
	}
	return LauncherSettings{AccountSource: "nomi"}
}

// LauncherView 暴露给契约与设置界面的视图快照（含本机默认目录登录探测，不落盘）。
type LauncherView struct {
	LauncherSettings
	HasLocalLogin bool `json:"hasLocalLogin"`
}

func LauncherViewFor(kind string) LauncherView {
	return LauncherView{
		LauncherSettings: LauncherFor(kind),
		HasLocalLogin:    HasLocalLogin(kind, ""),
	}
}

func Launchers() map[string]LauncherSettings {
	out := map[string]LauncherSettings{}
	for _, kind := range builtin.IDs {
		if builtin.WithAccounts(kind) {
			out[kind] = LauncherFor(kind)
		}
	}
	return out
}

func LaunchersView() map[string]LauncherView {
	out := map[string]LauncherView{}
	for _, kind := range builtin.IDs {
		if builtin.WithAccounts(kind) {
			out[kind] = LauncherViewFor(kind)
		}
	}
	return out
}

func LauncherManagesLogin(kind string) bool {
	return builtin.WithAccounts(kind) && LauncherFor(kind).AccountSource == "local"
}

func validLauncher(s LauncherSettings) error {
	if s.AccountSource != "local" && s.AccountSource != "nomi" {
		return errors.New(i18n.T("electron.common.cli-launcher-invalid"))
	}
	if s.Enabled || s.Command != "" {
		if _, _, err := ParseLauncherCommand(s.Command); err != nil {
			return err
		}
	}
	return nil
}

func SaveLauncher(kind string, s LauncherSettings) error {
	if !builtin.WithAccounts(kind) {
		return errors.New(i18n.T("electron.common.cli-launcher-invalid"))
	}
	if s.AccountSource == "" {
		if prev := LauncherFor(kind).AccountSource; prev == "local" || prev == "nomi" {
			s.AccountSource = prev
		} else {
			s.AccountSource = "nomi"
		}
	}
	s.Command = strings.TrimSpace(s.Command)
	if err := validLauncher(s); err != nil {
		return err
	}
	launchers.Lock()
	defer launchers.Unlock()
	next := map[string]LauncherSettings{}
	for k, v := range launchers.items {
		next[k] = v
	}
	next[kind] = s
	if launchers.file != "" {
		b, err := json.MarshalIndent(launcherStore{Version: 1, Launchers: next}, "", "  ")
		if err != nil {
			return err
		}
		if err := utils.WritePrivateFileAtomicNode(launchers.file, append(b, '\n')); err != nil {
			return err
		}
	}
	launchers.items = next
	return nil
}

// ParseLauncherCommand does not invoke a shell or expand variables. Windows
// path backslashes survive; quotes allow spaces in the executable or arguments.
func ParseLauncherCommand(command string) (string, []string, error) {
	bad := func() (string, []string, error) {
		return "", nil, errors.New(i18n.T("electron.common.cli-launcher-invalid"))
	}
	if len(command) > 8192 || strings.ContainsAny(command, "\x00\r\n") {
		return bad()
	}
	var parts []string
	var word strings.Builder
	var quote rune
	started := false
	runes := []rune(command)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		if quote != 0 {
			if c == quote {
				quote = 0
				continue
			}
			if c == '\\' && quote == '"' {
				j := i
				for j < len(runes) && runes[j] == '\\' {
					j++
				}
				if j < len(runes) && runes[j] == '"' {
					word.WriteString(strings.Repeat("\\", (j-i)/2))
					if (j-i)%2 == 1 {
						word.WriteRune('"')
					} else {
						quote = 0
					}
					i = j
					continue
				}
			}
			word.WriteRune(c)
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			started = true
			continue
		}
		if unicode.IsSpace(c) {
			if started {
				parts = append(parts, word.String())
				word.Reset()
				started = false
			}
			continue
		}
		if strings.ContainsRune("|&;<>()`", c) {
			return bad()
		}
		word.WriteRune(c)
		started = true
	}
	if quote != 0 {
		return bad()
	}
	if started {
		parts = append(parts, word.String())
	}
	if len(parts) == 0 || parts[0] == "" || strings.Contains(parts[0], "=") {
		return bad()
	}
	return parts[0], parts[1:], nil
}

// ResolveExecutable resolves either an explicit executable path or a bare command name on PATH.
func ResolveExecutable(cmd string, env *util.Obj, platform string) string {
	if cmd == "" {
		return ""
	}
	if platform == "" {
		platform = usage.Platform()
	}
	if filepath.IsAbs(cmd) || strings.ContainsAny(cmd, `/\`) {
		found := WindowsExecutable(cmd, platform, nil)
		if st, err := os.Stat(found); err == nil && !st.IsDir() {
			return found
		}
		return ""
	}
	return FindOnPath(cmd, env, platform, nil)
}

// ResolveLauncherBin returns the resolved binary path when a custom launcher is enabled for kind.
func ResolveLauncherBin(kind string) string {
	if !builtin.WithAccounts(kind) {
		return ""
	}
	s := LauncherFor(kind)
	if !s.Enabled || strings.TrimSpace(s.Command) == "" {
		return ""
	}
	cmd, _, err := ParseLauncherCommand(s.Command)
	if err != nil {
		return ""
	}
	return ResolveExecutable(cmd, WithCliPath(nil), usage.Platform())
}

// LauncherInvocation keeps all Nomi protocol arguments after the user prefix.
func LauncherInvocation(kind, bin string, args []string, official bool) (string, []string, error) {
	s := LauncherFor(kind)
	if !official || !s.Enabled {
		return bin, args, nil
	}
	cmd, prefix, err := ParseLauncherCommand(s.Command)
	if err != nil {
		return "", nil, err
	}
	return cmd, append(prefix, args...), nil
}

// LauncherProbeInvocation shares chat's executable prefix with auth and quota probes.
// The launcher prefix is resolved like chat (ResolveHarnessLaunch): a bare name
// such as "reclaude" becomes the found PATH entry ("reclaude.cmd" on Windows,
// honoring PATHEXT) so probes can spawn what fd.Options would run.
func LauncherProbeInvocation(kind, bin string, args []string) (string, []string, error) {
	return launcherProbeInvocation(kind, bin, args, usage.Platform(), usage.ProcessEnv(), nil)
}

// launcherProbeInvocation is the testable form of LauncherProbeInvocation.
func launcherProbeInvocation(kind, bin string, args []string, platform string, env *util.Obj, exists func(string) bool) (string, []string, error) {
	cmd, argv, err := LauncherInvocation(kind, bin, args, true)
	if err != nil {
		return "", nil, err
	}
	// Same order as ResolveHarnessLaunch (chat): PATH lookup for bare names, then
	// Windows extension filling; explicit paths only get the extension filled.
	if !strings.ContainsAny(cmd, `/\`) {
		if resolved := FindOnPath(cmd, env, platform, exists); resolved != "" {
			cmd = resolved
		} else {
			cmd = WindowsExecutable(cmd, platform, exists)
		}
	} else {
		cmd = WindowsExecutable(cmd, platform, exists)
	}
	if ext := strings.ToLower(filepath.Ext(cmd)); ext == ".js" || ext == ".mjs" {
		argv = append([]string{cmd}, argv...)
		cmd = ResolveNodeBin()
	}
	return cmd, argv, nil
}

// TestLauncherVersion probes the full launch chain, not the wrapper's own
// version. Return only a version number, never arbitrary stdout or credentials.
// Spawns via ResolveCliLaunch / nodeproc.RunSync so no shell is invoked outside safe Windows .cmd shims.
func TestLauncherVersion(kind, command string) (string, error) {
	if !builtin.WithAccounts(kind) {
		return "", errors.New(i18n.T("electron.common.cli-launcher-invalid"))
	}
	var cmd string
	var prefix []string
	if strings.TrimSpace(command) == "" {
		cmd = ResolveCliBinCached(kind)
		if cmd == "" {
			return "", errors.New(i18n.T("electron.common.cli-launcher-test-failed"))
		}
	} else {
		var err error
		cmd, prefix, err = ParseLauncherCommand(command)
		if err != nil {
			return "", err
		}
	}
	probe := func() string {
		env, _ := ScrubSecretEnv(WithCliPath(nil), nil)
		env.Set("NO_COLOR", "1")
		platform := usage.Platform()
		resolved := ResolveExecutable(cmd, env, platform)
		if resolved == "" {
			return ""
		}
		args := append(append([]string(nil), prefix...), "--version")
		lower := strings.ToLower(resolved)
		if strings.HasSuffix(lower, ".js") || strings.HasSuffix(lower, ".mjs") {
			node := ResolveNodeBin()
			if node == "" {
				return ""
			}
			out, runErr := nodeproc.RunSync(node, append([]string{resolved}, args...), nodeproc.Options{Env: usage.EnvSlice(env), IgnoreStdin: true}, 8*time.Second)
			if runErr != nil {
				return ""
			}
			return semverOnlyRe.FindString(nodeproc.DecodeChunk(out))
		}
		launch := usage.ResolveCliLaunch(resolved, args, env, platform, usage.UnwrapCmdDeps{})
		if launch == nil {
			return ""
		}
		file, runEnv := launch.File, env
		if launch.Via == usage.ViaNodeScript {
			runEnv = WithCliPath(env)
			if !filepath.IsAbs(file) {
				if n := ResolveNodeBin(); n != "" {
					file = n
				}
			}
		}
		out, runErr := nodeproc.RunSync(file, launch.Args, nodeproc.Options{
			Env:         usage.EnvSlice(runEnv),
			Verbatim:    launch.Via == usage.ViaCmdShim,
			IgnoreStdin: true,
		}, 8*time.Second)
		if runErr != nil {
			return ""
		}
		return semverOnlyRe.FindString(nodeproc.DecodeChunk(out))
	}
	version := probe()
	if version == "" {
		return "", errors.New(i18n.T("electron.common.cli-launcher-test-failed"))
	}
	return version, nil
}

// HasLocalLogin reports whether the CLI's default user home has an existing
// local login or custom launcher enabled. Only performs fast filesystem checks.
func HasLocalLogin(kind, home string) bool {
	if !builtin.WithAccounts(kind) {
		return false
	}
	if LauncherFor(kind).Enabled {
		return true
	}
	var env *util.Obj
	if home == "" {
		home = usage.Homedir()
		env = usage.ProcessEnv()
	} else {
		env = util.NewObj()
	}
	switch kind {
	case "claude":
		dir := usage.ClaudeConfigDir(home, env)
		if usage.ExistsSync(filepath.Join(dir, ".credentials.json")) {
			return true
		}
		for _, candidate := range []string{filepath.Join(dir, ".claude.json"), filepath.Join(home, ".claude.json")} {
			if hasClaudeOAuthAccount(candidate) {
				return true
			}
		}
		return false
	case "codex":
		dir := usage.CodexHomeDir(home, env)
		return usage.ExistsSync(filepath.Join(dir, "auth.json"))
	case "grok":
		if usage.HasGrokLocalPresence(home, env) {
			return true
		}
		return usage.ExistsSync(filepath.Join(usage.GrokHomeDir(home, env), "auth.json"))
	default:
		impl := builtin.Impl(kind)
		if impl == nil || impl.Accounts == nil || impl.Accounts.UserHome == nil || impl.Accounts.SignedIn == nil {
			return false
		}
		envMap := map[string]string{}
		for _, k := range env.Keys() {
			if s, ok := env.Get(k).(string); ok {
				envMap[k] = s
			}
		}
		root := impl.Accounts.UserHome(envMap, home)
		return root != "" && impl.Accounts.SignedIn(root)
	}
}

func hasClaudeOAuthAccount(path string) bool {
	b, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var doc struct {
		OAuthAccount json.RawMessage `json:"oauthAccount"`
	}
	if json.Unmarshal(b, &doc) != nil {
		return false
	}
	trimmed := strings.TrimSpace(string(doc.OAuthAccount))
	return trimmed != "" && trimmed != "null" && trimmed != "{}"
}
