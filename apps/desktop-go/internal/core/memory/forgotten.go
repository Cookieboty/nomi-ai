package memory

// forgotten.go：用户删掉的记忆不会被悄悄找回来。
// - 删一段情景摘要：从它提炼出的事实（Source = distilled、EpisodeID 指向它）一起删掉，
//   AI 门面里的摘要与事实也删掉；之后再提炼这段对话时只看删除之后的新消息。
// - 删一条事实（或随摘要一起删的）：记下它的文字，之后提炼出近似重复的不再加回。
// - 用户自己再写一条同样的事实：以用户为准，从「已忘记」里拿掉。
// 已经发给模型的请求撤不回；这里保证之后的召回与提炼不再用到它们。

const forgottenFactsCap = 500

// Forgotten：落在 memory.json 里
type Forgotten struct {
	// Facts：删掉的事实文字（新的在后，最多 forgottenFactsCap 条）
	Facts []string `json:"facts,omitempty"`
	// Conversations：删掉了摘要的对话 → 删除时已经提炼到第几条消息（对话里用户与助手的消息计数）；
	// 之后只从更新的消息提炼
	Conversations map[string]int `json:"conversations,omitempty"`
}

func (f *Forgotten) addFact(text string) {
	if text == "" || f.hasFact(text) {
		return
	}
	f.Facts = append(f.Facts, text)
	if over := len(f.Facts) - forgottenFactsCap; over > 0 {
		f.Facts = append([]string{}, f.Facts[over:]...)
	}
}

func (f *Forgotten) hasFact(text string) bool {
	for _, x := range f.Facts {
		if IsDuplicateFact(x, text) {
			return true
		}
	}
	return false
}

func (f *Forgotten) unforgetFact(text string) {
	out := f.Facts[:0]
	for _, x := range f.Facts {
		if !IsDuplicateFact(x, text) {
			out = append(out, x)
		}
	}
	f.Facts = out
}

func (f *Forgotten) markConversation(id string, count int) {
	if id == "" {
		return
	}
	if f.Conversations == nil {
		f.Conversations = map[string]int{}
	}
	if count > f.Conversations[id] {
		f.Conversations[id] = count
	}
}

// since：对话里删除之后的新消息；offset = 前面跳过了几条
func (f *Forgotten) since(id string, all []TurnMsg) (rest []TurnMsg, offset int) {
	n, ok := f.Conversations[id]
	if !ok || n <= 0 {
		return all, 0
	}
	if n >= len(all) {
		return nil, len(all)
	}
	return all[n:], n
}

// forgetEpisodeLocked：删掉摘要 e 时连带要做的（调用方持锁，删摘要本身由调用方做）；返回删掉的事实 id
func (s *Service) forgetEpisodeLocked(e Episode) []string {
	var removed []string
	kept := s.data.Facts[:0]
	for _, f := range s.data.Facts {
		if f.EpisodeID == e.ID && f.Source == "distilled" {
			removed = append(removed, f.ID)
			s.data.Forgotten.addFact(f.Text)
			continue
		}
		kept = append(kept, f)
	}
	s.data.Facts = kept
	s.data.Forgotten.markConversation(e.ConversationID, e.Since+e.MessageCount)
	return removed
}
