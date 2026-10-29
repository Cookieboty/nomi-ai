package usage

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

var errBadInput = &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}

func parseInput(raw json.RawMessage) (*u.Obj, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	v, err := u.Parse(raw)
	if err != nil {
		return nil, false
	}
	o, ok := v.(*u.Obj)
	return o, ok
}

func present(o *u.Obj, k string) bool { return o.Has(k) && o.Get(k) != u.Undefined }

// detailInput：zod UsageDetailQuery（未知字段剥掉）
func detailInput(o *u.Obj) (*u.Obj, bool) {
	out := u.NewObj()
	for _, k := range []string{"from", "to", "source", "model", "session", "sort", "dir", "limit", "offset"} {
		if !present(o, k) {
			continue
		}
		v := o.Get(k)
		switch k {
		case "from", "to", "limit", "offset":
			if _, ok := v.(float64); !ok {
				return nil, false
			}
		case "sort":
			if v != "ts" && v != "tokens" && v != "cost" && v != "model" && v != "source" {
				return nil, false
			}
		case "dir":
			if v != "asc" && v != "desc" {
				return nil, false
			}
		default:
			if _, ok := v.(string); !ok {
				return nil, false
			}
		}
		out.Set(k, v)
	}
	return out, true
}

func entriesObj(es []QuotaEntry) []any {
	out := make([]any, len(es))
	for i, e := range es {
		out[i] = e.ToObj()
	}
	return out
}

// Install：contract/shell.ts 的 usage.*（usage.changed 由服务发布）。svc 返回 nil = 服务未就绪。
func Install(r *contract.Router, svc func() *UsageService) {
	get := func() (*UsageService, error) {
		if s := svc(); s != nil {
			return s, nil
		}
		return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'usage' is not available"}
	}
	call := func(name string, f func(s *UsageService, raw json.RawMessage) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			s, err := get()
			if err != nil {
				return nil, err
			}
			return f(s, raw)
		})
	}
	call("usage.state", func(s *UsageService, _ json.RawMessage) (any, error) {
		return jsrt.Block(jsrt.Call(s.ReadState))
	})
	call("usage.setSettings", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if !ok {
			return nil, errBadInput
		}
		var st UsageSettings
		var err error
		jsrt.Run(func() { st, err = s.SetSettings(o) })
		if err != nil {
			return nil, err
		}
		return st.ToObj(), nil
	})
	call("usage.query", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if !ok {
			return nil, errBadInput
		}
		rg := o.Get("range")
		if rg != "today" && rg != "7d" && rg != "30d" && rg != "90d" {
			return nil, errBadInput
		}
		return jsrt.Block(jsrt.Call(func() *jsrt.Promise[*u.Obj] { return s.ReadQuery(rg) }))
	})
	call("usage.details", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if ok {
			o, ok = detailInput(o)
		}
		if !ok {
			return nil, errBadInput
		}
		return jsrt.Block(jsrt.Call(func() *jsrt.Promise[DetailResult] { return s.ReadDetails(o) }))
	})
	call("usage.heatmap", func(s *UsageService, _ json.RawMessage) (any, error) {
		return jsrt.Block(jsrt.Call(s.ReadHeatmap))
	})
	call("usage.csv", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if ok {
			o, ok = detailInput(o)
		}
		if !ok {
			return nil, errBadInput
		}
		return jsrt.Block(jsrt.Call(func() *jsrt.Promise[string] { return s.ReadCsv(o) }))
	})
	call("usage.clear", func(s *UsageService, _ json.RawMessage) (any, error) {
		var st *u.Obj
		var err error
		jsrt.Run(func() { st, err = s.ClearWithState() })
		if err != nil {
			return nil, err
		}
		return st, nil
	})
	call("usage.scan", func(s *UsageService, _ json.RawMessage) (any, error) {
		return jsrt.Block(jsrt.Call(s.ScanWithState))
	})
	call("usage.endpoint", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if !ok {
			return nil, errBadInput
		}
		src, ok := o.Get("source").(string)
		if !ok {
			return nil, errBadInput
		}
		return jsrt.Block(jsrt.Call(func() *jsrt.Promise[*u.Obj] { return s.ReadEndpoint(src) }))
	})
	call("usage.priceSync", func(s *UsageService, _ json.RawMessage) (any, error) {
		return jsrt.Block(jsrt.Call(s.SyncPrices))
	})
	call("usage.quota", func(s *UsageService, _ json.RawMessage) (any, error) {
		es, err := jsrt.Block(jsrt.Call(s.QuotaViewed))
		if err != nil {
			return nil, err
		}
		return entriesObj(es), nil
	})
	call("usage.quotaRefresh", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if !ok {
			return nil, errBadInput
		}
		tool := ""
		if present(o, "tool") {
			if tool = QuotaToolOf(o.Get("tool")); tool == "" {
				return nil, errBadInput
			}
		}
		rep, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[QuotaRefreshReport] { return s.RefreshQuota(tool) }))
		if err != nil {
			return nil, err
		}
		return rep.ToObj(), nil
	})
	call("usage.quotaHook", func(s *UsageService, _ json.RawMessage) (any, error) {
		return jsrt.Call(s.QuotaHookStatus).ToObj(), nil
	})
	call("usage.quotaHookSet", func(s *UsageService, raw json.RawMessage) (any, error) {
		o, ok := parseInput(raw)
		if !ok {
			return nil, errBadInput
		}
		en, ok := o.Get("enabled").(bool)
		if !ok {
			return nil, errBadInput
		}
		var st HookStatus
		var err error
		jsrt.Run(func() { st, err = s.SetQuotaHook(en) })
		if err != nil {
			return nil, err
		}
		return st.ToObj(), nil
	})
}
