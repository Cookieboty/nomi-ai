package harness

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"

// ordMap 复刻 JS Map 的插入序语义：Set 已有键保持原位，Delete 后再 Set 排到末尾；
// Keys() 返回当前插入序快照（对应 `[...map.keys()]`）。
type ordMap[V any] struct {
	m     map[string]V
	order []string
}

func newOrdMap[V any]() *ordMap[V] { return &ordMap[V]{m: map[string]V{}} }

func (o *ordMap[V]) Get(k string) V { return o.m[k] }

func (o *ordMap[V]) Has(k string) bool { _, ok := o.m[k]; return ok }

func (o *ordMap[V]) Len() int { return len(o.m) }

func (o *ordMap[V]) Set(k string, v V) {
	if _, ok := o.m[k]; !ok {
		o.order = append(o.order, k)
	}
	o.m[k] = v
}

func (o *ordMap[V]) Delete(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	o.order = removeS(o.order, k)
}

func (o *ordMap[V]) Keys() []string { return append([]string{}, o.order...) }

// ioAsync 复刻 `await fs.promises.*`：fn 在锁外线程池执行（不得触碰 jsrt 状态），
// 结果在之后的宏任务里交付——等待期间事件循环照常运行（其它标签可在此间开跑），
// 与 Node 的 libuv 线程池 I/O 让出语义一致。
func ioAsync[T any](fn func() T) *jsrt.Promise[T] {
	p := jsrt.NewPromise[T]()
	go func() {
		v := fn()
		jsrt.Run(func() { p.Resolve(v) })
	}()
	return p
}
