package hostports

import (
	"os"
	"path/filepath"
	"strings"
)

// Documents = Electron app.getPath('documents')（Chromium chrome::DIR_USER_DOCUMENTS）。
func Documents() string { return documentsDir() }

// xdgUserDirLookup = Chromium third_party/xdg_user_dirs xdg_user_dir_lookup_with_fallback(type, NULL)：
// 读 $XDG_CONFIG_HOME（空则 $HOME/.config）/user-dirs.dirs，取最后一条 XDG_<type>_DIR="..."；
// 值须以 $HOME 或 / 开头，支持反斜杠转义。HOME 未设置 / 文件缺失 / 无匹配返回 ""。
func xdgUserDirLookup(getenv func(string) string, readFile func(string) ([]byte, error), typ string) string {
	home, ok := "", false
	if h, set := lookup(getenv, "HOME"); set {
		home, ok = h, true
	}
	if !ok {
		return ""
	}
	cfg := getenv("XDG_CONFIG_HOME")
	var file string
	if cfg == "" {
		file = home + "/.config/user-dirs.dirs"
	} else {
		file = cfg + "/user-dirs.dirs"
	}
	b, err := readFile(file)
	if err != nil {
		return ""
	}
	res := ""
	for _, line := range strings.Split(string(b), "\n") {
		p := strings.TrimLeft(line, " \t")
		if !strings.HasPrefix(p, "XDG_") {
			continue
		}
		p = p[4:]
		if !strings.HasPrefix(p, typ) {
			continue
		}
		p = p[len(typ):]
		if !strings.HasPrefix(p, "_DIR") {
			continue
		}
		p = strings.TrimLeft(p[4:], " \t")
		if !strings.HasPrefix(p, "=") {
			continue
		}
		p = strings.TrimLeft(p[1:], " \t")
		if !strings.HasPrefix(p, `"`) {
			continue
		}
		p = p[1:]
		relative := false
		if strings.HasPrefix(p, "$HOME") {
			p, relative = p[5:], true
		} else if !strings.HasPrefix(p, "/") {
			continue
		}
		var sb strings.Builder
		if relative {
			sb.WriteString(home)
		}
		for i := 0; i < len(p) && p[i] != '"'; i++ {
			if p[i] == '\\' && i+1 < len(p) {
				i++
			}
			sb.WriteByte(p[i])
		}
		res = sb.String()
	}
	return res
}

var lookupEnv = os.LookupEnv

func lookup(getenv func(string) string, k string) (string, bool) {
	if getenv != nil {
		v := getenv(k)
		if v != "" {
			return v, true
		}
		_, set := lookupEnv(k)
		return v, set
	}
	return lookupEnv(k)
}

// linuxDocuments = Chromium base::nix::GetXDGUserDirectory("DOCUMENTS", "Documents")：
// 查到用查到的，否则 GetHomeDir()/Documents；去掉尾部分隔符。
func linuxDocuments(getenv func(string) string, readFile func(string) ([]byte, error), homeDir func() string) string {
	p := xdgUserDirLookup(getenv, readFile, "DOCUMENTS")
	if p == "" {
		p = filepath.Join(homeDir(), "Documents")
	}
	for len(p) > 1 && strings.HasSuffix(p, "/") {
		p = p[:len(p)-1]
	}
	return p
}

// chromiumHome = base::GetHomeDir()：$HOME 非空用之，否则 passwd 家目录，再否则 /tmp。
func chromiumHome() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "/tmp"
}
