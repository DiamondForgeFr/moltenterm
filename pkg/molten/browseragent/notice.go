// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// What the user did with a session's tabs reaches the agent (#971, FR-BRW-008, FR-BRW-011): MCP has no message from
// the server to the model, so each notice rides on the agent's next tool result, once, and tabs_context marks the tab
// until then.

const (
	noteSharedJustNow = "shared just now"
	noteGivenBack     = "given back"

	// A session that makes no call does not pile notices up.
	maxNotices = 20
)

func sharedNotice(tabId int64, site string) string {
	where := ""
	if site != "" {
		where = " (" + site + ")"
	}
	return fmt.Sprintf("Notice from MoltenTerm: the user shared tab %d%s with you. It is yours to use now: act on tab %d "+
		"rather than opening another tab for the same page.", tabId, where, tabId)
}

func givenBackNotice(tabId int64) string {
	return fmt.Sprintf("Notice from MoltenTerm: the user gave tab %d back to you. You can act on it again.", tabId)
}

// addNotice keeps one notice per tab: the latest says what holds now.
func (s *session) addNotice(tabId int64, note string, text string) {
	kept := s.notices[:0]
	for _, n := range s.notices {
		if n.tabId != tabId {
			kept = append(kept, n)
		}
	}
	kept = append(kept, tabNotice{tabId: tabId, note: note, text: text})
	if len(kept) > maxNotices {
		kept = kept[len(kept)-maxNotices:]
	}
	s.notices = kept
}

// tabNote is the note tabs_context shows on a tab, "" when there is none.
func (m *Manager) tabNote(sessionId string, tabId int64) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return ""
	}
	for _, n := range s.notices {
		if n.tabId == tabId {
			return n.note
		}
	}
	return ""
}

func (m *Manager) takeNotices(sessionId string) []tabNotice {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil || len(s.notices) == 0 {
		return nil
	}
	rtn := s.notices
	s.notices = nil
	return rtn
}

// withNotices adds the session's pending notices to a tool result, as text items of their own after the result's
// content, so the result's own first sentence stays what it was.
func (m *Manager) withNotices(sessionId string, result mcpbrowser.CallResult) mcpbrowser.CallResult {
	for _, n := range m.takeNotices(sessionId) {
		result.Content = append(result.Content, mcpbrowser.ContentItem{Type: mcpbrowser.ContentText, Text: n.text})
	}
	return result
}
