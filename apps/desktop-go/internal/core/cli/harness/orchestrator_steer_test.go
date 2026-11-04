package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// steerTab：没有进行中的轮次（未知标签 / 空闲标签 / 空消息）一律 false，视图改为排队
func TestSteerTabWithoutRunningTurn(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", "claude")) })
	id := str(tab, "id")
	steer := func(id, text string) bool {
		ok, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[bool] { return o.SteerTab(id, text) }))
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if steer("no-such-tab", "x") || steer(id, "also run the tests") || steer(id, "   ") {
		t.Fatal("steer without a running turn should be false")
	}
}
