package cli

// model_discovery.go mirrors packages/core/src/cli/modelDiscovery.ts：从各 CLI 自己读取模型目录。
// 所有函数持 jsrt 锁调用（与 Node 单线程一致）。

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	claudep "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	codexp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	grokp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodepath"
)

// ModelDiscoveryTimeoutMs = MODEL_DISCOVERY_TIMEOUT_MS。
const ModelDiscoveryTimeoutMs = 30_000

// ClaudeDefaults = ModelDiscoveryDeps.claudeDefaults（nil 字段 = undefined）。
type ClaudeDefaults struct {
	EffortEnv    *string
	SettingsPath *string
}

// ModelDiscoveryDeps mirrors ModelDiscoveryDeps。Spawn 返回 nil = 找不到 CLI。
type ModelDiscoveryDeps struct {
	Spawn                 func(backend string, args []string) clisdk.ChildLike
	ClaudeDefaults        *ClaudeDefaults
	CodexConfigPath       string
	GrokModelsCachePath   string // "" = undefined
	GrokSettingsCachePath string // "" = undefined
	TimeoutMs             *int
}

// DiscoverModels mirrors discoverModels。
func DiscoverModels(backend string, deps ModelDiscoveryDeps) *jsrt.Promise[*util.Obj] {
	timeoutMs := ModelDiscoveryTimeoutMs
	if deps.TimeoutMs != nil {
		timeoutMs = *deps.TimeoutMs
	}
	switch backend {
	case "claude":
		return discoverClaude(deps, timeoutMs)
	case "codex":
		return discoverCodex(deps, timeoutMs)
	case "grok":
		return discoverGrok(deps, timeoutMs)
	}
	return jsrt.Rejected[*util.Obj](fmt.Errorf("no model discovery for %s", backend))
}

func mdSpawn(deps ModelDiscoveryDeps, backend string, args []string) (clisdk.ChildLike, error) {
	child := deps.Spawn(backend, args)
	if child == nil {
		return nil, fmt.Errorf("%s CLI not found", backend)
	}
	return child, nil
}

func mdStderrTail(child clisdk.ChildLike) func() string {
	tail := ""
	child.OnStderr(func(c string) { tail = clisdk.SliceFrom(tail+c, -600) })
	return func() string {
		lines := strings.Split(util.JSTrim(tail), "\n")
		if len(lines) > 3 {
			lines = lines[len(lines)-3:]
		}
		return util.JSTrim(strings.Join(lines, " "))
	}
}

func withTimeout(child clisdk.ChildLike, timeoutMs int, run func(done func(*util.Obj), fail func(error))) *jsrt.Promise[*util.Obj] {
	p := jsrt.NewPromise[*util.Obj]()
	settled := false
	var timer *jsrt.Timer
	finish := func(fn func()) {
		if settled {
			return
		}
		settled = true
		jsrt.ClearTimeout(timer)
		func() {
			defer func() { _ = recover() }()
			child.Kill("")
		}()
		fn()
	}
	timer = jsrt.SetTimeout(time.Duration(timeoutMs)*time.Millisecond, func() {
		finish(func() { p.Reject(fmt.Errorf("timed out after %dms", timeoutMs)) })
	})
	child.OnError(func(e error) { finish(func() { p.Reject(e) }) })
	run(func(v *util.Obj) { finish(func() { p.Resolve(v) }) }, func(e error) { finish(func() { p.Reject(e) }) })
	return p
}

func exitStr(code *int) string {
	if code == nil {
		return "null"
	}
	return fmt.Sprint(*code)
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func discoverClaude(deps ModelDiscoveryDeps, timeoutMs int) *jsrt.Promise[*util.Obj] {
	child, err := mdSpawn(deps, "claude", []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"})
	if err != nil {
		return jsrt.Rejected[*util.Obj](err)
	}
	stderr := mdStderrTail(child)
	const requestId = "nomi-models"
	return withTimeout(child, timeoutMs, func(done func(*util.Obj), fail func(error)) {
		buf := ""
		child.OnStdout(func(c string) {
			buf += c
			lines := strings.Split(buf, "\n")
			buf = lines[len(lines)-1]
			for _, line := range lines[:len(lines)-1] {
				v, err := util.ParseString(line)
				if err != nil {
					continue
				}
				j := sh.AsObj(v)
				if j.Get("type") != "control_response" {
					continue
				}
				r := sh.AsObj(j.Get("response"))
				if r.Get("request_id") != requestId {
					continue
				}
				if r.Get("subtype") == "error" {
					msg := "initialize failed"
					if e := r.Get("error"); !sh.IsUndef(e) {
						msg = util.JSString(e)
					}
					fail(errors.New(msg))
					return
				}
				var eff any
				if s, ok := ClaudeConfiguredEffort(deps); ok {
					eff = s
				}
				done(claudep.ParseModels(r.Get("response"), eff))
				return
			}
		})
		child.OnClose(func(code *int, _ string) {
			fail(errors.New(orStr(stderr(), "claude exited ("+exitStr(code)+")")))
		})
		child.Stdin().Write(util.Stringify(util.NewObj("type", "control_request", "request_id", requestId, "request", util.NewObj("subtype", "initialize"))) + "\n")
	})
}

// ClaudeConfiguredEffort mirrors claudeConfiguredEffort（ok=false = null）。
func ClaudeConfiguredEffort(deps ModelDiscoveryDeps) (string, bool) {
	cd := deps.ClaudeDefaults
	if cd != nil && cd.EffortEnv != nil {
		if s := util.JSTrim(*cd.EffortEnv); s != "" && s != "auto" {
			return s, true
		}
	}
	if cd == nil || cd.SettingsPath == nil || *cd.SettingsPath == "" {
		return "", false
	}
	b, err := os.ReadFile(*cd.SettingsPath)
	if err != nil {
		return "", false
	}
	return claudep.ReadEffortSetting(string(b))
}

func discoverCodex(deps ModelDiscoveryDeps, timeoutMs int) *jsrt.Promise[*util.Obj] {
	child, err := mdSpawn(deps, "codex", []string{"debug", "models"})
	if err != nil {
		return jsrt.Rejected[*util.Obj](err)
	}
	child.Stdin().End()
	stderr := mdStderrTail(child)
	return withTimeout(child, timeoutMs, func(done func(*util.Obj), fail func(error)) {
		out := ""
		child.OnStdout(func(c string) { out += c })
		child.OnClose(func(code *int, _ string) {
			if code == nil || *code != 0 {
				fail(errors.New(orStr(stderr(), "codex exited ("+exitStr(code)+")")))
				return
			}
			json, err := util.ParseString(out)
			if err != nil {
				fail(errors.New("codex debug models: invalid JSON"))
				return
			}
			var model, effort any
			if b, err := os.ReadFile(deps.CodexConfigPath); err == nil {
				m, e := codexp.ReadConfigDefaults(string(b))
				if m != "" {
					model = m
				}
				if e != "" {
					effort = e
				}
			}
			done(codexp.ParseModels(json, model, effort))
		})
	})
}

func discoverGrok(deps ModelDiscoveryDeps, timeoutMs int) *jsrt.Promise[*util.Obj] {
	// spawnOrThrow 在 .catch 之前同步抛出：找不到 CLI 时不走缓存兜底。
	child, err := mdSpawn(deps, "grok", []string{"agent", "stdio"})
	if err != nil {
		return jsrt.Rejected[*util.Obj](err)
	}
	inner := func() *jsrt.Promise[*util.Obj] {
		stderr := mdStderrTail(child)
		return withTimeout(child, timeoutMs, func(done func(*util.Obj), fail func(error)) {
			conn := gemini.NewAcpConnection(child, rpc.Handlers{
				OnNotification: func(string, rpc.Json) {},
				OnRequest: func(string, rpc.Json) *jsrt.Promise[any] {
					return jsrt.Rejected[any](errors.New("not supported"))
				},
			})
			opts := rpc.RequestOptions{TimeoutMs: &timeoutMs}
			jsrt.Async(func() (struct{}, error) {
				res, err := func() (*util.Obj, error) {
					if _, err := jsrt.Await(conn.Request("initialize", util.NewObj("protocolVersion", float64(1), "clientCapabilities", util.NewObj()), opts)); err != nil {
						return nil, err
					}
					sv, err := jsrt.Await(conn.Request("session/new", util.NewObj("cwd", nodepath.Tmpdir(), "mcpServers", []any{}), opts))
					if err != nil {
						return nil, err
					}
					session := sh.AsObj(sv)
					acp := grokp.ParseModels(session)
					catalog := acp
					if cache := readGrokCache(deps); cache != nil {
						acpModels, _ := acp.Get("models").([]any)
						merged := append([]any{}, acpModels...)
						cacheModels, _ := cache.Get("models").([]any)
						for _, m := range cacheModels {
							dup := false
							for _, ex := range acpModels {
								if sh.AsObj(ex).Get("id") == sh.AsObj(m).Get("id") {
									dup = true
									break
								}
							}
							if !dup {
								merged = append(merged, m)
							}
						}
						def := acp.Get("defaultModel")
						if def == nil {
							def = cache.Get("defaultModel")
						}
						catalog = acp.Clone().Set("models", merged).Set("defaultModel", def)
					}
					if sid, ok := session.Get("sessionId").(string); ok && sid != "" {
						t := 3_000
						_, _ = jsrt.Await(conn.Request("session/close", util.NewObj("sessionId", sid), rpc.RequestOptions{TimeoutMs: &t}))
					}
					return catalog, nil
				}()
				if err != nil {
					if reason := stderr(); reason != "" {
						fail(errors.New(reason))
					} else {
						fail(err)
					}
					return struct{}{}, nil
				}
				done(res)
				return struct{}{}, nil
			})
		})
	}
	src := inner()
	out := jsrt.NewPromise[*util.Obj]()
	go func() {
		v, err := jsrt.Block(src)
		jsrt.Run(func() {
			if err == nil {
				out.Resolve(v)
			} else if c := readGrokCache(deps); c != nil {
				out.Resolve(c)
			} else {
				out.Reject(err)
			}
		})
	}()
	return out
}

func mdReadJSON(file string) (any, bool) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, false
	}
	v, err := util.ParseString(string(b))
	return v, err == nil
}

// readGrokCache mirrors readGrokCache（nil = null）。
func readGrokCache(deps ModelDiscoveryDeps) *util.Obj {
	if deps.GrokModelsCachePath == "" {
		return nil
	}
	raw, ok := mdReadJSON(deps.GrokModelsCachePath)
	if !ok {
		return nil
	}
	catalog := grokp.ParseModels(raw)
	models, _ := catalog.Get("models").([]any)
	if deps.GrokSettingsCachePath != "" {
		if sv, ok := mdReadJSON(deps.GrokSettingsCachePath); ok && sh.AsObj(sv) != nil {
			payload := sh.AsObj(sv).Get("payload")
			good := true
			if s, isStr := payload.(string); isStr {
				payload, good = nil, false
				if pv, err := util.ParseString(s); err == nil {
					payload, good = pv, true
				}
			}
			if good {
				var dm any
				if po, isObj := payload.(*util.Obj); isObj {
					dm = po.Get("default_model")
					if dm == nil {
						dm = sh.AsObj(po.Get("settings")).Get("default_model")
					}
				}
				if s, isStr := dm.(string); isStr {
					for _, m := range models {
						if sh.AsObj(m).Get("id") == s {
							return catalog.Clone().Set("defaultModel", m)
						}
					}
				}
			}
		}
	}
	if len(models) == 0 {
		return nil
	}
	return catalog
}
