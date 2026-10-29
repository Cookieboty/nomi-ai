package mcp

import (
	"os"
	"runtime"
	"strings"
)

// getEnvironment（mcp-stdio/get-environment.ts）：custom env + 少量白名单继承变量。
// 返回有序 [key, value]（JS 对象插入顺序）。
func getEnvironment(custom [][2]string, isWindows bool, lookup func(string) (string, bool)) [][2]string {
	var defaults []string
	if isWindows {
		defaults = []string{"APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE",
			"SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE"}
	} else {
		defaults = []string{"HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"}
	}
	env := [][2]string{}
	keys := map[string]bool{}
	for _, kv := range custom {
		env = setPair(env, kv[0], kv[1])
		k := kv[0]
		if isWindows {
			k = strings.ToUpper(k)
		}
		keys[k] = true
	}
	for _, k := range defaults {
		if keys[k] {
			continue
		}
		v, ok := lookup(k)
		if !ok || strings.HasPrefix(v, "()") {
			continue
		}
		env = setPair(env, k, v)
	}
	return env
}

// processEnvLookup = process.env[key]（Windows 大小写不敏感）
func processEnvLookup(k string) (string, bool) {
	if runtime.GOOS == "windows" {
		for _, kv := range os.Environ() {
			if i := strings.IndexByte(kv[1:], '=') + 1; i > 0 && strings.EqualFold(kv[:i], k) {
				return kv[i+1:], true
			}
		}
		return "", false
	}
	return os.LookupEnv(k)
}
