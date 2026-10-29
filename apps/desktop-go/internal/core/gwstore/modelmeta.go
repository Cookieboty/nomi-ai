package gwstore

// modelmeta.go = core/src/gateway/modelMeta.ts：模型元数据的生效值（unified-gateway §12.7.2）。
// 逐字段按优先级取第一个有值的：用户手填 > 预设 > 已保存的预设 / 模型列表值 > 内置目录 > 保守默认值。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DefaultCtx = DEFAULT_CTX；DefaultMaxOutput = DEFAULT_MAX_OUTPUT
const (
	DefaultCtx       = 128_000
	DefaultMaxOutput = 32_000
)

// LongContext = ResolvedModelMeta.longContext
type LongContext struct {
	Standard, Full float64
	FullSource     string
	On             bool
}

// ResolvedModelMeta = ResolvedModelMeta（Reasoning/Vision/ToolCalling 为 nil = 字段不存在）
type ResolvedModelMeta struct {
	Ctx, MaxOutput                 float64
	Reasoning, Vision, ToolCalling *bool
	Source, MaxOutputSource        string
	LongContext                    *LongContext
}

// Obj：同 JS 对象字面量的键序
func (r ResolvedModelMeta) Obj() *u.Obj {
	o := u.NewObj("ctx", r.Ctx, "maxOutput", r.MaxOutput)
	if r.Reasoning != nil {
		o.Set("reasoning", *r.Reasoning)
	}
	if r.Vision != nil {
		o.Set("vision", *r.Vision)
	}
	if r.ToolCalling != nil {
		o.Set("toolCalling", *r.ToolCalling)
	}
	o.Set("source", r.Source).Set("maxOutputSource", r.MaxOutputSource)
	if l := r.LongContext; l != nil {
		o.Set("longContext", u.NewObj("standard", l.Standard, "full", l.Full, "fullSource", l.FullSource, "on", l.On))
	}
	return o
}

// PresetEntry = presetEntry（list 为预设的 modelMeta 数组）
func PresetEntry(list []any, id string) *u.Obj {
	if len(list) == 0 {
		return nil
	}
	bare := models.BareModelID(id)
	for _, m := range list {
		if o := asObj(m); o != nil && o.Get("id") == id {
			return o
		}
	}
	for _, m := range list {
		if o := asObj(m); o != nil {
			if s, ok := o.Get("id").(string); ok && u.JSLower(s) == bare {
				return o
			}
		}
	}
	return nil
}

func objGet(o *u.Obj, path ...string) any {
	var v any = o
	for _, k := range path {
		x := asObj(v)
		if x == nil {
			return nil
		}
		v = x.Get(k)
	}
	return v
}

func catalogLayer(id string) *u.Obj {
	c := models.CatalogEntry(id)
	if c == nil {
		return nil
	}
	ctx := objGet(c, "limits", "input")
	if ctx == nil || ctx == u.Undefined {
		ctx = objGet(c, "limits", "context")
	}
	reasoning := false
	if r := asObj(c.Get("reasoning")); r != nil {
		reasoning = r.Get("control") != "none"
	}
	return u.NewObj(
		"ctx", ctx,
		"maxOutput", objGet(c, "limits", "maxOutput"),
		"reasoning", reasoning,
		"vision", objGet(c, "input", "images"),
		"toolCalling", objGet(c, "tools", "calling"),
	)
}

type picked struct {
	v   any
	src string
}

// ResolveModelMeta = resolveModelMeta(stored, id, preset, { longContext })
func ResolveModelMeta(stored *u.Obj, id string, preset *u.Obj, longContextOpt *bool) ResolvedModelMeta {
	ms := ""
	if stored != nil {
		ms, _ = stored.Get("metaSource").(string)
	}
	userSet := ms == "" || ms == "user"
	type layer struct {
		src string
		l   *u.Obj
	}
	third := "listed"
	if ms == "preset" {
		third = "preset"
	}
	var userL, storedL *u.Obj
	if userSet {
		userL = stored
	} else {
		storedL = stored
	}
	layers := []layer{{"user", userL}, {"preset", preset}, {third, storedL}, {"catalog", catalogLayer(id)}}
	pick := func(k string) *picked {
		for _, ly := range layers {
			if ly.l == nil {
				continue
			}
			v := ly.l.Get(k)
			if v == nil || v == u.Undefined {
				continue
			}
			if n, ok := v.(float64); ok && !(n > 0) {
				continue
			}
			return &picked{v, ly.src}
		}
		return nil
	}
	ctx, maxOutput := pick("ctx"), pick("maxOutput")
	reasoning, vision, toolCalling := pick("reasoning"), pick("vision"), pick("toolCalling")
	standard, _ := objGet(models.CatalogEntry(id), "limits", "standard").(float64)
	var long *LongContext
	if ctx != nil && ctx.src != "user" && standard != 0 {
		if full, ok := ctx.v.(float64); ok && standard < full {
			on := false
			if longContextOpt != nil {
				on = *longContextOpt
			} else if b, ok := objGet(stored, "longContext").(bool); ok {
				on = b
			}
			long = &LongContext{Standard: standard, Full: full, FullSource: ctx.src, On: on}
		}
	}
	r := resolved(ctx, maxOutput, reasoning, vision, toolCalling)
	if long != nil && !long.On {
		r.Ctx = long.Standard
		r.Source = "catalog"
	}
	r.LongContext = long
	return r
}

func pickedBool(p *picked) *bool {
	if p == nil {
		return nil
	}
	b, _ := p.v.(bool)
	return &b
}

func resolved(ctx, maxOutput, reasoning, vision, toolCalling *picked) ResolvedModelMeta {
	r := ResolvedModelMeta{Ctx: DefaultCtx, MaxOutput: DefaultMaxOutput, Source: "default", MaxOutputSource: "default"}
	if ctx != nil {
		r.Ctx, _ = ctx.v.(float64)
		r.Source = ctx.src
	}
	if maxOutput != nil {
		r.MaxOutput, _ = maxOutput.v.(float64)
		r.MaxOutputSource = maxOutput.src
	}
	r.Reasoning, r.Vision, r.ToolCalling = pickedBool(reasoning), pickedBool(vision), pickedBool(toolCalling)
	return r
}
