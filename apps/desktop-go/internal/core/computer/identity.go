package computer

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// 应用身份：模型按显示名选应用，禁用规则却可以只写 bundle id（「com.tencent.」）。
// 读界面、操作、截图之前都按名字找到正在运行的应用，名字与 bundle id 一起判断；
// 查不到身份（list-apps 失败）、ref 背后的应用换了，都拒绝，不猜。
// 不指定应用的整屏截图：屏幕上有禁用应用的可见窗口就拒绝（拿不到窗口列表也拒绝）。

// appsCacheFor：同一次工具调用里（确认前检查、执行前检查）复用 list-apps 的结果
const appsCacheFor = 2 * time.Second

type appsCache struct {
	at   time.Time
	apps []App
}

func normName(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

func (s *Service) appsCached(ctx context.Context) ([]App, error) {
	s.mu.Lock()
	c := s.apps
	s.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < appsCacheFor {
		return c.apps, nil
	}
	apps, err := s.ListApps(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.apps = appsCache{at: time.Now(), apps: apps}
	s.mu.Unlock()
	return apps, nil
}

// identify：名字对应的正在运行的应用（同名优先，没有同名时按包含匹配：agent-desktop 按名字模糊匹配）。
// 候选里任何一个被禁用就拒绝（blocked_app）；候选只有一个 bundle id 时返回它
func (s *Service) identify(ctx context.Context, name string) (string, error) {
	if r := s.Blocked(name, ""); r != "" {
		return "", errf("blocked_app", "%s", r)
	}
	apps, err := s.appsCached(ctx)
	if err != nil {
		if CodeOf(err) == "stopped" {
			return "", err
		}
		return "", errf("unavailable", "无法确认「%s」是哪个应用（%v），不操作", name, err)
	}
	n := normName(name)
	var exact, fuzzy []App
	for _, a := range apps {
		an := normName(a.Name)
		switch {
		case an == n:
			exact = append(exact, a)
		case n != "" && strings.Contains(an, n):
			fuzzy = append(fuzzy, a)
		}
	}
	cands := exact
	if len(cands) == 0 {
		cands = fuzzy
	}
	bundles := map[string]bool{}
	for _, a := range cands {
		if r := s.Blocked(a.Name, a.BundleID); r != "" {
			return "", errf("blocked_app", "%s", r)
		}
		bundles[a.BundleID] = true
	}
	bundle := ""
	if len(bundles) == 1 {
		for b := range bundles {
			bundle = b
		}
	}
	return bundle, nil
}

// CheckApp：按名字找到正在运行的应用后判断能不能碰（名字 + bundle id）；能碰返回 nil
func (s *Service) CheckApp(ctx context.Context, name string) error {
	_, err := s.identify(ctx, name)
	return err
}

// CheckRef：ref 背后的应用：记下的 bundle id 也要过禁用规则，应用换了（同名的另一个应用）就拒绝
func (s *Service) CheckRef(ctx context.Context, info RefInfo) error {
	if r := s.Blocked(info.App, info.BundleID); r != "" {
		return errf("blocked_app", "%s", r)
	}
	b, err := s.identify(ctx, info.App)
	if err != nil {
		return err
	}
	if info.BundleID != "" && b != "" && !strings.EqualFold(b, info.BundleID) {
		return errf("STALE_REF", "「%s」已经不是读界面时的那个应用了", info.App)
	}
	return nil
}

// CheckScreen：整屏截图前检查：屏幕上有禁用应用的可见窗口就拒绝；能截返回 nil
func (s *Service) CheckScreen(ctx context.Context) error {
	data, err := s.call(ctx, 0, "", "list-windows")
	if err != nil {
		if CodeOf(err) == "stopped" {
			return err
		}
		return errf("unavailable", "无法确认屏幕上有哪些窗口（%v），不截整个屏幕：请指定 app", err)
	}
	var ws []struct {
		App       string `json:"app_name"`
		BundleID  string `json:"bundle_id"`
		PID       int    `json:"pid"`
		Visible   *bool  `json:"visible"`
		Minimized bool   `json:"minimized"`
	}
	if json.Unmarshal(data, &ws) != nil {
		return errf("unavailable", "无法确认屏幕上有哪些窗口，不截整个屏幕：请指定 app")
	}
	var byPID map[int]App
	for _, w := range ws {
		if w.Minimized || (w.Visible != nil && !*w.Visible) {
			continue
		}
		bundle := w.BundleID
		if bundle == "" && w.PID > 0 {
			if byPID == nil {
				byPID = map[int]App{}
				if apps, err := s.appsCached(ctx); err == nil {
					for _, a := range apps {
						byPID[a.PID] = a
					}
				}
			}
			bundle = byPID[w.PID].BundleID
		}
		if r := s.Blocked(w.App, bundle); r != "" {
			return errf("blocked_app", "屏幕上有不能读取的应用窗口，不截整个屏幕（%s）：请指定 app", r)
		}
		if bundle == "" {
			if err := s.CheckApp(ctx, w.App); err != nil {
				if CodeOf(err) == "blocked_app" {
					return errf("blocked_app", "屏幕上有不能读取的应用窗口，不截整个屏幕（%s）：请指定 app", err.(*Error).Message)
				}
				return err
			}
		}
	}
	return nil
}
