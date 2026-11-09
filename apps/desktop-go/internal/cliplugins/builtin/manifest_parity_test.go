package builtin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Go 侧的清单 / 渲染信息与 packages/cli-catalog 一致：两边都和 testdata/b7s2-plugins.json 比
// （cli-catalog 的 tests/manifests-parity.test.ts 比的是同一份文件；改清单时两边一起改，再更新这份文件）
func TestManifestsMatchCatalog(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "b7s2-plugins.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	norm := func(v any) any {
		var out any
		_ = json.Unmarshal([]byte(util.Stringify(v)), &out)
		return out
	}
	ids := make([]any, len(IDs))
	for i, id := range IDs {
		ids[i] = id
	}
	got := map[string]any{"ids": ids, "manifests": norm(Manifests), "renderers": norm(Renderers)}
	for k := range got {
		if !reflect.DeepEqual(got[k], want[k]) {
			g, _ := json.MarshalIndent(got[k], "", " ")
			t.Errorf("%s differs from testdata/b7s2-plugins.json:\n%s", k, g)
		}
	}
}
