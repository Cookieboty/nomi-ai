package terminal

import (
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"runtime"
	"strings"
)

// WritePrivateFile = utils/privateFile writePrivateFile：0600 + 已存在时再 chmod；Windows 用 icacls 收紧。
func WritePrivateFile(file, data string) error {
	if err := os.WriteFile(file, []byte(data), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	tightenWindowsACL(file, false)
	return nil
}

// EnsurePrivateDir = ensurePrivateDir：0700 目录；Windows 收紧为仅当前用户 (OI)(CI)F。
func EnsurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(dir, 0o700)
	tightenWindowsACL(dir, true)
	return nil
}

var workgroupRe = regexp.MustCompile(`(?i)^WORKGROUP$`)

// windowsACLUser = windowsAclUser()
func windowsACLUser() string {
	fromOS := ""
	if cu, err := user.Current(); err == nil {
		fromOS = cu.Username // Windows 为 DOMAIN\user；os.userInfo().username 只有 user
		if i := strings.LastIndex(fromOS, `\`); i >= 0 {
			fromOS = fromOS[i+1:]
		}
	}
	name := os.Getenv("USERNAME")
	if name == "" {
		name = fromOS
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	if strings.Contains(name, `\`) {
		return name
	}
	if d := strings.TrimSpace(os.Getenv("USERDOMAIN")); d != "" && !workgroupRe.MatchString(d) {
		return d + `\` + name
	}
	return name
}

func tightenWindowsACL(p string, dir bool) bool {
	if runtime.GOOS != "windows" {
		return true
	}
	usr := windowsACLUser()
	if usr == "" {
		return false
	}
	grant := usr + ":(F)"
	if dir {
		grant = usr + ":(OI)(CI)F"
	}
	cmd := exec.Command("icacls", p, "/inheritance:r", "/grant:r", grant)
	hideWindow(cmd)
	return cmd.Run() == nil
}

func rmdir(d string) error {
	st, err := os.Lstat(d)
	if err != nil || !st.IsDir() {
		return err
	}
	return os.Remove(d) // 非空时失败：保留
}
