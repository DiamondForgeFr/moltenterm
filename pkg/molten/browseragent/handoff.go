// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"net/url"
	"sync"
)

// A handoff between agents (FR-CONT-015, pkg/molten/agenthandoff) may name one of the sender's browser tabs by its tab
// id: the brief carries the page's address and title, and the receiver opens it in its own panel. Nothing is shared:
// the tab stays the sender's (#594 keeps sharing within one tab).

// HandoffPage is a page an agent's tab shows, as a brief lists it: its address without the query or fragment (which
// may hold tokens) and its title on one line.
type HandoffPage struct {
	Url   string
	Title string
}

var runningLock sync.Mutex
var runningManager *Manager

func setRunningManager(m *Manager) {
	runningLock.Lock()
	defer runningLock.Unlock()
	runningManager = m
}

func getRunningManager() *Manager {
	runningLock.Lock()
	defer runningLock.Unlock()
	return runningManager
}

// PageOfAgentTab returns the page of tab tabId of the newest browser session of the agent in blockId; false when the
// pane has no session, the tab is not one of its tabs or it shows no web page.
func PageOfAgentTab(ctx context.Context, blockId string, tabId int64) (HandoffPage, bool) {
	m := getRunningManager()
	if m == nil {
		return HandoffPage{}, false
	}
	return m.pageOfAgentTab(ctx, blockId, tabId)
}

func (m *Manager) agentTabKey(blockId string, tabId int64) (TabKey, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	var newest *session
	for _, s := range m.sessions {
		if s.blockId != blockId || s.tabs[tabId] == nil {
			continue
		}
		if newest == nil || s.started.After(newest.started) {
			newest = s
		}
	}
	if newest == nil {
		return TabKey{}, false
	}
	t := newest.tabs[tabId]
	if t.state == TabStateStopped {
		return TabKey{}, false
	}
	return t.key, true
}

func (m *Manager) pageOfAgentTab(ctx context.Context, blockId string, tabId int64) (HandoffPage, bool) {
	key, ok := m.agentTabKey(blockId, tabId)
	if !ok {
		return HandoffPage{}, false
	}
	panel, found, err := m.env.ReadPanel(ctx, key.PanelId)
	if err != nil || !found {
		return HandoffPage{}, false
	}
	page, ok := panel.findTab(key.BrowserTabId)
	if !ok {
		return HandoffPage{}, false
	}
	link, ok := shareUrl(page.Url)
	if !ok {
		return HandoffPage{}, false
	}
	host := siteOf(page.Url)
	if u, err := url.Parse(link); err == nil && u.Host != "" {
		host = u.Host
	}
	return HandoffPage{Url: link, Title: shareTitle(page.Title, host)}, true
}
