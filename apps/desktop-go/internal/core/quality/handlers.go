package quality

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CliSink：harness.QualitySink 适配（AddCli 不要返回值）
type CliSink struct{ S *Service }

// AddCli = quality.addCli
func (c CliSink) AddCli(rec *u.Obj) {
	if c.S != nil {
		c.S.AddCli(rec)
	}
}

var errBad = &contract.Error{Code: "BAD_INPUT", Message: "Invalid input"}

// ---- zod 校验（schemas.ts 的 Quality* ；loose = 多余字段放行）----

func parseObj(raw json.RawMessage) (*u.Obj, bool) {
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

func isNum(o *u.Obj, k string) bool { _, ok := o.Get(k).(float64); return o.Has(k) && ok }

func optOK(o *u.Obj, k string, f func(any) bool) bool {
	if !o.Has(k) {
		return true
	}
	v := o.Get(k)
	if v == u.Undefined {
		return true
	}
	return f(v)
}

func isLayer(v any) bool { return v == "gateway" || v == "cli" }

func isStrArr(v any) bool {
	a, ok := arr(v)
	if !ok {
		return false
	}
	for _, x := range a {
		if _, ok := x.(string); !ok {
			return false
		}
	}
	return true
}

func isFilters(v any) bool {
	o, ok := v.(*u.Obj)
	if !ok {
		return false
	}
	for _, k := range o.Keys() {
		if !isStrArr(o.Get(k)) {
			return false
		}
	}
	return true
}

func isStr(v any) bool { _, ok := v.(string); return ok }

func validBase(o *u.Obj) bool {
	return isNum(o, "from") && isNum(o, "to") && optOK(o, "layer", isLayer)
}

func validQuery(o *u.Obj) bool {
	return validBase(o) && optOK(o, "filters", isFilters) && optOK(o, "groupBy", isStr) && optOK(o, "groupPath", isStrArr)
}

// Install：shell.ts 的 quality.*（quality.changed 由服务发布）
func Install(r *contract.Router, svc func() *Service) {
	get := func() (*Service, error) {
		if s := svc(); s != nil {
			return s, nil
		}
		return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'quality' is not available"}
	}
	in := func(name string, valid func(*u.Obj) bool, f func(*Service, *u.Obj) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
			o, ok := parseObj(raw)
			if !ok || !valid(o) {
				return nil, errBad
			}
			s, err := get()
			if err != nil {
				return nil, err
			}
			return f(s, o)
		})
	}
	in("quality.query", validQuery, func(s *Service, o *u.Obj) (any, error) { return s.Query(o), nil })
	in("quality.series", func(o *u.Obj) bool {
		b := o.Get("bucket")
		return validQuery(o) && (b == "hour" || b == "day") && isStr(o.Get("metric"))
	}, func(s *Service, o *u.Obj) (any, error) { return s.Series(o) })
	in("quality.requests", func(o *u.Obj) bool {
		return validBase(o) && optOK(o, "filters", isFilters) && isNum(o, "limit") &&
			optOK(o, "offset", func(v any) bool { _, ok := v.(float64); return ok })
	}, func(s *Service, o *u.Obj) (any, error) { return s.Requests(o), nil })
	in("quality.facets", validBase, func(s *Service, o *u.Obj) (any, error) { return s.Facets(o), nil })
	in("quality.setSettings", func(o *u.Obj) bool {
		return optOK(o, "retentionDays", func(v any) bool { _, ok := v.(float64); return ok })
	}, func(s *Service, o *u.Obj) (any, error) { return s.SetSettings(o), nil })
	in("quality.exportCsv", func(o *u.Obj) bool {
		k := o.Get("kind")
		q, ok := o.Get("query").(*u.Obj)
		return (k == "requests" || k == "table") && ok && isNum(q, "from") && isNum(q, "to")
	}, func(s *Service, o *u.Obj) (any, error) { return s.ExportCsv(o) })
	r.Call("quality.getSettings", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		s, err := get()
		if err != nil {
			return nil, err
		}
		return s.GetSettings(), nil
	})
	r.Call("quality.clear", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		s, err := get()
		if err != nil {
			return nil, err
		}
		if err := s.Clear(); err != nil {
			return nil, err
		}
		return true, nil
	})
}
