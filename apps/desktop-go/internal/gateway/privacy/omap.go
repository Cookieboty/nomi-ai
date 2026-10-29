package privacy

// omap is a JS Map[string]V: insertion order, delete, re-set keeps position.
type omap[V any] struct {
	keys []string
	live []bool
	pos  map[string]int
	vals map[string]V
	n    int
}

func newOmap[V any]() *omap[V] { return &omap[V]{pos: map[string]int{}, vals: map[string]V{}} }

func (m *omap[V]) get(k string) (V, bool) { v, ok := m.vals[k]; return v, ok }
func (m *omap[V]) has(k string) bool     { _, ok := m.vals[k]; return ok }
func (m *omap[V]) size() int             { return m.n }

func (m *omap[V]) set(k string, v V) {
	if _, ok := m.vals[k]; !ok {
		m.pos[k] = len(m.keys)
		m.keys = append(m.keys, k)
		m.live = append(m.live, true)
		m.n++
	}
	m.vals[k] = v
}

func (m *omap[V]) del(k string) {
	i, ok := m.pos[k]
	if !ok {
		return
	}
	m.live[i] = false
	delete(m.pos, k)
	delete(m.vals, k)
	m.n--
	if len(m.keys) > 64 && m.n < len(m.keys)/2 {
		m.compact()
	}
}

func (m *omap[V]) compact() {
	keys := m.keys[:0:0]
	for i, k := range m.keys {
		if m.live[i] {
			m.pos[k] = len(keys)
			keys = append(keys, k)
		}
	}
	m.keys = keys
	m.live = make([]bool, len(keys))
	for i := range m.live {
		m.live[i] = true
	}
}

func (m *omap[V]) clear() { *m = *newOmap[V]() }

// each visits live entries in order; entries deleted during the visit are
// skipped and entries added are visited (JS Map iteration semantics).
func (m *omap[V]) each(f func(k string, v V) bool) {
	for i := 0; i < len(m.keys); i++ {
		if !m.live[i] {
			continue
		}
		k := m.keys[i]
		if !f(k, m.vals[k]) {
			return
		}
	}
}

// ordered snapshot of keys
func (m *omap[V]) list() []string {
	out := make([]string, 0, m.n)
	m.each(func(k string, _ V) bool { out = append(out, k); return true })
	return out
}
