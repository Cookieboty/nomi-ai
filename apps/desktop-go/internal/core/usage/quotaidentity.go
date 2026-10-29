package usage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 对应 quotaIdentity.ts

const saltFile = "quota-salt"

var saltRe = util.JSRe(`^[0-9a-f]{32}$`)

func LoadSalt(root string) string {
	f := filepath.Join(root, saltFile)
	if b, err := os.ReadFile(f); err == nil {
		s := util.JSTrim(string(b))
		if saltRe.MatchString(s) {
			return s
		}
	}
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	salt := hex.EncodeToString(buf)
	if os.MkdirAll(root, 0o777) == nil {
		_ = WritePrivateFile(f, salt)
	}
	return salt
}

// Fingerprint：parts 里 nil = null/undefined；空第一个字段返回 ""/false
func Fingerprint(salt string, parts []*string) (string, bool) {
	vals := make([]any, len(parts))
	for i, p := range parts {
		if p != nil {
			vals[i] = util.JSTrim(*p)
		} else {
			vals[i] = ""
		}
	}
	if len(vals) == 0 || vals[0] == "" {
		return "", false
	}
	h := sha256.Sum256([]byte(salt + "\n" + util.Stringify(vals)))
	return hex.EncodeToString(h[:])[:16], true
}

// WritePrivateFile = utils/privateFile.writePrivateFile（POSIX 0600；Windows ACL 见偏差 D12）
func WritePrivateFile(file, data string) error {
	if err := os.WriteFile(file, []byte(data), 0o600); err != nil {
		return err
	}
	_ = os.Chmod(file, 0o600)
	return nil
}

var _ = strings.TrimSpace
