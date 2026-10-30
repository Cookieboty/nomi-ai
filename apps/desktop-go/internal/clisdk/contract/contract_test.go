package contract_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/contract"
)

// 同 apps/desktop-electron/internal/cli-plugins/tests/plugins.test.ts：每个内置插件契约检查为空。
func TestBuiltinContract(t *testing.T) {
	for _, id := range builtin.IDs {
		if ps, err := contract.CheckPlugin(builtin.Plugins[id], contract.Options{}); err != nil || len(ps) > 0 {
			t.Errorf("%s: %v %v", id, ps, err)
		}
	}
}
