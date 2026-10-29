// Package mascothandlers 把批次 10（看板娘 / 角色包 / 灵动岛）的契约过程挂到 Router。
// 对应 packages/core/src/contract/mascot.ts（内核部分）与 packages/host-electron/src/host/contract/mascot.ts（宿主部分）。
package mascothandlers

import (
	"context"
	"encoding/json"
	"math"
	"runtime"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascot"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/settings"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

type Deps struct {
	Router    *contract.Router
	Config    *services.ConfigService
	Settings  *settings.Store
	Character *character.Service
	Island    *island.Service
	// Geometry 返回外壳几何能力（外壳在 Install 之后才建，故用函数）；nil = 尚不可用
	Geometry func() shell.Geometry
	Quit     func()
	OpenChat func()
	// T 翻译（core.i18n.t）
	T       func(key string) string
	AppName string
}

func bad(err error) error { return &contract.Error{Code: "BAD_INPUT", Message: err.Error()} }

// Controller = MascotWindowController 的缩放 + 拖拽部分（物理 / 散步 / 点击穿透见 D-B10-3）
type Controller struct {
	mu    sync.Mutex
	d     Deps
	scale float64
	box   *mascot.MascotBox
	drag  *struct{ dx, dy float64 }
}

func (c *Controller) geom() (shell.Geometry, shell.Rect, bool) {
	if c.d.Geometry == nil {
		return nil, shell.Rect{}, false
	}
	g := c.d.Geometry()
	if g == nil {
		return nil, shell.Rect{}, false
	}
	b, ok := g.Bounds(shell.Mascot)
	return g, b, ok
}

func (c *Controller) workAreas(g shell.Geometry) []mascot.AreaRect {
	var out []mascot.AreaRect
	for _, a := range g.WorkAreas() {
		sf := a.ScaleFactor
		out = append(out, mascot.AreaRect{X: float64(a.X), Y: float64(a.Y), Width: float64(a.Width), Height: float64(a.Height), ScaleFactor: &sf})
	}
	return out
}

func areaUnder(areas []mascot.AreaRect, x float64) *mascot.AreaRect {
	if len(areas) == 0 {
		return nil
	}
	best, bd := areas[0], math.Inf(1)
	for _, a := range areas {
		if x >= a.X && x < a.X+a.Width {
			return &a
		}
		d := math.Min(math.Abs(a.X-x), math.Abs(x-(a.X+a.Width)))
		if d < bd {
			best, bd = a, d
		}
	}
	return &best
}

func (c *Controller) capNow() float64 {
	g, b, ok := c.geom()
	if !ok {
		return mascot.MaxScaleForArea(nil)
	}
	cx := float64(b.X) + float64(b.Width)/2
	if c.box != nil {
		cx = float64(b.X) + (c.box.Left+c.box.Right)/2
	}
	return mascot.MaxScaleForArea(areaUnder(c.workAreas(g), cx))
}

func (c *Controller) state() mascot.ScaleState {
	_, b, ok := c.geom()
	w := mascot.Size{}
	if ok {
		w = mascot.Size{Width: float64(b.Width), Height: float64(b.Height)}
	}
	return mascot.ScaleState{Scale: c.scale, Min: mascot.MinMascotScale, Max: c.capNow(), HardMax: mascot.MaxMascotScale,
		Default: mascot.DefaultMascotScale, Step: mascot.MascotScaleStep, Window: w}
}

func (c *Controller) setScale(raw float64) mascot.ScaleState {
	target := mascot.FitMascotScale(raw, c.capNow())
	g, b, ok := c.geom()
	if ok && target != c.scale {
		nb := mascot.ResizeMascotBounds(mascot.ResizeInput{
			Bounds:    mascot.MascotBounds{X: float64(b.X), Y: float64(b.Y), Width: float64(b.Width), Height: float64(b.Height)},
			FromScale: c.scale, ToScale: target, Box: c.box, WorkAreas: c.workAreas(g),
		})
		g.SetBounds(shell.Mascot, shell.Rect{X: int(nb.X), Y: int(nb.Y), Width: int(nb.Width), Height: int(nb.Height)})
		if c.box != nil {
			r := target / c.scale
			k := func(v, pad, max float64) float64 { return math.Max(0, math.Min(max, pad+(v-pad)*r)) }
			c.box = &mascot.MascotBox{Left: k(c.box.Left, mascot.MascotPad.X, nb.Width), Right: k(c.box.Right, mascot.MascotPad.X, nb.Width),
				Top: k(c.box.Top, mascot.MascotPad.Top, nb.Height), Bottom: k(c.box.Bottom, mascot.MascotPad.Top, nb.Height)}
		}
	}
	if ok || target != c.scale {
		c.scale = target
	}
	st := c.state()
	_ = c.d.Config.UpdateConfig(map[string]any{"mascotScale": target})
	c.d.Router.Emit("mascot.scaleChanged", st)
	return st
}

// WindowSize 返回按保存缩放算出的看板娘窗口大小（外壳建窗口时用）
func (c *Controller) WindowSize() (int, int) {
	s := mascot.MascotWindowSize(c.scale)
	return int(s.Width), int(s.Height)
}

func Install(d Deps) *Controller {
	r := d.Router
	c := &Controller{d: d, scale: mascot.FitMascotScale(d.Config.GetConfig().MascotScale, mascot.MaxMascotScale)}
	lock := func(f func() (any, error)) (any, error) {
		c.mu.Lock()
		defer c.mu.Unlock()
		return f()
	}
	call := func(name string, f func(raw json.RawMessage) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) { return f(raw) })
	}

	// —— 渲染器设置（§5）
	call("mascot.getRenderer", func(json.RawMessage) (any, error) { return d.Settings.Get().Mascot.Renderer, nil })
	call("mascot.setRenderer", func(raw json.RawMessage) (any, error) {
		var in struct {
			Renderer any `json:"renderer"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		next := "svg"
		if in.Renderer == "rive" {
			next = "rive"
		}
		if err := d.Settings.SetMascotRenderer(next); err != nil {
			return nil, err
		}
		r.Emit("mascot.rendererChanged", next)
		return next, nil
	})

	// —— 大小
	call("mascot.scaleGet", func(json.RawMessage) (any, error) { return lock(func() (any, error) { return c.state(), nil }) })
	call("mascot.scaleSet", func(raw json.RawMessage) (any, error) {
		var in struct {
			Scale *float64 `json:"scale"`
		}
		_ = json.Unmarshal(raw, &in)
		return lock(func() (any, error) {
			if in.Scale == nil || math.IsNaN(*in.Scale) || math.IsInf(*in.Scale, 0) {
				return c.state(), nil
			}
			return c.setScale(*in.Scale), nil
		})
	})
	call("mascot.scaleStep", func(raw json.RawMessage) (any, error) {
		var in struct {
			Dir float64 `json:"dir"`
		}
		_ = json.Unmarshal(raw, &in)
		dir := 1
		if in.Dir == -1 {
			dir = -1
		}
		return lock(func() (any, error) { return c.setScale(mascot.StepMascotScale(c.scale, dir, c.capNow())), nil })
	})
	call("mascot.scaleWheel", func(raw json.RawMessage) (any, error) {
		var in struct {
			DeltaY    *float64 `json:"deltaY"`
			DeltaMode float64  `json:"deltaMode"`
		}
		_ = json.Unmarshal(raw, &in)
		return lock(func() (any, error) {
			if in.DeltaY == nil {
				return c.state(), nil
			}
			return c.setScale(mascot.WheelMascotScale(c.scale, *in.DeltaY, in.DeltaMode, c.capNow())), nil
		})
	})
	call("mascot.scaleReset", func(json.RawMessage) (any, error) {
		return lock(func() (any, error) { return c.setScale(mascot.DefaultMascotScale), nil })
	})

	// —— 几何 / 拖拽（形状、命中、互动设置、散步：接收但不处理，D-B10-3）
	call("mascot.setGeometry", func(raw json.RawMessage) (any, error) {
		var b mascot.MascotBox
		if json.Unmarshal(raw, &b) == nil && !(b.Left == 0 && b.Right == 0 && b.Top == 0 && b.Bottom == 0) {
			c.mu.Lock()
			c.box = &b
			c.mu.Unlock()
		}
		return nil, nil
	})
	for _, n := range []string{"mascot.setShape", "mascot.setHit", "mascot.setInteractionConfig", "mascot.wanderNow"} {
		call(n, func(json.RawMessage) (any, error) { return nil, nil })
	}
	call("mascot.dragStart", func(raw json.RawMessage) (any, error) {
		var in struct{ ScreenX, ScreenY *float64 }
		_ = json.Unmarshal(raw, &in)
		c.mu.Lock()
		defer c.mu.Unlock()
		_, b, ok := c.geom()
		if !ok || in.ScreenX == nil || in.ScreenY == nil {
			return nil, nil
		}
		c.drag = &struct{ dx, dy float64 }{*in.ScreenX - float64(b.X), *in.ScreenY - float64(b.Y)}
		return nil, nil
	})
	call("mascot.dragMove", func(raw json.RawMessage) (any, error) {
		var in struct{ ScreenX, ScreenY float64 }
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		g, b, ok := c.geom()
		if !ok || c.drag == nil {
			return nil, nil
		}
		g.SetBounds(shell.Mascot, shell.Rect{X: int(math.Round(in.ScreenX - c.drag.dx)), Y: int(math.Round(in.ScreenY - c.drag.dy)), Width: b.Width, Height: b.Height})
		return nil, nil
	})
	call("mascot.dragEnd", func(json.RawMessage) (any, error) {
		c.mu.Lock()
		c.drag = nil
		c.mu.Unlock()
		return nil, nil
	})

	// —— 模型名（config.modelName）
	call("mascot.saveModel", func(raw json.RawMessage) (any, error) {
		var in struct {
			ModelName string `json:"modelName"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		return nil, d.Config.UpdateConfig(map[string]any{"modelName": in.ModelName})
	})
	call("mascot.getSavedModel", func(json.RawMessage) (any, error) { return d.Config.GetConfig().ModelName, nil })

	// —— 角色包
	call("character.getActivePack", func(json.RawMessage) (any, error) { return d.Character.Active(), nil })

	// —— 灵动岛
	call("island.get", func(json.RawMessage) (any, error) { return d.Island.Get(), nil })
	call("island.set", func(raw json.RawMessage) (any, error) {
		var patch map[string]any
		if err := json.Unmarshal(raw, &patch); err != nil {
			return nil, bad(err)
		}
		return d.Island.Set(patch)
	})
	call("island.test", func(json.RawMessage) (any, error) {
		body := "electron.common.this-is-what-an-island-notification-looks-like"
		if d.T != nil {
			body = d.T(body)
		}
		return d.Island.Test(d.AppName, body), nil
	})

	// —— 旧窗口通道
	call("window.platform", func(json.RawMessage) (any, error) { return Platform(), nil })
	call("window.quit", func(json.RawMessage) (any, error) {
		if d.Quit != nil {
			go d.Quit()
		}
		return nil, nil
	})
	call("window.openAiChat", func(json.RawMessage) (any, error) {
		if d.OpenChat != nil {
			d.OpenChat()
		}
		return nil, nil
	})
	call("window.setAlwaysOnTop", func(raw json.RawMessage) (any, error) {
		var in struct {
			Flag bool `json:"flag"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		if g, _, ok := c.geom(); ok {
			g.SetAlwaysOnTop(shell.Mascot, in.Flag)
		}
		return nil, nil
	})
	call("window.getPosition", func(json.RawMessage) (any, error) {
		_, b, _ := c.geom()
		return [2]int{b.X, b.Y}, nil
	})
	call("window.setPosition", func(raw json.RawMessage) (any, error) {
		var in struct{ X, Y float64 }
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		if g, b, ok := c.geom(); ok {
			g.SetBounds(shell.Mascot, shell.Rect{X: int(in.X), Y: int(in.Y), Width: b.Width, Height: b.Height})
		}
		return nil, nil
	})
	call("window.move", func(raw json.RawMessage) (any, error) {
		var in struct{ DeltaX, DeltaY float64 }
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		if g, b, ok := c.geom(); ok {
			g.SetBounds(shell.Mascot, shell.Rect{X: b.X + int(in.DeltaX), Y: b.Y + int(in.DeltaY), Width: b.Width, Height: b.Height})
		}
		return nil, nil
	})
	return c
}

// Platform = process.platform（windows → win32）
func Platform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
