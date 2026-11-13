package harness

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/modelid"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// noteResponseModel stamps the upstream response model onto an assistant
// message when it is a different model from the one this turn requested.
// since is the turn start (ms); a sample from an earlier turn is ignored.
func noteResponseModel(msg *util.Obj, tabID string, since float64) {
	if msg == nil || tabID == "" {
		return
	}
	s, ok := modelid.Latest(modelid.TabKey(tabID))
	if !ok || float64(s.At) < since {
		return
	}
	req := append([]string{}, s.Requested...)
	if m, ok := msg.Get("model").(string); ok {
		req = append(req, m)
	}
	if raw := modelid.Mismatch(req, s.Response); raw != "" {
		msg.Set("responseModel", raw)
	}
}
