// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Sharing a tab the user opened with an agent in the same workspace tab (FR-BRW-011, DS-BRW-017). Only a MoltenTerm window can
// share, move or tell: an agent can never give itself a tab. A shared tab joins the session's scope and nothing else;
// site permissions still apply (ensureSite) and JavaScript is never implied.

const (
	ShareResultShared = "shared"
	// ShareResultMove: another agent holds the tab, the panel asks the user before moving it (AC5).
	ShareResultMove = "move"

	actionEngaged = "Working in the tab you shared"

	maxShareTitle = 80

	errShareNotUi        = "only a MoltenTerm window can share a tab with an agent"
	errShareTabGone      = "This tab is no longer in the panel"
	errShareOtherEngine  = "This page is open in another browser: open it in MoltenTerm to share it"
	errShareSessionGone  = "This agent's browser session has ended"
	errShareElsewhere    = "This agent runs in another workspace"
	errShareOtherTab     = "This agent runs in another tab: share the page from a browser panel in its tab"
	errShareNotShared    = "This tab is not shared with an agent"
	errShareNoPage       = "Open a page in this tab first"
	errShareTooManyTabs  = "This agent already holds too many tabs"
	errSharePanelUnknown = "MoltenTerm could not read the browser panel"
)

// ListRequest names the panel whose tab's agents are listed.
type ListRequest struct {
	BlockId string `json:"blockid"`
}

// SessionEntry is one agent connected to MoltenTerm's browser in a pane of the panel's tab. Must match
// frontend/moltenterm-shell/browser/browser-share.ts.
type SessionEntry struct {
	SessionId string `json:"sessionid"`
	BlockId   string `json:"blockid"`
	AgentName string `json:"agentname"`
}

type ListResult struct {
	Sessions []SessionEntry `json:"sessions"`
}

// ShareRequest shares a panel tab with a session; Move: the user agreed to take it from the agent that holds it.
type ShareRequest struct {
	BlockId      string `json:"blockid"`
	BrowserTabId string `json:"browsertabid"`
	SessionId    string `json:"sessionid"`
	Move         bool   `json:"move,omitempty"`
}

type ShareResult struct {
	Result    string `json:"result"`
	AgentName string `json:"agentname,omitempty"`
	// Holder: the agent that holds the tab now, when the result is move.
	Holder string `json:"holder,omitempty"`
}

type ShareTellRequest struct {
	BlockId      string `json:"blockid"`
	BrowserTabId string `json:"browsertabid"`
}

type ShareTellResult struct {
	Sent    bool   `json:"sent"`
	Message string `json:"message"`
	// MessageText: Message's code for the window (#656).
	MessageText *uimsg.Text `json:"messagetext,omitempty"`
}

type sessionRef struct {
	id        string
	blockId   string
	agentName string
	started   int64
}

func (m *Manager) sessionRefs() []sessionRef {
	m.lock.Lock()
	defer m.lock.Unlock()
	rtn := make([]sessionRef, 0, len(m.sessions))
	for _, s := range m.sessions {
		rtn = append(rtn, sessionRef{id: s.id, blockId: s.blockId, agentName: s.agentName, started: s.started.UnixNano()})
	}
	return rtn
}

// paneOf: where the session's pane is now, when it is a local terminal.
func (m *Manager) paneOf(ctx context.Context, blockId string) (BlockLocation, bool) {
	loc, err := m.env.LocateBlock(ctx, blockId)
	if err != nil || loc.View != TermView || !loc.Local {
		return BlockLocation{}, false
	}
	return loc, true
}

// shareError is one of the errShare sentences as the window shows it, by its code (#656).
func shareError(msg string) error {
	var text *uimsg.Text
	switch msg {
	case errShareNotUi:
		text = uimsg.Make("browser.share.notui")
	case errShareTabGone:
		text = uimsg.Make("browser.share.tabgone")
	case errShareOtherEngine:
		text = uimsg.Make("browser.share.otherengine")
	case errShareSessionGone:
		text = uimsg.Make("browser.share.sessiongone")
	case errShareElsewhere:
		text = uimsg.Make("browser.share.elsewhere")
	case errShareOtherTab:
		text = uimsg.Make("browser.share.othertab")
	case errShareNotShared:
		text = uimsg.Make("browser.share.notshared")
	case errShareNoPage:
		text = uimsg.Make("browser.share.nopage")
	case errShareTooManyTabs:
		text = uimsg.Make("browser.share.toomanytabs")
	case errSharePanelUnknown:
		text = uimsg.Make("browser.share.panelunknown")
	}
	return &uimsg.Error{Text: text, Message: msg}
}

// shareRefusal: why the session's pane cannot take a tab of the panel, "" when it can. Only an agent beside the panel,
// in the same tab, is offered the page (#594): the user cannot see an agent of another tab next to it.
func (m *Manager) shareRefusal(ctx context.Context, blockId string, panel Panel) string {
	loc, ok := m.paneOf(ctx, blockId)
	if !ok || loc.WorkspaceId != panel.WorkspaceId {
		return errShareElsewhere
	}
	if loc.TabId != panel.TabId {
		return errShareOtherTab
	}
	return ""
}

// ListSessions lists the agents of the panel's tab connected to MoltenTerm's browser, the newest session per pane (an
// agent restarted without a bye leaves an older one until its route goes).
func (m *Manager) ListSessions(ctx context.Context, source string, req ListRequest) (ListResult, error) {
	if !isUiSource(source) {
		return ListResult{}, shareError(errShareNotUi)
	}
	panel, found, err := m.env.ReadPanel(ctx, req.BlockId)
	if err != nil || !found {
		return ListResult{}, shareError(errSharePanelUnknown)
	}
	newest := make(map[string]sessionRef)
	for _, ref := range m.sessionRefs() {
		if cur, ok := newest[ref.blockId]; ok && cur.started >= ref.started {
			continue
		}
		newest[ref.blockId] = ref
	}
	rtn := ListResult{Sessions: []SessionEntry{}}
	for blockId, ref := range newest {
		if m.shareRefusal(ctx, blockId, panel) != "" {
			continue
		}
		rtn.Sessions = append(rtn.Sessions, SessionEntry{SessionId: ref.id, BlockId: blockId, AgentName: ref.agentName})
	}
	sort.Slice(rtn.Sessions, func(i, j int) bool { return rtn.Sessions[i].BlockId < rtn.Sessions[j].BlockId })
	return rtn, nil
}

// Share gives a panel tab to a session (AC1, AC3, AC5, AC8). A tab one session holds is moved only with the user's
// agreement; the call in flight of the agent that loses it is cancelled.
func (m *Manager) Share(ctx context.Context, source string, req ShareRequest) (ShareResult, error) {
	if !isUiSource(source) {
		return ShareResult{}, shareError(errShareNotUi)
	}
	panel, found, err := m.env.ReadPanel(ctx, req.BlockId)
	if err != nil || !found {
		return ShareResult{}, shareError(errSharePanelUnknown)
	}
	page, ok := panel.findTab(req.BrowserTabId)
	if !ok {
		return ShareResult{}, shareError(errShareTabGone)
	}
	if page.Engine != "" {
		return ShareResult{}, shareError(errShareOtherEngine)
	}
	s, ok := m.sessionById(req.SessionId)
	if !ok {
		return ShareResult{}, shareError(errShareSessionGone)
	}
	if refusal := m.shareRefusal(ctx, s.blockId, panel); refusal != "" {
		return ShareResult{}, shareError(refusal)
	}
	key := TabKey{PanelId: req.BlockId, BrowserTabId: req.BrowserTabId}
	outcome := m.shareTab(s.id, key, req.Move)
	switch outcome.result {
	case shareHeld:
		return ShareResult{Result: ShareResultMove, AgentName: s.agentName, Holder: outcome.holder.agentName}, nil
	case shareGone:
		return ShareResult{}, shareError(errShareSessionGone)
	case shareFull:
		return ShareResult{}, shareError(errShareTooManyTabs)
	}
	if outcome.moved {
		m.env.SetControl(key, false)
		m.logf("%s session=%s agent=%q control=moved\n", logPrefix, shortId(outcome.holder.id), outcome.holder.agentName)
	}
	m.publishPanel(key.PanelId)
	if outcome.tabId != 0 {
		m.logf("%s session=%s agent=%q tab=%d shared\n", logPrefix, shortId(s.id), s.agentName, outcome.tabId)
	}
	return ShareResult{Result: ShareResultShared, AgentName: s.agentName}, nil
}

func (m *Manager) sessionById(sessionId string) (sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return sessionInfo{}, false
	}
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, true
}

const (
	shareAdded = iota
	shareKept
	shareHeld
	shareGone
	shareFull
)

type shareOutcome struct {
	result int
	tabId  int64
	moved  bool
	holder sessionInfo
}

// shareTab takes the tab from its holder (with move) and adds it to the session, in one step so no call can slip in
// between.
func (m *Manager) shareTab(sessionId string, key TabKey, move bool) shareOutcome {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return shareOutcome{result: shareGone}
	}
	var out shareOutcome
	if holderId, held := m.owners[key]; held {
		if holderId == sessionId {
			return shareOutcome{result: shareKept}
		}
		holder := m.sessions[holderId]
		if holder != nil {
			out.holder = sessionInfo{id: holder.id, blockId: holder.blockId, agentName: holder.agentName}
			if !move {
				return shareOutcome{result: shareHeld, holder: out.holder}
			}
			if t := holder.tabFor(key); t != nil {
				cancelCallsLocked(t)
				m.endRequestsLocked(holder.id, t.id)
				t.state = TabStateStopped
				t.viewport = nil
			}
			out.moved = true
		}
		delete(m.owners, key)
	}
	open := 0
	for _, t := range s.tabs {
		if t.state != TabStateStopped {
			open++
		}
	}
	if open >= maxTabsPerSession {
		return shareOutcome{result: shareFull}
	}
	m.nextTabId++
	now := m.now()
	s.tabs[m.nextTabId] = &agentTab{
		id:        m.nextTabId,
		key:       key,
		origin:    OriginShared,
		state:     TabStateActive,
		createdAt: now,
		confirmed: true,
		calls:     make(map[int64]context.CancelFunc),
	}
	m.owners[key] = sessionId
	out.result = shareAdded
	out.tabId = m.nextTabId
	return out
}

// engageTab starts control of a shared tab on the agent's first call on it: emain watches it for the user's input
// (takeover) and lets the DevTools methods through, and the panel shows the control bar.
func (m *Manager) engageTab(sessionId string, tabId int64) {
	key, ok := m.markEngaged(sessionId, tabId)
	if !ok {
		return
	}
	m.env.SetControl(key, true)
	m.publishPanel(key.PanelId)
}

func (m *Manager) markEngaged(sessionId string, tabId int64) (TabKey, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	t := m.sessions[sessionId].tabOrNil(tabId)
	if t == nil || t.engaged || m.owners[t.key] != sessionId {
		return TabKey{}, false
	}
	t.engaged = true
	t.action = actionEngaged
	t.actionTs = m.now().UnixMilli()
	return t.key, true
}

func (m *Manager) holderOf(key TabKey) (sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[m.owners[key]]
	if s == nil {
		return sessionInfo{}, false
	}
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, true
}

// ShareTell types "I shared the tab ..." into the prompt of the agent the tab is shared with, without Enter (AC6). The
// line comes from the panel's own copy of the tab, never from the window's request.
func (m *Manager) ShareTell(ctx context.Context, source string, req ShareTellRequest) (ShareTellResult, error) {
	if !isUiSource(source) {
		return ShareTellResult{}, shareError(errShareNotUi)
	}
	key := TabKey{PanelId: req.BlockId, BrowserTabId: req.BrowserTabId}
	holder, ok := m.holderOf(key)
	if !ok {
		return ShareTellResult{}, shareError(errShareNotShared)
	}
	panel, found, err := m.env.ReadPanel(ctx, req.BlockId)
	if err != nil || !found {
		return ShareTellResult{}, shareError(errSharePanelUnknown)
	}
	page, ok := panel.findTab(req.BrowserTabId)
	if !ok {
		return ShareTellResult{}, shareError(errShareTabGone)
	}
	line, ok := shareLine(page)
	if !ok {
		return ShareTellResult{}, shareError(errShareNoPage)
	}
	out := m.env.TypeLine(ctx, holder.blockId, line)
	m.logf("%s session=%s agent=%q sharetell=%v\n", logPrefix, shortId(holder.id), holder.agentName, out.Sent)
	return ShareTellResult{Sent: out.Sent, Message: out.Message, MessageText: out.MessageText}, nil
}

func stripControls(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
}

// shareUrl is the page's address without its query or fragment, which may hold tokens.
func shareUrl(rawUrl string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(rawUrl))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	return stripControls(u.Scheme + "://" + u.Host + path), true
}

// shareTitle is the page's title on one line, cut to 80 characters; a page without one is named by its site.
func shareTitle(title string, site string) string {
	title = strings.Join(strings.Fields(stripControls(strings.ReplaceAll(title, "\n", " "))), " ")
	if title == "" {
		title = site
	}
	runes := []rune(title)
	if len(runes) > maxShareTitle {
		title = string(runes[:maxShareTitle-1]) + "…"
	}
	return title
}

func shareLine(page molten.BrowserPanelTab) (string, bool) {
	link, ok := shareUrl(page.Url)
	if !ok {
		return "", false
	}
	host := siteOf(page.Url)
	if u, err := url.Parse(link); err == nil && u.Host != "" {
		host = u.Host
	}
	return fmt.Sprintf("I shared the tab \"%s\" (%s) with you.", shareTitle(page.Title, host), link), true
}
