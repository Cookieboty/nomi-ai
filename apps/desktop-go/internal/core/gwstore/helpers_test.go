package gwstore

// 测试辅助（原在已删除的 parity 测试里）

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 录制脚本里的确定性假 safeStorage：base64("ss:"+明文)
type fakeCipher struct{}

func (fakeCipher) Kind() string { return "safeStorage" }

func (fakeCipher) Encrypt(p string) (string, error) {
	return base64.StdEncoding.EncodeToString([]byte("ss:" + p)), nil
}

func (fakeCipher) Decrypt(s string) (string, error) {
	t := providers.NodeBase64Decode(s)
	if !strings.HasPrefix(t, "ss:") {
		return "", errors.New("bad")
	}
	return t[3:], nil
}

func gwConfigForTest() *u.Obj {
	v, _ := u.ParseString(`{"port":18999,"providers":[]}`)
	return v.(*u.Obj)
}

// cliModelsAPI = record-gwcli.mjs modelsApi(n)
func cliModelsAPI(n int) any {
	ms := u.NewObj()
	for i := 0; i < n; i++ {
		in := []any{"text"}
		if i%3 == 0 {
			in = []any{"text", "image"}
		}
		ms.Set(fmt.Sprintf("m-%03d", i), u.NewObj("id", fmt.Sprintf("m-%d", i), "name", fmt.Sprintf("M %d", i), "reasoning", i%2 == 0,
			"modalities", u.NewObj("input", in), "limit", u.NewObj("context", float64(100000+i*1000), "output", float64(4096+i))))
	}
	ms.Set("plain", u.NewObj("id", "plain", "name", "Plain", "limit", u.NewObj("context", float64(777000), "output", float64(33000))))
	ms.Set("embed", u.NewObj("id", "embed", "type", "embedding", "limit", u.NewObj("context", float64(8000))))
	return u.NewObj("openai", u.NewObj("models", ms))
}
