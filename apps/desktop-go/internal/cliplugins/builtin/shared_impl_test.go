package builtin

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
)

// 插件宿主拿到的实现与直接调 Impl 的是同一个实例（不各建一份、状态分叉）
func TestPluginsShareImpl(t *testing.T) {
	for _, id := range IDs {
		got, err := Plugins[id].Main(clisdk.CliMainHost{})
		if err != nil {
			t.Fatal(id, err)
		}
		if got != Impl(id) {
			t.Errorf("%s: plugin host and Impl hold different instances", id)
		}
	}
}
