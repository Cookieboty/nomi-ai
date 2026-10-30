package drivers

import (
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// probeStr mirrors acpProbe 的 str（trim 后取前 120 个 UTF-16 单元）。
func probeStr(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || clisdk.JSTrim(s) == "" {
		return "", false
	}
	return clisdk.Slice0(clisdk.JSTrim(s), 120), true
}

// ProbeAcp mirrors probeAcp：结果为 AcpProbeResult 的 Obj。
func ProbeAcp(child clisdk.ChildLike, timeoutMs *int, kill clisdk.KillFn) (*util.Obj, error) {
	conn := rpc.NewConnection(child, rpc.Handlers{
		OnNotification: func(string, rpc.Json) {},
		OnRequest: func(string, rpc.Json) *jsrt.Promise[any] {
			return jsrt.Rejected[any](errors.New("not supported during probe"))
		},
	}, rpc.ConnectionOptions{})
	defer clisdk.EndChild(child, kill)
	t := 15000
	if timeoutMs != nil {
		t = *timeoutMs
	}
	v, err := jsrt.Await(conn.Request("initialize", O("protocolVersion", float64(1),
		"clientCapabilities", O("fs", O("readTextFile", false, "writeTextFile", false))), rpc.RequestOptions{TimeoutMs: &t}))
	if err != nil {
		return nil, err
	}
	init, _ := v.(*util.Obj)
	get := func(k string) any {
		if init == nil {
			return nil
		}
		return init.Get(k)
	}
	caps, _ := get("agentCapabilities").(*util.Obj)
	if caps == nil {
		caps = O()
	}
	prompt, _ := caps.Get("promptCapabilities").(*util.Obj)
	if prompt == nil {
		prompt = O()
	}
	info, _ := get("agentInfo").(*util.Obj)
	if info == nil {
		info = O()
	}
	agent := O()
	for _, k := range []string{"name", "title", "version"} {
		if s, ok := probeStr(info.Get(k)); ok {
			agent.Set(k, s)
		}
	}
	var pv any
	if n, ok := get("protocolVersion").(float64); ok {
		pv = n
	}
	auth := []any{}
	if arr, ok := get("authMethods").([]any); ok {
		for _, m := range arr {
			mo, _ := m.(*util.Obj)
			var s string
			var ok bool
			if mo != nil {
				if s, ok = probeStr(mo.Get("name")); !ok {
					s, ok = probeStr(mo.Get("id"))
				}
			}
			if ok && len(auth) < 8 {
				auth = append(auth, s)
			}
		}
	}
	return O("protocolVersion", pv, "agent", agent, "capabilities", O(
		"loadSession", caps.Get("loadSession") == true, "images", prompt.Get("image") == true,
		"audio", prompt.Get("audio") == true, "embeddedContext", prompt.Get("embeddedContext") == true),
		"authMethods", auth), nil
}
