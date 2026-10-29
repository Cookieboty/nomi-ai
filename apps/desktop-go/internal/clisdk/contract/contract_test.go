package contract_test

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/contract"
)

// 同 packages/cli-plugins/tests/plugins.test.ts：每个内置插件契约检查为空。
func TestBuiltinContract(t *testing.T) {
	for _, id := range builtin.IDs {
		if ps := contract.CheckPlugin(builtin.Plugins[id], contract.Options{}); len(ps) > 0 {
			t.Errorf("%s: %v", id, ps)
		}
	}
}
