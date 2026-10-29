package request

import (
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// UnsupportedParamError is UnsupportedParamError.
type UnsupportedParamError struct{ Param, Model string }

func (e *UnsupportedParamError) Error() string {
	return "模型 " + e.Model + " 不支持参数 " + e.Param + "（严格模式：不自动去掉）"
}

// ParamChanges is ParamChanges (Renamed/Filled ordered objects).
type ParamChanges struct {
	Dropped []string
	Renamed *u.Obj
	Filled  *u.Obj
}

// JSON is the changes as the TS object.
func (c *ParamChanges) JSON() *u.Obj {
	d := make([]any, len(c.Dropped))
	for i, s := range c.Dropped {
		d[i] = s
	}
	return u.NewObj("dropped", d, "renamed", c.Renamed, "filled", c.Filled)
}

var maxFields = []string{"max_tokens", "max_output_tokens", "max_completion_tokens"}

// NormalizeParams is normalizeParams; returns *UnsupportedParamError in strict mode.
func NormalizeParams(wire string, o, m *u.Obj, notes *[]string) (*ParamChanges, error) {
	ch := &ParamChanges{Dropped: []string{}, Renamed: u.NewObj(), Filled: u.NewObj()}
	drop := func(k, why string) error {
		if !o.Has(k) {
			return nil
		}
		if m.Get("strict") == true {
			return &UnsupportedParamError{k, u.JSString(m.Get("id"))}
		}
		o.Delete(k)
		ch.Dropped = append(ch.Dropped, k)
		push(notes, k+" 已去掉（"+why+"）")
		return nil
	}
	if at(m, "sampling", "temperature") == false {
		if err := drop("temperature", "模型只接受默认温度"); err != nil {
			return nil, err
		}
		if wire == "messages" {
			if err := drop("top_k", "模型只接受默认采样"); err != nil {
				return nil, err
			}
		}
	}
	if at(m, "sampling", "topP") == false {
		if err := drop("top_p", "模型只接受默认采样"); err != nil {
			return nil, err
		}
	}
	if _, isN := isNumber(o.Get("max_tokens")); wire == "chat" && at(m, "params", "maxTokensField") == "max_completion_tokens" &&
		isN && !o.Has("max_completion_tokens") {
		o.Set("max_completion_tokens", o.Get("max_tokens"))
		o.Delete("max_tokens")
		ch.Renamed.Set("max_tokens", "max_completion_tokens")
		push(notes, "max_tokens → max_completion_tokens（模型在 Chat 上只认后者）")
	}
	if _, isN := isNumber(o.Get("max_tokens")); wire == "messages" && u.Truthy(at(m, "params", "requireMaxTokens")) && !isN {
		v := at(m, "limits", "maxOutput")
		if v == nil {
			v = float64(u.DefaultMaxTokens)
		}
		o.Set("max_tokens", v)
		ch.Filled.Set("max_tokens", v)
		push(notes, "max_tokens 已补为 "+u.JSString(v)+"（Messages 必填）")
	}
	if mo, ok := isNumber(at(m, "limits", "maxOutput")); ok && mo != 0 && mo > 0 {
		for _, k := range maxFields {
			if v, ok := isNumber(o.Get(k)); ok && v > mo {
				o.Set(k, mo)
				push(notes, k+" "+fmtNum(v)+" → "+fmtNum(mo))
			}
		}
		if gc := obj(o.Get("generationConfig")); wire == "gemini" && gc != nil {
			if v, ok := isNumber(gc.Get("maxOutputTokens")); ok && v > mo {
				o.Set("generationConfig", gc.Clone().Set("maxOutputTokens", mo))
				push(notes, "maxOutputTokens "+fmtNum(v)+" → "+fmtNum(mo))
			}
		}
	}
	return ch, nil
}
