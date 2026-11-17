package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/utils"
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

func Launchers() map[string]LauncherSettings {
	out := map[string]LauncherSettings{}
	for _, kind := range builtin.IDs {
		if builtin.WithAccounts(kind) {
			out[kind] = LauncherFor(kind)
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

// TestLauncherVersion probes the full launch chain, not the wrapper's own
// version. Return only a version number, never arbitrary stdout or credentials.
func TestLauncherVersion(kind, command string) (string, error) {
	if !builtin.WithAccounts(kind) {
		return "", errors.New(i18n.T("electron.common.cli-launcher-invalid"))
	}
	if strings.TrimSpace(command) == "" {
		command = ResolveCliBinCached(kind)
		if command != "" {
			command = "\"" + command + "\""
		}
	}
	cmd, prefix, err := ParseLauncherCommand(command)
	if err != nil {
		return "", err
	}
	version := offThread(func() string {
		env, _ := ScrubSecretEnv(WithCliPath(nil), nil)
		env.Set("NO_COLOR", "1")
		if strings.HasSuffix(cmd, ".js") || strings.HasSuffix(cmd, ".mjs") {
			prefix = append([]string{cmd}, prefix...)
			cmd = ResolveNodeBin()
		}
		out, runErr := execText(cmd, append(prefix, "--version"), env, 8000, isCmdBat(cmd))
		if runErr != nil {
			return ""
		}
		return semverOnlyRe.FindString(out)
	})
	if version == "" {
		return "", errors.New(i18n.T("electron.common.cli-launcher-test-failed"))
	}
	return version, nil
}
