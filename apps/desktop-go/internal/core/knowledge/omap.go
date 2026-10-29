package knowledge

// omap：保持插入顺序的 map（对应 JS Map 的迭代语义：delete 后再 set 移到末尾）
type omap[V any] struct {
	keys []string
	live []bool
	idx  map[string]int
	val  map[string]V
	dead int
}

func newOmap[V any]() *omap[V] {
	return &omap[V]{idx: map[string]int{}, val: map[string]V{}}
}

func (o *omap[V]) Len() int { return len(o.val) }

func (o *omap[V]) Get(k string) (V, bool) { v, ok := o.val[k]; return v, ok }

func (o *omap[V]) Has(k string) bool { _, ok := o.val[k]; return ok }

func (o *omap[V]) Set(k string, v V) {
	if _, ok := o.val[k]; !ok {
		o.idx[k] = len(o.keys)
		o.keys = append(o.keys, k)
		o.live = append(o.live, true)
	}
	o.val[k] = v
}

func (o *omap[V]) Delete(k string) {
	i, ok := o.idx[k]
	if !ok {
		return
	}
	o.live[i] = false
	delete(o.idx, k)
	delete(o.val, k)
	o.dead++
	if o.dead > 64 && o.dead*2 > len(o.keys) {
		o.compact()
	}
}

func (o *omap[V]) compact() {
	nk := make([]string, 0, len(o.val))
	for i, k := range o.keys {
		if o.live[i] {
			o.idx[k] = len(nk)
			nk = append(nk, k)
		}
	}
	o.keys = nk
	o.live = make([]bool, len(nk))
	for i := range o.live {
		o.live[i] = true
	}
	o.dead = 0
}

// Each：按插入顺序遍历；回调返回 false 停止
func (o *omap[V]) Each(fn func(k string, v V) bool) {
	for i, k := range o.keys {
		if !o.live[i] {
			continue
		}
		if !fn(k, o.val[k]) {
			return
		}
	}
}

func (o *omap[V]) Keys() []string {
	out := make([]string, 0, len(o.val))
	o.Each(func(k string, _ V) bool { out = append(out, k); return true })
	return out
}

func (o *omap[V]) Values() []V {
	out := make([]V, 0, len(o.val))
	o.Each(func(_ string, v V) bool { out = append(out, v); return true })
	return out
}
