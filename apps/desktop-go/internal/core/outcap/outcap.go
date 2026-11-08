// Package outcap：命令 / 代码输出的上限缓冲：超过上限时保留开头与结尾，中间省略。
// 命令、测试的要紧信息常在结尾（报错、失败的用例、退出前的提示），只留开头会把它们丢掉。
// 长度按 UTF-16 码元计（与视图、工具结果的截断同一口径）。
package outcap

import (
	"fmt"
	"unicode/utf16"
)

// HeadShare：上限里留给开头的比例（其余给结尾）
const HeadShare = 4

type Buf struct {
	head, tail       []uint16
	headCap, tailCap int
	dropped          int
	// Truncated：超过了上限（中间有省略）
	Truncated bool
}

// New：总上限 total 个码元，开头 total/HeadShare，结尾其余
func New(total int) *Buf {
	if total < 2 {
		total = 2
	}
	h := total / HeadShare
	if h < 1 {
		h = 1
	}
	return &Buf{headCap: h, tailCap: total - h}
}

func (b *Buf) Add(s string) {
	u := utf16.Encode([]rune(s))
	if n := b.headCap - len(b.head); n > 0 {
		if n > len(u) {
			n = len(u)
		}
		b.head = append(b.head, u[:n]...)
		u = u[n:]
	}
	if len(u) == 0 {
		return
	}
	b.tail = append(b.tail, u...)
	if over := len(b.tail) - b.tailCap; over > 0 {
		b.tail = append(b.tail[:0], b.tail[over:]...)
		b.dropped += over
		b.Truncated = true
	}
}

// String：开头 + 省略说明 + 结尾；没超上限时原样拼接
func (b *Buf) String() string {
	if b.dropped == 0 {
		return string(utf16.Decode(b.head)) + string(utf16.Decode(b.tail))
	}
	return string(utf16.Decode(b.head)) + fmt.Sprintf("\n…[输出过长，中间省略 %d 字]…\n", b.dropped) + string(utf16.Decode(b.tail))
}
