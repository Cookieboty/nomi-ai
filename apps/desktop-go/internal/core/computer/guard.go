package computer

import (
	"regexp"
	"strings"
)

// 安全判定（纯函数）：哪些应用不能碰、哪些动作执行前必须让用户逐次确认。

// blockedApps：密码管理器、钥匙串、银行 / 支付类应用，默认一律拒绝（读界面也不行：里面就是隐私）
var blockedApps = regexp.MustCompile(`(?i)` + strings.Join([]string{
	`1password`, `bitwarden`, `keepass`, `lastpass`, `dashlane`, `enpass`, `proton ?pass`, `nordpass`, `roboform`, `keeper`,
	`keychain`, `钥匙串`, `^passwords?$`, `^密码$`, `credential manager`, `凭据管理器`, `seahorse`, `kwallet`,
	`bank`, `银行`, `alipay`, `支付宝`, `paypal`, `wallet`, `钱包`, `云闪付`, `银联`, `证券`, `brokerage`,
}, "|"))

// blockedBundles：bundle id 前缀（名字可能被本地化）
var blockedBundles = []string{
	"com.apple.keychainaccess", "com.apple.Passwords", "com.agilebits.", "com.bitwarden.", "com.lastpass.",
	"com.dashlane.", "org.keepassxc.", "com.alipay.",
}

// BlockedApp：这个应用不让碰时返回原因
func BlockedApp(name, bundleID string, self func(name, bundleID string) bool) string {
	if self != nil && self(name, bundleID) {
		return "不能操作 Nomi 自己的窗口"
	}
	for _, p := range blockedBundles {
		if bundleID != "" && strings.HasPrefix(strings.ToLower(bundleID), strings.ToLower(p)) {
			return "「" + name + "」是密码 / 支付类应用，出于安全考虑不能操作"
		}
	}
	if blockedApps.MatchString(strings.TrimSpace(name)) {
		return "「" + name + "」是密码 / 支付类应用，出于安全考虑不能操作"
	}
	return ""
}

// sensitiveName：元素名里带这些词 = 付款、发送、删除、提交这类不可撤回的动作
var sensitiveName = regexp.MustCompile(`(?i)` + strings.Join([]string{
	`付款`, `支付`, `付钱`, `购买`, `下单`, `结算`, `转账`, `充值`, `提现`, `确认订单`,
	`发送`, `发布`, `发表`, `回复全部`, `提交`, `删除`, `移除`, `清空`, `抹掉`, `格式化`, `卸载`, `注销`, `退出登录`, `重置`,
	`\bpay\b`, `payment`, `purchase`, `\bbuy\b`, `checkout`, `place order`, `transfer`, `send`, `post\b`, `publish`, `submit`,
	`delete`, `remove`, `erase`, `empty trash`, `uninstall`, `sign out`, `log out`, `reset`, `format (disk|drive)`,
}, "|"))

// settingsApp：系统设置类应用里的改动一律确认
var settingsApp = regexp.MustCompile(`(?i)^(system settings|system preferences|系统设置|系统偏好设置|settings|设置|control panel|控制面板)$`)

// sensitiveCombos：发送（cmd/ctrl+return）、删除（cmd+backspace / shift+delete）、退出 / 关闭
var sensitiveCombos = map[string]bool{
	"cmd+return": true, "ctrl+return": true, "meta+return": true, "cmd+enter": true, "ctrl+enter": true, "meta+enter": true,
	"cmd+delete": true, "meta+delete": true, "cmd+backspace": true, "meta+backspace": true, "shift+delete": true,
	"cmd+shift+delete": true, "meta+shift+delete": true, "cmd+q": true, "meta+q": true, "alt+f4": true,
	// 退出 / 关闭窗口（Linux、Windows 用 Ctrl；macOS 的 ⌘W）
	"ctrl+q": true, "ctrl+w": true, "ctrl+shift+w": true, "cmd+w": true, "meta+w": true, "cmd+shift+w": true,
	"ctrl+f4": true,
}

// NormalizeCombo：与 agent-desktop 一致（小写、去空格），并把别名统一成 cmd / ctrl / alt
func NormalizeCombo(c string) string {
	c = strings.ToLower(strings.ReplaceAll(c, " ", ""))
	parts := strings.Split(c, "+")
	for i, p := range parts {
		switch p {
		case "command", "super", "win":
			parts[i] = "cmd"
		case "control":
			parts[i] = "ctrl"
		case "option":
			parts[i] = "alt"
		case "enter":
			if i == len(parts)-1 {
				parts[i] = "return"
			}
		}
	}
	return strings.Join(parts, "+")
}

// SensitiveAction：需要逐次确认时返回原因（"" = 普通动作，按工具的权限策略走）
func SensitiveAction(kind string, ref *RefInfo, app, combo string) string {
	if ref != nil && app == "" {
		app = ref.App
	}
	if settingsApp.MatchString(strings.TrimSpace(app)) && kind != "scroll" {
		return "系统设置里的改动"
	}
	switch kind {
	case "click", "set_value", "type":
		if ref != nil && sensitiveName.MatchString(ref.Name) {
			return "「" + ref.Name + "」可能是付款、发送、删除或提交这类不可撤回的操作"
		}
		// 只有图标、没有名字的按钮：看不出点了会做什么（发送按钮常常就是这样），按敏感动作每次确认
		if kind == "click" && ref != nil && strings.TrimSpace(ref.Name) == "" && clickableRole(ref.Role) {
			return "这个" + ref.Role + "没有名字，看不出点了会做什么（可能是发送、删除这类操作）"
		}
	case "press":
		n := NormalizeCombo(combo)
		if sensitiveCombos[n] {
			return "快捷键 " + combo + " 可能会发送、删除或退出应用"
		}
		// 光按回车：常常就是「发送 / 提交」
		if n == "return" {
			return "回车可能会发送或提交当前内容"
		}
	}
	return ""
}

// secretRole：密码框（值不交给模型）
func secretRole(role string) bool {
	r := strings.ToLower(role)
	return strings.Contains(r, "secure") || strings.Contains(r, "password")
}

// clickableRole：会触发动作的元素（按钮、链接、菜单项）
func clickableRole(role string) bool {
	r := strings.ToLower(role)
	return strings.Contains(r, "button") || strings.Contains(r, "link") || strings.Contains(r, "menuitem")
}
