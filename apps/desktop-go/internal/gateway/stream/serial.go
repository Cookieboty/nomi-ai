package stream

// SerialBlock is SerialBlock (serial.ts). ID / Name are nil for text blocks.
type SerialBlock struct {
	Kind    string // "text" | "tool"
	Key     string
	ID      *string
	Name    *string
	Content string
	Opened  bool
	Ended   bool
	Closed  bool
}

// SerialSink is SerialSink.
type SerialSink struct {
	Open  func(b *SerialBlock) string
	Delta func(b *SerialBlock, d string) string
	Close func(b *SerialBlock) string
}

// SerialBlocks keeps at most one downstream block open; others queue.
type SerialBlocks struct {
	active *SerialBlock
	queue  []*SerialBlock
	tools  map[string]*SerialBlock
	sink   SerialSink
}

// NewSerialBlocks creates the scheduler.
func NewSerialBlocks(sink SerialSink) *SerialBlocks {
	return &SerialBlocks{tools: map[string]*SerialBlock{}, sink: sink}
}

func (s *SerialBlocks) Text(t string) string {
	if t == "" {
		return ""
	}
	if s.active != nil && s.active.Kind == "text" {
		s.active.Content += t
		return s.sink.Delta(s.active, t)
	}
	if n := len(s.queue); n > 0 && s.queue[n-1].Kind == "text" && !s.queue[n-1].Ended {
		s.queue[n-1].Content += t
		return ""
	}
	b := &SerialBlock{Kind: "text", Content: t}
	return s.enqueue(b)
}

func (s *SerialBlocks) ToolStart(key, id, name string) string {
	out := ""
	if s.active != nil && s.active.Kind == "text" {
		out = s.endBlock(s.active)
	}
	b := &SerialBlock{Kind: "tool", Key: key, ID: &id, Name: &name}
	s.tools[key] = b
	for _, q := range s.queue {
		if q.Kind == "text" {
			q.Ended = true
		}
	}
	return out + s.enqueue(b)
}

func (s *SerialBlocks) ToolArgs(key, delta string) string {
	b := s.tools[key]
	if b == nil || b.Closed || b.Ended || delta == "" {
		return ""
	}
	b.Content += delta
	if b.Opened {
		return s.sink.Delta(b, delta)
	}
	return ""
}

func (s *SerialBlocks) ToolEnd(key string) string {
	b := s.tools[key]
	if b == nil || b.Ended {
		return ""
	}
	return s.endBlock(b)
}

func (s *SerialBlocks) Finish() string {
	for _, q := range s.queue {
		q.Ended = true
	}
	if s.active != nil {
		return s.endBlock(s.active)
	}
	return ""
}

func (s *SerialBlocks) enqueue(b *SerialBlock) string {
	if s.active != nil || len(s.queue) > 0 {
		s.queue = append(s.queue, b)
		return ""
	}
	return s.activate(b)
}

func (s *SerialBlocks) activate(b *SerialBlock) string {
	s.active = b
	b.Opened = true
	out := s.sink.Open(b)
	if b.Content != "" {
		out += s.sink.Delta(b, b.Content)
	}
	if b.Ended {
		out += s.closeActive()
	}
	return out
}

func (s *SerialBlocks) endBlock(b *SerialBlock) string {
	if b.Ended && b.Closed {
		return ""
	}
	b.Ended = true
	if s.active == b {
		return s.closeActive()
	}
	return ""
}

func (s *SerialBlocks) closeActive() string {
	b := s.active
	if b == nil {
		return ""
	}
	s.active = nil
	b.Closed = true
	out := s.sink.Close(b)
	if len(s.queue) > 0 {
		next := s.queue[0]
		s.queue = s.queue[1:]
		out += s.activate(next)
	}
	return out
}
