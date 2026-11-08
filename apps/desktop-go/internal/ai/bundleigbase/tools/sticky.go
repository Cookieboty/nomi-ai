package tools

// sticky.go：按需提供的东西（工具定义、系统提示里的规则）在一个对话里开过就一直提供。
// 门控看的对话文字只取最近 2 万字，压缩后较早的内容换成了摘要：之前提过的事滑出去，工具 / 规则就会消失，
// 工具定义或系统提示一变，前缀缓存整段失效（Anthropic 的缓存前缀是 工具 → 系统提示 → 消息）。
// 只在进程内记（重启后第一轮按当时的对话文字重新判断）；按对话最近使用淘汰，最多 StickyMaxConversations 个。

import "sync"

const StickyMaxConversations = 500

type stickyStore struct {
	mu    sync.Mutex
	open  map[string]map[string]bool
	order []string // 最近用过的对话在后
}

var sticky = &stickyStore{open: map[string]map[string]bool{}}

// Sticky：对话 conv 里 key（工具名或规则名）这一轮用不用得上：now = 这一轮按文字判断的结果；
// 之前开过就一直为 true。conv 为空（没有对话 id）时原样返回 now。
func Sticky(conv, key string, now bool) bool {
	if conv == "" {
		return now
	}
	sticky.mu.Lock()
	defer sticky.mu.Unlock()
	set := sticky.open[conv]
	if set == nil {
		if !now {
			return false
		}
		set = map[string]bool{}
		sticky.open[conv] = set
	}
	sticky.touch(conv)
	if now {
		set[key] = true
		return true
	}
	return set[key]
}

func (s *stickyStore) touch(conv string) {
	for i, c := range s.order {
		if c == conv {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	s.order = append(s.order, conv)
	for len(s.order) > StickyMaxConversations {
		delete(s.open, s.order[0])
		s.order = s.order[1:]
	}
}

// resetSticky：测试用
func resetSticky() {
	sticky.mu.Lock()
	sticky.open, sticky.order = map[string]map[string]bool{}, nil
	sticky.mu.Unlock()
}
