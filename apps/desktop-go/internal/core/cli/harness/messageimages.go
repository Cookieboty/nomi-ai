package harness

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"strings"
)

// normalizeImageEvent runs before folding so live text and final persisted text use
// the same stable asset URL rather than a temporary path or a megabyte data URL.
func (o *Orchestrator) normalizeImageEvent(tabID string, event *util.Obj) *util.Obj {
	if o.d.ImageStore == nil {
		return event
	}
	switch event.Get("type") {
	case "text", "text-delta", "done":
		tab := o.tab(tabID)
		if tab == nil {
			return event
		}
		old := util.Str(event.Get("text"))
		text := o.imageStoreFor(tabID).Markdown(old, str(tab, "backend"))
		if text != old {
			event = event.Clone()
			event.Set("text", text)
		}
	}
	return event
}

// Restore a CLI's user-image event without duplicating the user message already
// created when the same prompt was sent by this application.
func (o *Orchestrator) receiveUserImages(tabID string, event *util.Obj) {
	if tabID == MainTabID || o.d.ImageStore == nil {
		return
	}
	text := strings.TrimSpace(util.Str(event.Get("text")))
	if text != "" && shared.Injected(text) {
		return
	}
	refs, _ := event.Get("images").([]any)
	images := o.imageStoreFor(tabID).Images(refs, "user")
	if len(images) == 0 {
		return
	}
	list := o.TabMessages(tabID)
	source := util.Str(event.Get("sourceId"))
	var existing *util.Obj
	if source != "" {
		for i := len(list) - 1; i >= 0; i-- {
			msg := list[i]
			if msg != nil && msg.Get("role") == "user" && (msg.Get("cliSourceId") == source || msg.Get("id") == source) {
				existing = msg
				break
			}
		}
	}
	if existing == nil {
		for i := len(list) - 1; i >= 0; i-- {
			msg := list[i]
			if msg == nil || msg.Get("role") != "user" {
				continue
			}
			// Only an unbound local prompt can absorb its CLI echo. A different known
			// source ID with identical text still represents a distinct turn.
			if i == len(list)-1 && !strings.HasPrefix(util.Str(msg.Get("id")), "hist-") && msg.Get("cliSourceId") == nil && (text == "" || strings.TrimSpace(util.Str(msg.Get("content"))) == text) {
				existing = msg
			}
			break
		}
	}
	if existing != nil {
		if previous, ok := existing.Get("images").([]any); ok && len(previous) > 0 && existing.Get("cliSourceId") == nil {
			if source != "" {
				existing.Set("cliSourceId", source)
				o.persistMessages(tabID)
			}
			return
		}
		existing.Set("images", images)
		if text != "" {
			existing.Set("content", text)
		}
		if source != "" {
			existing.Set("cliSourceId", source)
		}
		o.persistMessages(tabID)
		o.post("harness.tabMessage", util.NewObj("tabId", tabID, "message", existing))
		return
	}
	message := util.NewObj("id", newMsgID(), "role", "user", "content", text, "images", images, "timestamp", nowMs())
	if source != "" {
		message.Set("cliSourceId", source)
	}
	o.appendMessage(tabID, message)
}

func (o *Orchestrator) imageStoreFor(tabID string) *cli.MessageImageStore {
	if o.d.ImageStore == nil {
		return nil
	}
	store := *o.d.ImageStore
	if tab := o.tab(tabID); tab != nil {
		store.Cwd = str(tab, "cwd")
	}
	return &store
}

// Reopening a running tab may recover bytes from the original transcript even
// after a legacy temporary path has expired. Enrich matched turns in place;
// preserve local IDs, message order, live output and newer turns.
func (o *Orchestrator) restoreHistoryImages(tabID string, raw any) {
	if o.d.ImageStore == nil {
		return
	}
	incoming, ok := raw.([]any)
	if !ok {
		return
	}
	history := seedMessages(incoming, nowMs)
	o.imageStoreFor(tabID).Messages(history, str(o.tab(tabID), "backend"))
	changed := false
	for _, current := range o.TabMessages(tabID) {
		if current == nil || current.Get("role") != "user" {
			continue
		}
		previous, _ := current.Get("images").([]any)
		complete := len(previous) > 0
		for _, image := range previous {
			if util.AsObj(image).Get("unavailable") == true {
				complete = false
			}
		}
		if complete {
			continue
		}
		for _, candidate := range history {
			if candidate.Get("role") != "user" || candidate.Get("timestamp") != current.Get("timestamp") || candidate.Get("content") != current.Get("content") {
				continue
			}
			images, _ := candidate.Get("images").([]any)
			usable := false
			for _, image := range images {
				if util.AsObj(image).Get("unavailable") != true {
					usable = true
				}
			}
			if !usable {
				continue
			}
			// Keep valid existing attachments if only part of the history was recovered.
			merged := append([]any{}, images...)
			for i, image := range previous {
				if util.AsObj(image).Get("unavailable") == true {
					continue
				}
				if i >= len(merged) {
					merged = append(merged, image)
				} else {
					merged[i] = image
				}
			}
			current.Set("images", merged)
			o.post("harness.tabMessage", util.NewObj("tabId", tabID, "message", current))
			changed = true
			break
		}
	}
	if changed {
		o.persistMessages(tabID)
	}
}
