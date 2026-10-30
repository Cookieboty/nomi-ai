package hostports

import (
	"os"
	"strings"
)

// SystemLanguages = i18n systemLanguages：CD_LOCALE（测试 / e2e 固定语言）→ 系统首选语言
// （= app.getPreferredSystemLanguages()）→ 环境变量里的 locale（= app.getLocale() 的兜底）
func SystemLanguages() []string {
	if v := os.Getenv("CD_LOCALE"); v != "" {
		return []string{v}
	}
	if l := preferredLanguages(); len(l) > 0 {
		return l
	}
	return envLanguages()
}

// envLanguages：POSIX locale 环境变量（LANGUAGE 可以是冒号分隔的列表），zh_CN.UTF-8 → zh-CN；C / POSIX 不算
func envLanguages() []string {
	var out []string
	add := func(v string) {
		v, _, _ = strings.Cut(v, ".")
		v, _, _ = strings.Cut(v, "@")
		if v == "" || v == "C" || v == "POSIX" {
			return
		}
		out = append(out, strings.ReplaceAll(v, "_", "-"))
	}
	if v := os.Getenv("LANGUAGE"); v != "" {
		for _, p := range strings.Split(v, ":") {
			add(p)
		}
	}
	for _, k := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := os.Getenv(k); v != "" {
			add(v)
			break
		}
	}
	return out
}
