package main

import (
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// wireGatewayRequests = createCore 的 new GatewayRequestLog({ root, logger, traceOn, importLegacy })
// 旧「最近请求」requests.json 导入模型质量账本一次后删除；追踪目录跟随诊断日志开关
func wireGatewayRequests(userData string, sp *shellProcs) *usage.GatewayRequestLog {
	return usage.NewGatewayRequestLog(usage.GatewayRequestLogDeps{
		Root:         filepath.Join(userData, "gateway"),
		Logger:       qualityLogger{deps.StdLogger{Prefix: "[gateway-requests]"}},
		TraceOn:      func() bool { return sp.Diagnostics != nil && sp.Diagnostics.BodyTrace() },
		ImportLegacy: func(records []*util.Obj) error { return sp.Quality.ImportLegacy(records) },
	})
}
