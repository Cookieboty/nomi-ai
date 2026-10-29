package accounts

import (
	"crypto/sha256"
	"encoding/hex"
	"os/user"
	"regexp"
	"runtime"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ClaudeKeychainService = claudeKeychainService.
func ClaudeKeychainService(env *util.Obj, configDir string) string {
	base := "Claude Code-credentials"
	if !truthy(env.Get("CLAUDE_CONFIG_DIR")) {
		return base
	}
	sum := sha256.Sum256([]byte(norm.NFC.String(configDir)))
	return base + "-" + hex.EncodeToString(sum[:])[:8]
}

var accountNameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// userInfoName = os.userInfo().username (error = throws).
var userInfoName = func() (string, error) {
	u, err := user.Current()
	if err != nil {
		return "", err
	}
	name := u.Username
	if runtime.GOOS == "windows" {
		if i := strings.LastIndexByte(name, '\\'); i >= 0 {
			name = name[i+1:]
		}
	}
	return name, nil
}

// ClaudeAccountName = claudeAccountName.
func ClaudeAccountName(env *util.Obj) string {
	var name string
	if v := env.Get("USER"); truthy(v) {
		name = jsStr(v)
	} else if n, err := userInfoName(); err == nil {
		name = n
	} else {
		name = "claude-code-user"
	}
	if accountNameRe.MatchString(name) {
		return name
	}
	return "claude-code-user"
}
