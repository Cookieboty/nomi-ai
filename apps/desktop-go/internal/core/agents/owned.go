package agents

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Nomi 自己的编程助手会话：标签用过的 CLI 会话 id（「backend:会话 id」）。
//
// 本机会话文件里认出的会话，凡是 Nomi 标签用过的都不算「外部」：标签关掉、会话 id 被换掉（出错重开、换目录、
// 分叉）之后，同一个会话文件仍是 Nomi 派出去的，不能再以「终端 · 只读」出现一次。只看当前开着的标签不够，
// 所以记下见过的全部 id，落盘（重启后会话文件还在），超过 ownedKeepMs 没再见到的丢掉。

const ownedKeepMs = 30 * 24 * 3600 * 1000

// ownedFlushMs：老 id 一直在用时多久把「最后见到」写回盘一次。保留期从最后见到算，只在出现新 id 时写盘的话，
// 一直用同一个会话的标签落盘时间停在首次登记，关掉标签重启后会被提前丢掉（#315）。按小时写，盘上最多落后一小时
const ownedFlushMs = 3600 * 1000

func (s *Service) ownedFile() string {
	if s.d.Root == "" {
		return ""
	}
	return filepath.Join(s.d.Root, "owned-sessions.json")
}

func (s *Service) loadOwned() {
	s.owned = map[string]float64{}
	p := s.ownedFile()
	if p == "" {
		return
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var m map[string]float64
	if json.Unmarshal(b, &m) == nil {
		now := s.now()
		for k, at := range m {
			if now-at < ownedKeepMs {
				s.owned[k] = at
			}
		}
	}
}

// rememberOwned：记下标签当前的会话 id；有新的立刻写盘，老的「最后见到」每 ownedFlushMs 写一次
func (s *Service) rememberOwned(tabs []*util.Obj) {
	if s.owned == nil {
		s.owned = map[string]float64{}
	}
	now := s.now()
	added, seen := false, false
	for _, t := range tabs {
		if !truthy(t.Get("cliSessionId")) {
			continue
		}
		k := util.JSString(t.Get("backend")) + ":" + util.JSString(t.Get("cliSessionId"))
		if _, ok := s.owned[k]; !ok {
			added = true
		}
		s.owned[k] = now
		seen = true
	}
	if !added && !(seen && now-s.ownedSavedAt >= ownedFlushMs) {
		return
	}
	for k, at := range s.owned {
		if now-at >= ownedKeepMs {
			delete(s.owned, k)
		}
	}
	if p := s.ownedFile(); p != "" {
		if b, err := json.Marshal(s.owned); err == nil && os.WriteFile(p, b, 0o666) == nil {
			s.ownedSavedAt = now // 写失败不记，下一次观测再试
		}
	}
}

// ownedBy：这个会话（「backend:会话 id」）是不是 Nomi 标签用过的
func (s *Service) ownedBy(id string) bool {
	_, ok := s.owned[id]
	return ok
}
