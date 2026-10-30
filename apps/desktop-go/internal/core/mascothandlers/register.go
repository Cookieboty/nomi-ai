// Package mascothandlers 把批次 10（看板娘 / 角色包 / 灵动岛）的契约过程挂到 Router。
// 对应 packages/core/src/contract/mascot.ts（内核部分）与 apps/desktop-electron/src/host/contract/mascot.ts（宿主部分）。
package mascothandlers

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"runtime"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatbg"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatnav"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascot"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/persona"
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
	// Persona / ChatBg：persona.* 与 chatBg.*（nil = UNAVAILABLE，同 need(services.x)）
	Persona *persona.Service
	ChatBg  *chatbg.Service
	// Geometry 返回外壳几何能力（外壳在 Install 之后才建，故用函数）；nil = 尚不可用
	Geometry func() shell.Geometry
	Quit     func()
	OpenChat func()
	// T 翻译（core.i18n.t）
	T       func(key string) string
	AppName string
}

func bad(err error) error { return &contract.Error{Code: "BAD_INPUT", Message: err.Error()} }

// Controller 持有看板娘窗口的 mascot.Controller（= WindowManager.mascotController）：窗口建好时新建并 start，
// 关闭时 dispose；重建窗口（rive → svg）同样换一个新控制器，与 Electron 新窗口一致。
type Controller struct {
	mu    sync.Mutex
	d     Deps
	ctl   *mascot.Controller
	saveT *time.Timer
	// posT / lastPos：窗口移动后防抖保存 windowPosition（= setupMainWindowEvents，800ms）；关闭时立即落盘
	posT    *time.Timer
	lastPos *shell.Rect
	t0      time.Time
}

// SetRenderer 写 mascot.renderer 并广播；rive → svg 时重建看板娘窗口，让 Rive 占的内存随旧 WebView 进程一起释放
// （svg → rive 原地动态加载即可）。
func (c *Controller) SetRenderer(next string) (string, error) {
	prev := c.d.Settings.Get().Mascot.Renderer
	if err := c.d.Settings.SetMascotRenderer(next); err != nil {
		return "", err
	}
	c.d.Router.Emit("mascot.rendererChanged", next)
	if prev == "rive" && next == "svg" {
		if g := c.geomOnly(); g != nil {
			go g.Recreate(shell.Mascot)
		}
	}
	return next, nil
}

func (c *Controller) geomOnly() shell.Geometry {
	if c.d.Geometry == nil {
		return nil
	}
	return c.d.Geometry()
}

func (c *Controller) geom() (shell.Geometry, shell.Rect, bool) {
	g := c.geomOnly()
	if g == nil {
		return nil, shell.Rect{}, false
	}
	b, ok := g.Bounds(shell.Mascot)
	return g, b, ok
}

func (c *Controller) wc() shell.WindowControl {
	wc, _ := c.geomOnly().(shell.WindowControl)
	return wc
}

// current 返回当前控制器（窗口没建好时 nil）
func (c *Controller) current() *mascot.Controller {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ctl
}

// WindowEvent 接外壳窗口生命周期（wailsshell.Config.OnWindow）
func (c *Controller) WindowEvent(k shell.WindowKind, event string) {
	if k != shell.Mascot {
		return
	}
	if event == "moved" {
		c.windowMoved()
		return
	}
	c.mu.Lock()
	cur := c.ctl
	switch event {
	case "created":
		c.ctl = mascot.NewController(&winAdapter{c}, &hostAdapter{c}, rand.Float64, c.hooks(), Platform())
		next := c.ctl
		c.mu.Unlock()
		if cur != nil {
			cur.Dispose()
		}
		next.Start()
		return
	case "closed":
		c.ctl = nil
		// = releaseMascotWindow：销毁前把位置落盘（防抖的保存可能还没跑）
		if c.posT != nil {
			c.posT.Stop()
			c.posT = nil
		}
		if p := c.lastPos; p != nil {
			c.lastPos = nil
			go c.savePosition(p.X, p.Y)
		}
	}
	c.mu.Unlock()
	if cur == nil {
		return
	}
	switch event {
	case "closed":
		cur.Dispose()
	case "shown":
		cur.Wake()
	}
}

// watchDisplays：Wails 没有跨平台的 display-metrics-changed，轮询工作区变化
func (c *Controller) watchDisplays() {
	var last string
	for range time.Tick(2 * time.Second) {
		g := c.geomOnly()
		if g == nil {
			continue
		}
		b, _ := json.Marshal(g.WorkAreas())
		if k := string(b); k != last {
			if last != "" {
				if ctl := c.current(); ctl != nil {
					ctl.DisplaysChanged()
				}
			}
			last = k
		}
	}
}

func (c *Controller) hooks() *mascot.ScaleHooks {
	return &mascot.ScaleHooks{
		Get: func() float64 { return c.d.Config.GetConfig().MascotScale },
		Save: func(scale float64) {
			_ = c.d.Config.UpdateConfig(map[string]any{"mascotScale": scale})
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.saveT != nil {
				c.saveT.Stop()
			}
			c.saveT = time.AfterFunc(400*time.Millisecond, func() {
				if _, b, ok := c.geom(); ok {
					c.savePosition(b.X, b.Y)
				}
			})
		},
	}
}

// WindowSize 返回按保存缩放算出的看板娘窗口大小（外壳建窗口时用）
func (c *Controller) WindowSize(work *shell.Rect) (int, int) {
	// = buildMainWindow：fitMascotScale(config.mascotScale, maxScaleForArea(primary.workArea))；工作区未知时不夹
	cap := mascot.MaxMascotScale
	if work != nil {
		cap = mascot.MaxScaleForArea(&mascot.AreaRect{X: float64(work.X), Y: float64(work.Y),
			Width: float64(work.Width), Height: float64(work.Height)})
	}
	s := mascot.MascotWindowSize(mascot.FitMascotScale(c.d.Config.GetConfig().MascotScale, cap))
	return int(s.Width), int(s.Height)
}

// windowMoved = onGeometryChange → 800ms 防抖保存 windowPosition；几何在锁外读（Bounds 要等主线程）
func (c *Controller) windowMoved() {
	_, b, ok := c.geom()
	c.mu.Lock()
	defer c.mu.Unlock()
	if ok {
		c.lastPos = &b
	}
	if c.posT != nil {
		c.posT.Stop()
	}
	c.posT = time.AfterFunc(800*time.Millisecond, func() {
		c.mu.Lock()
		p := c.lastPos
		c.mu.Unlock()
		if p != nil {
			c.savePosition(p.X, p.Y)
		}
	})
}

// savePosition = configService.set('windowPosition.x/y') + save
func (c *Controller) savePosition(x, y int) {
	_ = c.d.Config.UpdateConfig(map[string]any{"windowPosition": map[string]any{"x": x, "y": y}})
}

// WindowPosition：config.windowPosition（拖动结束时保存），供建窗时恢复
func (c *Controller) WindowPosition() (int, int) {
	p := c.d.Config.GetConfig().WindowPosition
	return p.X, p.Y
}

// winAdapter = BrowserWindow（看板娘窗口）；窗口不存在即 isDestroyed
type winAdapter struct{ c *Controller }

func (w *winAdapter) IsDestroyed() bool { _, _, ok := w.c.geom(); return !ok }
func (w *winAdapter) GetPosition() (int, int) {
	_, b, _ := w.c.geom()
	return b.X, b.Y
}
func (w *winAdapter) GetSize() (int, int) {
	_, b, _ := w.c.geom()
	return b.Width, b.Height
}
func (w *winAdapter) GetBounds() mascot.IRect {
	_, b, _ := w.c.geom()
	return mascot.IRect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
}
func (w *winAdapter) SetBounds(r mascot.IRect) {
	if g := w.c.geomOnly(); g != nil {
		g.SetBounds(shell.Mascot, shell.Rect{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height})
	}
}
func (w *winAdapter) SetPosition(x, y int) {
	if wc := w.c.wc(); wc != nil {
		wc.SetPosition(shell.Mascot, x, y)
	}
}
func (w *winAdapter) IsResizable() bool {
	if wc := w.c.wc(); wc != nil {
		return wc.Resizable(shell.Mascot)
	}
	return false
}
func (w *winAdapter) SetResizable(b bool) {
	if wc := w.c.wc(); wc != nil {
		wc.SetResizable(shell.Mascot, b)
	}
}
func (w *winAdapter) IsVisible() bool {
	if wc := w.c.wc(); wc != nil {
		v, _ := wc.Shown(shell.Mascot)
		return v
	}
	return false
}
func (w *winAdapter) IsMinimized() bool {
	if wc := w.c.wc(); wc != nil {
		_, m := wc.Shown(shell.Mascot)
		return m
	}
	return false
}
func (w *winAdapter) SetIgnoreMouseEvents(ignore bool) {
	if wc := w.c.wc(); wc != nil {
		wc.SetIgnoreMouse(shell.Mascot, ignore)
	}
}
func (w *winAdapter) SetShape(rects []mascot.IRect) {
	if wc := w.c.wc(); wc != nil {
		out := make([]shell.Rect, len(rects))
		for i, r := range rects {
			out[i] = shell.Rect{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height}
		}
		wc.SetInputShape(shell.Mascot, out)
	}
}

// hostAdapter = performance.now / setTimeout / screen / 事件总线 / logger
type hostAdapter struct{ c *Controller }

func (h *hostAdapter) Now() float64 { return float64(time.Since(h.c.t0).Nanoseconds()) / 1e6 }
func (h *hostAdapter) After(ms float64, f func()) func() {
	t := time.AfterFunc(time.Duration(ms*float64(time.Millisecond)), f)
	return func() { t.Stop() }
}
func (h *hostAdapter) Cursor() (float64, float64) {
	if wc := h.c.wc(); wc != nil {
		x, y := wc.CursorPosition()
		return float64(x), float64(y)
	}
	return 0, 0
}
func (h *hostAdapter) Displays() []mascot.Rect {
	g := h.c.geomOnly()
	if g == nil {
		return nil
	}
	var out []mascot.Rect
	for _, a := range g.WorkAreas() {
		sf := a.ScaleFactor
		out = append(out, mascot.Rect{X: float64(a.X), Y: float64(a.Y), Width: float64(a.Width), Height: float64(a.Height), ScaleFactor: &sf})
	}
	return out
}
func (h *hostAdapter) Publish(ch string, payload any) { h.c.d.Router.Emit(ch, payload) }
func (h *hostAdapter) Info(msg string, data any)      { log.Printf("[mascot] %s %v", msg, data) }
func (h *hostAdapter) Warn(msg string, data any)      { log.Printf("[mascot] warn %s %v", msg, data) }

func unavailableSvc(name string) error {
	return &contract.Error{Code: "UNAVAILABLE", Message: "Service '" + name + "' is not available"}
}

func unavailable() error {
	return &contract.Error{Code: "UNAVAILABLE", Message: "Service 'mascotController' is not available"}
}

func Install(d Deps) *Controller {
	r := d.Router
	c := &Controller{d: d, t0: time.Now()}
	go c.watchDisplays()
	call := func(name string, f func(raw json.RawMessage) (any, error)) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) { return f(raw) })
	}
	obj := func(raw json.RawMessage) map[string]any {
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		if m == nil {
			m = map[string]any{}
		}
		return m
	}
	// 上报：控制器不在就丢弃
	report := func(name string, f func(ctl *mascot.Controller, in map[string]any)) {
		call(name, func(raw json.RawMessage) (any, error) {
			if ctl := c.current(); ctl != nil {
				f(ctl, obj(raw))
			}
			return nil, nil
		})
	}
	// 需要控制器：不在就 UNAVAILABLE（need(...)）
	need := func(name string, f func(ctl *mascot.Controller, in map[string]any) any) {
		call(name, func(raw json.RawMessage) (any, error) {
			ctl := c.current()
			if ctl == nil {
				return nil, unavailable()
			}
			return f(ctl, obj(raw)), nil
		})
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
		return c.SetRenderer(next)
	})

	// —— 人设（persona.changed 由 persona.Service.OnChange 转发，见 Install 调用方）
	call("persona.get", func(json.RawMessage) (any, error) {
		if d.Persona == nil {
			return nil, unavailableSvc("persona")
		}
		return d.Persona.Get(), nil
	})
	call("persona.systemPrompt", func(json.RawMessage) (any, error) {
		if d.Persona == nil {
			return nil, unavailableSvc("persona")
		}
		p := d.Persona.Get()
		t := d.T
		if t == nil {
			t = func(k string) string { return k }
		}
		return persona.DefaultSystemPrompt(&p, t), nil
	})

	// —— 聊天主面板背景
	bg := func(name string, f func(raw json.RawMessage) (chatbg.State, error)) {
		call(name, func(raw json.RawMessage) (any, error) {
			if d.ChatBg == nil {
				return nil, unavailableSvc("chatBg")
			}
			st, err := f(raw)
			if err != nil {
				if code := chatbg.ErrorCode(err); code != "" {
					return nil, &contract.Error{Code: code, Message: err.Error()}
				}
				return nil, err
			}
			return st, nil
		})
	}
	bg("chatBg.get", func(json.RawMessage) (chatbg.State, error) { return d.ChatBg.Get(), nil })
	bg("chatBg.set", func(raw json.RawMessage) (chatbg.State, error) { return d.ChatBg.Set(raw) })
	bg("chatBg.reset", func(json.RawMessage) (chatbg.State, error) { return d.ChatBg.Reset() })
	bg("chatBg.pickImage", func(json.RawMessage) (chatbg.State, error) { return d.ChatBg.PickImage() })

	// —— 看板娘窗口互动
	report("mascot.setShape", func(m *mascot.Controller, in map[string]any) { m.ReportShape(in["rects"]) })
	report("mascot.setHit", func(m *mascot.Controller, in map[string]any) { m.ReportHit(in["hit"]) })
	call("mascot.setGeometry", func(raw json.RawMessage) (any, error) {
		if ctl := c.current(); ctl != nil {
			var box any
			_ = json.Unmarshal(raw, &box)
			ctl.ReportGeometry(box)
		}
		return nil, nil
	})
	report("mascot.dragStart", func(m *mascot.Controller, in map[string]any) { m.BeginDrag(in["screenX"], in["screenY"]) })
	report("mascot.dragMove", func(m *mascot.Controller, in map[string]any) { m.MoveDrag(in["screenX"], in["screenY"]) })
	report("mascot.dragEnd", func(m *mascot.Controller, _ map[string]any) { m.EndDrag() })
	call("mascot.setInteractionConfig", func(raw json.RawMessage) (any, error) {
		if ctl := c.current(); ctl != nil {
			var cfg any
			_ = json.Unmarshal(raw, &cfg)
			ctl.SetConfig(cfg)
		}
		return nil, nil
	})
	report("mascot.wanderNow", func(m *mascot.Controller, _ map[string]any) { m.WanderNow() })
	need("mascot.debugSnapshot", func(m *mascot.Controller, _ map[string]any) any { return m.Snapshot() })

	// —— 看板娘大小
	need("mascot.scaleGet", func(m *mascot.Controller, _ map[string]any) any { return m.ScaleState() })
	need("mascot.scaleSet", func(m *mascot.Controller, in map[string]any) any { return m.ScaleSet(in["scale"]) })
	need("mascot.scaleStep", func(m *mascot.Controller, in map[string]any) any { return m.ScaleStep(in["dir"]) })
	need("mascot.scaleWheel", func(m *mascot.Controller, in map[string]any) any {
		return m.ScaleWheel(in["deltaY"], in["deltaMode"])
	})
	need("mascot.scaleReset", func(m *mascot.Controller, _ map[string]any) any { return m.ScaleReset() })

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
		return map[string]any{"success": true}, nil
	})
	// = openProviderPanel('nav.scheduleRequested')
	call("window.openTaskBoard", func(json.RawMessage) (any, error) {
		chatnav.OpenPanel(r, d.OpenChat, "nav.scheduleRequested")
		return map[string]any{"success": true}, nil
	})
	call("window.setAlwaysOnTop", func(raw json.RawMessage) (any, error) {
		var in struct {
			Flag bool `json:"flag"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, bad(err)
		}
		if g := c.geomOnly(); g != nil {
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
		_ = json.Unmarshal(raw, &in)
		if wc := c.wc(); wc != nil {
			if _, _, ok := c.geom(); ok {
				wc.SetPosition(shell.Mascot, jsRound(in.X), jsRound(in.Y))
			}
		}
		return nil, nil
	})
	call("window.move", func(raw json.RawMessage) (any, error) {
		var in struct{ DeltaX, DeltaY float64 }
		_ = json.Unmarshal(raw, &in)
		dx, dy := jsRound(in.DeltaX), jsRound(in.DeltaY)
		if dx == 0 && dy == 0 {
			return nil, nil
		}
		if wc := c.wc(); wc != nil {
			if _, b, ok := c.geom(); ok {
				wc.SetPosition(shell.Mascot, b.X+dx, b.Y+dy)
			}
		}
		return nil, nil
	})
	call("window.getCursorPosition", func(json.RawMessage) (any, error) {
		x, y := 0, 0
		if wc := c.wc(); wc != nil {
			x, y = wc.CursorPosition()
		}
		return map[string]int{"x": x, "y": y}, nil
	})
	return c
}

// jsRound = Math.round（.5 向 +∞）；NaN → 0（Number(x) || 0）
func jsRound(v float64) int {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return int(math.Floor(v + 0.5))
}

// Platform = process.platform（windows → win32）
func Platform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}
