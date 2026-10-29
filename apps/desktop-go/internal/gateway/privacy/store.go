package privacy

import u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// MinKnown is MIN_KNOWN.
const MinKnown = 8

// MaxValues is MAX_VALUES.
const MaxValues = 200_000

const bitsN = 1 << 16
const smallIndex = 64

// Entry is {value, kind}.
type Entry struct {
	Value string
	Kind  string
	units u.Units
}

type assigned struct{ p, kind string }

func hash4(s u.Units, i int) int {
	return ((((int(s[i])*31+int(s[i+1]))*31+int(s[i+2]))*31 + int(s[i+3])) & (bitsN - 1))
}

// SecretStore is SecretStore.
type SecretStore struct {
	key           string
	shape         bool
	byValue       *omap[assigned]
	byPlaceholder *omap[string]
	pinned        []*Entry
	index         *omap[[]*Entry]
	bits          [bitsN / 32]uint32
	maxValues     int
}

// NewSecretStore is new SecretStore({maxValues}); no argument means the default.
func NewSecretStore(max ...int) *SecretStore {
	maxValues := MaxValues
	if len(max) > 0 {
		maxValues = max[0]
	}
	return &SecretStore{byValue: newOmap[assigned](), byPlaceholder: newOmap[string](), index: newOmap[[]*Entry](), maxValues: maxValues}
}

// SetKey is setKey.
func (s *SecretStore) SetKey(key string) {
	if key == s.key {
		return
	}
	s.key = key
	s.Clear()
}

// SetShape is setShape.
func (s *SecretStore) SetShape(on bool) {
	if on == s.shape {
		return
	}
	s.shape = on
	s.Clear()
}

// Clear is clear.
func (s *SecretStore) Clear() {
	s.byValue.clear()
	s.byPlaceholder.clear()
	s.reindex()
}

// SetKnown is setKnown.
func (s *SecretStore) SetKnown(list []Entry) {
	seen := map[string]bool{}
	s.pinned = nil
	for _, e := range list {
		us := u.ToUnits(e.Value)
		if len(us) < MinKnown || seen[e.Value] {
			continue
		}
		seen[e.Value] = true
		s.pinned = append(s.pinned, &Entry{Value: e.Value, Kind: e.Kind, units: us})
	}
	s.reindex()
}

// Size is size.
func (s *SecretStore) Size() int { return s.byValue.size() }

// Assign is assign.
func (s *SecretStore) Assign(kind, value string) string {
	if had, ok := s.byValue.get(value); ok {
		return had.p
	}
	if s.byValue.size() >= s.maxValues {
		s.evict()
	}
	shaped, okShape := "", false
	if s.shape {
		shaped, okShape = ShapeOf(s.key, kind, value)
	}
	var p string
	if okShape && !s.byPlaceholder.has(shaped) {
		p = shaped
	} else {
		tag := TagOf(s.key, kind, value)
		n := 1
		p = PlaceholderOf(kind, tag, 1)
		for {
			v, ok := s.byPlaceholder.get(p)
			if !ok || v == value {
				break
			}
			n++
			p = PlaceholderOf(kind, tag, n)
		}
	}
	s.byValue.set(value, assigned{p, kind})
	s.byPlaceholder.set(p, value)
	if us := u.ToUnits(value); len(us) >= MinKnown {
		s.add(&Entry{Value: value, Kind: kind, units: us})
	}
	return p
}

// ValueOf is valueOf.
func (s *SecretStore) ValueOf(placeholder string) (string, bool) { return s.byPlaceholder.get(placeholder) }

// Find is find.
func (s *SecretStore) Find(str string) []SecretSpan { return s.findUnits(u.ToUnits(str)) }

func (s *SecretStore) findUnits(us u.Units) []SecretSpan {
	if s.index.size() == 0 || len(us) < MinKnown {
		return []SecretSpan{}
	}
	if s.index.size() <= smallIndex {
		return s.findSmall(us)
	}
	return s.findScan(us)
}

func startsWith(s u.Units, p u.Units, i int) bool {
	if i+len(p) > len(s) {
		return false
	}
	for k, c := range p {
		if s[i+k] != c {
			return false
		}
	}
	return true
}

func indexOf(s, p u.Units, from int) int {
	for i := from; i+len(p) <= len(s); i++ {
		if startsWith(s, p, i) {
			return i
		}
	}
	return -1
}

func best(us u.Units, list []*Entry, i int) *Entry {
	var b *Entry
	for _, e := range list {
		if (b == nil || len(e.units) > len(b.units)) && startsWith(us, e.units, i) {
			b = e
		}
	}
	return b
}

func (s *SecretStore) findSmall(us u.Units) []SecretSpan {
	hits := []SecretSpan{}
	s.index.each(func(prefix string, list []*Entry) bool {
		pu := u.ToUnits(prefix)
		for i := indexOf(us, pu, 0); i >= 0; i = indexOf(us, pu, i+1) {
			if b := best(us, list, i); b != nil {
				hits = append(hits, SecretSpan{i, i + len(b.units), b.Kind, "known"})
			}
		}
		return true
	})
	if len(hits) < 2 {
		return hits
	}
	return MergeSpans(hits)
}

func (s *SecretStore) findScan(us u.Units) []SecretSpan {
	out := []SecretSpan{}
	last := len(us) - MinKnown
	for i := 0; i <= last; i++ {
		h := hash4(us, i)
		if s.bits[h>>5]&(1<<(h&31)) == 0 {
			continue
		}
		list, ok := s.index.get(u.FromUnits(us[i : i+MinKnown]))
		if !ok {
			continue
		}
		b := best(us, list, i)
		if b == nil {
			continue
		}
		out = append(out, SecretSpan{i, i + len(b.units), b.Kind, "known"})
		i += len(b.units) - 1
	}
	return out
}

func (s *SecretStore) add(e *Entry) {
	k := u.FromUnits(e.units[:MinKnown])
	if list, ok := s.index.get(k); ok {
		for _, x := range list {
			if x.Value == e.Value {
				goto bits
			}
		}
		s.index.set(k, append(list, e))
	} else {
		s.index.set(k, []*Entry{e})
	}
bits:
	h := hash4(e.units, 0)
	s.bits[h>>5] |= 1 << (h & 31)
}

func (s *SecretStore) reindex() {
	s.index.clear()
	s.bits = [bitsN / 32]uint32{}
	for _, e := range s.pinned {
		s.add(e)
	}
	s.byValue.each(func(value string, a assigned) bool {
		if us := u.ToUnits(value); len(us) >= MinKnown {
			s.add(&Entry{Value: value, Kind: a.kind, units: us})
		}
		return true
	})
}

func (s *SecretStore) evict() {
	n := 0
	half := s.maxValues / 2
	for _, value := range s.byValue.list() {
		a, _ := s.byValue.get(value)
		s.byValue.del(value)
		s.byPlaceholder.del(a.p)
		n++
		if n >= half {
			break
		}
	}
	s.reindex()
}
