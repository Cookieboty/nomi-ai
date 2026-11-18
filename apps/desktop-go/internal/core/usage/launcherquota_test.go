package usage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

const launcherAuthJSON = `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"launcher-test@example.invalid"}`

func TestLauncherAuthHelperProcess(t *testing.T) {
	if os.Getenv("NOMI_TEST_LAUNCHER_AUTH") != "1" {
		return
	}
	args := os.Args
	if len(args) < 3 || !reflect.DeepEqual(args[len(args)-3:], []string{"cli", "auth", "status"}) {
		os.Exit(2)
	}
	fmt.Print(launcherAuthJSON)
	fmt.Fprintln(os.Stderr, "launcher diagnostic notice")
	os.Exit(0)
}

func TestLauncherAuthStatusUsesFullPrefix(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	env := ProcessEnv()
	env.Set("NOMI_TEST_LAUNCHER_AUTH", "1")
	jsrt.Run(func() {
		text, ok := runStatus("claude", env, func(kind, _ string, args []string) (string, []string, error) {
			if kind != "claude" || !reflect.DeepEqual(args, []string{"auth", "status"}) {
				t.Fatal("incorrect status request", kind, args)
			}
			return executable, append([]string{"-test.run=^TestLauncherAuthHelperProcess$", "--", "cli"}, args...), nil
		})
		if !ok || ParseClaudeAuthStatus(text) != AuthSubscription {
			t.Fatal("wrapper login was not detected")
		}
	})
}

func TestLauncherPassiveAuthKeepsWrapperIdentity(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"oauthAccount":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		detector := NewAuthModeDetector(AuthDeps{Home: home, Env: util.NewObj(),
			PreferCli: func(string) bool { return true }, Run: func(string) (string, bool) { return launcherAuthJSON, true }})
		if info, err := jsrt.Await(detector.DetectFull("claude")); err != nil || info.Mode != AuthSubscription {
			t.Fatal("wrapper subscription not detected", err)
		}
		if info := detector.DetectPassive("claude"); info.Mode != AuthSubscription || info.SignedOut {
			t.Fatal("native signed-out configuration erased the wrapper login")
		}
	})
}

func TestLauncherQuotaRefreshUsesSameAccountAndCommand(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	local := filepath.Join(home, "wrapper-config")
	zero := float64(0)
	for _, unsupported := range []bool{false, true} {
		t.Run(fmt.Sprint(unsupported), func(t *testing.T) {
			var s *UsageService
			calls := 0
			jsrt.Run(func() {
				s = NewUsageService(ServiceDeps{
					Root: filepath.Join(root, fmt.Sprint(unsupported)), Home: &home, Logger: nopLogger{}, ScanMs: &zero,
					Env:             util.NewObj("CLAUDE_CONFIG_DIR", local, "ANTHROPIC_API_KEY", "test-only-native-api-flag"),
					OfficialAccount: func(string, bool) (*OfficialAccount, error) { return nil, nil },
					AccountEnv: func(string, *util.Obj, *string) *util.Obj {
						t.Fatal("Nomi account home was injected into local login")
						return nil
					},
					PreferCliAuth: func(string) bool { return true },
					AuthRun:       func(string) (string, bool) { return launcherAuthJSON, true },
					CliInvocation: func(kind, _ string, args []string) (string, []string, error) {
						if kind != "claude" {
							t.Fatal("wrong quota backend")
						}
						return "wrapper.exe", append([]string{"cli"}, args...), nil
					},
					ClaudeUsage: &ClaudeFetcherDeps{
						ResolveBin: func() (string, bool) { return "native-claude.exe", true },
						Run: func(command string, args []string, options RunOptions) *jsrt.Promise[RunResult] {
							calls++
							if command != "wrapper.exe" || !reflect.DeepEqual(args, append([]string{"cli"}, ClaudeUsageArgs...)) || options.Env.Get("CLAUDE_CONFIG_DIR") != local {
								t.Fatal("quota did not use the configured launcher and local environment", command, args)
							}
							code := 0
							response := `{"local_command":"usage","num_turns":0,"result":"Current session: 12% used\nCurrent week (all models): 34% used"}`
							if unsupported {
								response = `{"num_turns":0,"result":"not available in non-interactive mode"}`
							}
							return jsrt.Resolved(RunResult{Code: &code, Stdout: response})
						},
					},
				})
				result := s.refreshClaude(true)
				if calls != 1 || result == nil {
					t.Fatal("quota query was skipped", calls)
				}
				reading := s.claudeCache.Get()
				if unsupported {
					if reading != nil || result.Reason != "unsupported" {
						t.Fatal("unsupported output became quota", result)
					}
				} else if reading == nil || len(reading.Windows) != 2 || reading.Windows[1].UsedPercent != 34 {
					t.Fatal("successful quota was not surfaced", result)
				}
			})
			t.Cleanup(func() { jsrt.Run(s.Stop) })
		})
	}
}

func TestLauncherCodexQuotaKeepsRPCArguments(t *testing.T) {
	jsrt.Run(func() {
		called := false
		reader := NewCodexRateLimitReader(CodexRPCDeps{
			ResolveBin: func() (string, bool) { return "native-codex", true }, Env: func() *util.Obj { return util.NewObj() },
			Invocation: func(kind, _ string, args []string) (string, []string, error) {
				if kind != "codex" {
					return "", nil, errors.New("wrong backend")
				}
				return "wrapper", append([]string{"codex"}, args...), nil
			},
			SpawnFn: func(command string, args []string, _ nodeproc.Options) *nodeproc.Child {
				called = true
				if command != "wrapper" || !reflect.DeepEqual(args, append([]string{"codex"}, CodexAppServerArgs...)) {
					t.Fatal("RPC arguments were not preserved")
				}
				return nil // No external process or model request is needed for this regression.
			},
		})
		reader.fetch()
		if !called {
			t.Fatal("quota bypassed the configured invocation")
		}
	})
}
