package usage

import (
	"os"
	"os/user"
	"runtime"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ProcessEnv 返回 process.env 的快照（Object.entries 顺序 = environ 顺序；Windows 跳过 `=C:` 这类隐藏变量，同 Node）。
func ProcessEnv() *util.Obj {
	o := util.NewObj()
	for _, kv := range os.Environ() {
		i := strings.IndexByte(kv, '=')
		if runtime.GOOS == "windows" && i == 0 {
			continue
		}
		if i < 0 {
			continue
		}
		k := kv[:i]
		if runtime.GOOS == "windows" {
			// process.env 在 Windows 上大小写不敏感：同名（忽略大小写）的后者不再出现
			dup := false
			for _, e := range o.Keys() {
				if strings.EqualFold(e, k) {
					dup = true
					break
				}
			}
			if dup {
				continue
			}
		}
		o.Set(k, kv[i+1:])
	}
	return o
}

// EnvGet 读 process.env[k]（Windows 大小写不敏感）；未设置返回 ("", false)。
func EnvGet(k string) (string, bool) { return os.LookupEnv(k) }

// EnvSlice：spawn 的 env 对象 → "K=V" 列表（值为 undefined/null 的键跳过，同 normalizeSpawnArguments）。
func EnvSlice(o *util.Obj) []string {
	out := []string{}
	for _, k := range o.Keys() {
		v := o.Get(k)
		if v == nil {
			continue
		}
		out = append(out, k+"="+util.JSString(v))
	}
	return out
}

// Str = env 对象里的字符串值（缺失/undefined → ""，ok=false）。
func Str(o *util.Obj, k string) (string, bool) {
	s, ok := o.Get(k).(string)
	return s, ok
}

// Homedir = os.homedir()：POSIX 先 $HOME 再 passwd；Windows USERPROFILE。
func Homedir() string {
	if runtime.GOOS == "windows" {
		if h := os.Getenv("USERPROFILE"); h != "" {
			return h
		}
	} else if h := os.Getenv("HOME"); h != "" {
		return h
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return ""
}

// Platform = process.platform。
func Platform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
