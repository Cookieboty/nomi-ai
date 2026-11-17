package wailsshell

import "testing"

// fakeTree：浏览器视图的父子关系（Windows 是 HWND 的父链，macOS 是 NSView 的 superview 链，
// 两者在「焦点在不在这个子树里」这件事上是同一个形状）
var fakeTree = map[uintptr]uintptr{
	7:  2, // 网页内容控件 → WebView2 子窗口
	2:  1, // WebView2 子窗口 → 对话窗口客户区
	9:  3, // 频道输入框：网页内部再嵌一层
	3:  7,
	5:  1,  // 对话页面自己的控件
	11: 10, // 另一个窗口里的控件
}

// 直接测 browserHoldsKeyboardFocus，只把「父控件是谁」换成上面的假树
func fakeFocus(active bool, child, focused uintptr) bool {
	return browserHoldsKeyboardFocus(active, child, focused, func(n uintptr) uintptr { return fakeTree[n] })
}

func TestBrowserHoldsKeyboardFocusNeedsTheActiveWindow(t *testing.T) {
	// 焦点在网页里，但整个应用在后台：藏 / 关浏览器时不该抢别的应用的键盘
	if fakeFocus(false, 2, 7) {
		t.Fatal("not the active window: must not steal focus")
	}
}

func TestBrowserHoldsKeyboardFocusCoversTheWholeSubtree(t *testing.T) {
	for _, focused := range []uintptr{2, 7, 9} {
		if !fakeFocus(true, 2, focused) {
			t.Fatalf("focus %d is inside the browser view: want true", focused)
		}
	}
}

func TestBrowserHoldsKeyboardFocusLeavesTheChatPageAlone(t *testing.T) {
	for _, focused := range []uintptr{1, 5, 11, 0} {
		if fakeFocus(true, 2, focused) {
			t.Fatalf("focus %d is not inside the browser view: want false", focused)
		}
	}
}

func TestBrowserHoldsKeyboardFocusWithoutAView(t *testing.T) {
	// 载体还没建好 / 已经释放：没有可收拾的焦点
	if fakeFocus(true, 0, 0) || fakeFocus(true, 0, 7) {
		t.Fatal("no browser view: want false")
	}
}

func TestDescendantOfStopsOnBrokenParentChains(t *testing.T) {
	// 父链成环（控件在销毁途中可能这样）时不能死循环
	cycles := map[uintptr]uintptr{1: 2, 2: 1, 3: 3}
	for _, node := range []uintptr{1, 2, 3, 4} {
		if descendantOf(node, 99, func(n uintptr) uintptr { return cycles[n] }) {
			t.Fatalf("cycle at %d reported as a descendant", node)
		}
	}
	// 顺着真实父子关系一路往上找得到
	if !descendantOf(9, 2, func(n uintptr) uintptr { return fakeTree[n] }) {
		t.Fatal("9 → 7 → 2 is a descendant of 2")
	}
}
