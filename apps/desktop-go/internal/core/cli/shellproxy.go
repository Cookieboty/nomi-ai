package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 终端里的代理：从 Finder / Dock 启动时，Nomi 拿不到 ~/.zshrc 里 export 的 https_proxy 等变量，
// 编程助手（登录与对话）就会直连，OpenAI 等对不支持的地区回 403。读登录 shell 的 PATH 时顺带读这些
// 代理变量，只加进编程助手子进程的环境（WithCliPath），不改 Nomi 自己的进程环境，网关不受影响。
// 开关（默认打开）存在 userData/cli-network.json。

const (
	envStart = "__NOMI_ENV_START__"
	envEnd   = "__NOMI_ENV_END__"
)

// ShellProxyKeys：从登录 shell 带给编程助手的代理变量
var ShellProxyKeys = []string{
	"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
}

// proxyTriggerKeys：子进程环境里已有其中任何一个（非空）时，认为用户已自己配置，不再注入
var proxyTriggerKeys = []string{
	"http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
}

// 本机地址总是不走代理：编程助手连 Nomi 网关（127.0.0.1）不能被送进代理
var loopbackNoProxy = []string{"localhost", "127.0.0.1", "::1"}

var (
	proxyMu      sync.Mutex
	shellProxy   map[string]string
	proxyFile    string
	useProxy     = true
	proxyLoaded  bool
	proxyChanged func()
)

// ParseShellEnv：取登录 shell 输出里 envStart..envEnd 之间 `env` 的代理变量（没有 = 空 map）。
func ParseShellEnv(out string) map[string]string {
	res := map[string]string{}
	i := strings.LastIndex(out, envStart)
	if i < 0 {
		return res
	}
	rest := out[i+len(envStart):]
	if j := strings.Index(rest, envEnd); j >= 0 {
		rest = rest[:j]
	}
	want := map[string]bool{}
	for _, k := range ShellProxyKeys {
		want[k] = true
	}
	for _, line := range strings.Split(rest, "\n") {
		k, v, ok := strings.Cut(strings.TrimRight(line, "\r"), "=")
		if ok && want[k] && strings.TrimSpace(v) != "" {
			res[k] = strings.TrimSpace(v)
		}
	}
	return res
}

// ConfigureShellProxy：设置开关文件位置（userData/cli-network.json）并读入；onChanged 在开关变化后调用。
func ConfigureShellProxy(userData string, onChanged func()) {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	proxyFile = filepath.Join(userData, "cli-network.json")
	proxyChanged = onChanged
	proxyLoaded = false
	loadProxySettingLocked()
}

func loadProxySettingLocked() {
	if proxyLoaded {
		return
	}
	proxyLoaded = true
	useProxy = true
	if proxyFile == "" {
		return
	}
	b, err := os.ReadFile(proxyFile)
	if err != nil {
		return
	}
	var raw struct {
		UseShellProxy *bool `json:"useShellProxy"`
	}
	if json.Unmarshal(b, &raw) == nil && raw.UseShellProxy != nil {
		useProxy = *raw.UseShellProxy
	}
}

// UseShellProxy：开关当前值（默认 true）。
func UseShellProxy() bool {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	loadProxySettingLocked()
	return useProxy
}

// SetUseShellProxy：改开关并保存。
func SetUseShellProxy(on bool) error {
	proxyMu.Lock()
	loadProxySettingLocked()
	useProxy = on
	file, cb := proxyFile, proxyChanged
	proxyMu.Unlock()
	if file != "" {
		b, _ := json.MarshalIndent(map[string]bool{"useShellProxy": on}, "", "  ")
		if err := os.WriteFile(file, b, 0o600); err != nil {
			return err
		}
	}
	if cb != nil {
		cb()
	}
	return nil
}

// SetShellProxy：登录 shell 读到的代理变量（测试也用它注入）。
func SetShellProxy(m map[string]string) {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	shellProxy = m
}

// DetectedShellProxy：终端里配置的代理地址（https 优先；没有 = ""），给界面显示。
func DetectedShellProxy() string {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	for _, k := range []string{"https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY"} {
		if v := shellProxy[k]; v != "" {
			return redactProxy(v)
		}
	}
	return ""
}

// redactProxy：去掉代理地址里的用户名密码
func redactProxy(v string) string {
	scheme, rest, ok := strings.Cut(v, "://")
	if !ok {
		scheme, rest = "", v
	}
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		rest = rest[at+1:]
	}
	if scheme == "" {
		return rest
	}
	return scheme + "://" + rest
}

// WithShellProxy：开关打开、子进程环境里还没有代理时，加上终端里的代理变量，并保证本机地址不走代理。
// 原地修改 env 并返回它。
func WithShellProxy(env *util.Obj) *util.Obj {
	proxyMu.Lock()
	loadProxySettingLocked()
	on, m := useProxy, shellProxy
	proxyMu.Unlock()
	if !on || len(m) == 0 || env == nil {
		return env
	}
	for _, k := range proxyTriggerKeys {
		if strings.TrimSpace(envStr(env, k)) != "" {
			return env
		}
	}
	added := false
	for _, k := range ShellProxyKeys {
		if v, ok := m[k]; ok && k != "no_proxy" && k != "NO_PROXY" {
			env.Set(k, v)
			added = true
		}
	}
	if !added {
		return env
	}
	noProxy := strings.TrimSpace(envStr(env, "no_proxy"))
	if noProxy == "" {
		noProxy = strings.TrimSpace(envStr(env, "NO_PROXY"))
	}
	if noProxy == "" {
		noProxy = orDefault(m["no_proxy"], m["NO_PROXY"])
	}
	merged := mergeNoProxy(noProxy)
	env.Set("no_proxy", merged)
	env.Set("NO_PROXY", merged)
	return env
}

func mergeNoProxy(cur string) string {
	parts := []string{}
	seen := map[string]bool{}
	for _, p := range strings.FieldsFunc(cur, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
		if !seen[strings.ToLower(p)] {
			seen[strings.ToLower(p)] = true
			parts = append(parts, p)
		}
	}
	for _, h := range loopbackNoProxy {
		if !seen[h] {
			seen[h] = true
			parts = append(parts, h)
		}
	}
	return strings.Join(parts, ",")
}
