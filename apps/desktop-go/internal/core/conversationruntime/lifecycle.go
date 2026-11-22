package conversationruntime

import "errors"

var ErrRetired = errors.New("conversationruntime: actor retired; reopen required")

// Interrupt fences live work without claiming that external side effects were undone.
func (c *Session) Interrupt(detail string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if a := c.active; a != nil && !c.idleLocked(false) {
		c.uncertainLocked(a, detail)
	}
}

// Retire serializes delete with admission; sink publishes tombstone+checkpoint.
func (c *Session) Retire(sink func(Checkpoint) error) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.idleLocked(false) {
		return ErrBusy
	}
	c.generation++
	err := sink(c.snapshotLocked())
	c.storageErr = ErrRetired
	if c.active != nil {
		c.active.cancel()
	}
	return err
}

func (c *Session) NeedsRuntime() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.target.Runtime == nil
}
