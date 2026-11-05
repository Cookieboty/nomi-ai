package gateway_test

// 测试辅助（原在已删除的 parity 测试里）

import (
	"encoding/json"
	"strings"
	_ "time/tzdata"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func e2eConfig(hostPort string, patch *u.Obj) *config.GatewayConfig {
	base := "http://" + hostPort
	prov := [][2]string{{"messages", "pm"}, {"responses", "pr"}, {"chat", "pc"}, {"gemini", "pg"}}
	ps := []any{}
	for _, p := range prov {
		url := base + "/" + p[0] + "/v1"
		if p[0] == "gemini" {
			url = base + "/gemini/v1beta"
		}
		ps = append(ps, u.NewObj("id", p[1], "name", strings.ToUpper(p[1]), "enabled", true,
			"urls", u.NewObj(p[0], url),
			"keys", []any{u.NewObj("id", "k1", "value", "key-"+p[1]+"-1", "enabled", true), u.NewObj("id", "k2", "value", "key-"+p[1]+"-2", "enabled", true)},
			"models", []any{u.NewObj("id", "m1", "enabled", true)}))
	}
	clients := u.NewObj()
	for _, c := range [][2]string{{"claude", "tok-claude"}, {"codex", "tok-codex"}, {"dsh", "tok-dsh"}, {"gemini", "tok-gemini"}} {
		clients.Set(c[0], u.NewObj("token", c[1], "models", u.NewObj("main", "pc/m1")))
	}
	o := u.NewObj("host", "127.0.0.1", "port", 0.0, "providers", ps, "clients", clients, "allowedPrivateHosts", []any{hostPort})
	if patch != nil {
		for _, k := range patch.Keys() {
			o.Set(k, patch.Get(k))
		}
	}
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(o)), &cfg); err != nil {
		panic(err)
	}
	return &cfg
}
