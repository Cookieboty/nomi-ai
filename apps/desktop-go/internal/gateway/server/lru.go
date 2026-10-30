package server

import "container/list"

// lru is a JS Map used as an LRU: insertion-ordered, delete+set moves to end.
type lru[V any] struct {
	l *list.List
	m map[string]*list.Element
}

type lruEnt[V any] struct {
	k string
	v V
}

func newLRU[V any]() *lru[V] { return &lru[V]{l: list.New(), m: map[string]*list.Element{}} }

func (c *lru[V]) get(k string) (V, bool) {
	if e, ok := c.m[k]; ok {
		return e.Value.(*lruEnt[V]).v, true
	}
	var z V
	return z, false
}

// set is map.set: an existing key keeps its position.
func (c *lru[V]) set(k string, v V) {
	if e, ok := c.m[k]; ok {
		e.Value.(*lruEnt[V]).v = v
		return
	}
	c.m[k] = c.l.PushBack(&lruEnt[V]{k, v})
}

func (c *lru[V]) del(k string) bool {
	if e, ok := c.m[k]; ok {
		c.l.Remove(e)
		delete(c.m, k)
		return true
	}
	return false
}

func (c *lru[V]) size() int { return len(c.m) }

// oldest is map.keys().next().value.
func (c *lru[V]) oldest() (string, bool) {
	if e := c.l.Front(); e != nil {
		return e.Value.(*lruEnt[V]).k, true
	}
	return "", false
}

// each iterates in insertion order (safe against deleting the current entry).
func (c *lru[V]) each(f func(k string, v V) bool) {
	for e := c.l.Front(); e != nil; {
		n := e.Next()
		x := e.Value.(*lruEnt[V])
		if !f(x.k, x.v) {
			return
		}
		e = n
	}
}
