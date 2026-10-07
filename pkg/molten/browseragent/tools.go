// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

const (
	blankUrl         = "about:blank"
	agentTabIdPrefix = "agent-"

	actionOpened = "Opened this tab"

	ownerAgent = "you"
	ownerUser  = "shared by the user"

	logOutcomeOk    = "ok"
	logOutcomeError = "error"
)

// callLog is what the audit line of a call may hold (NFR-BRW-008): ids and a host, never URLs, titles or arguments.
type callLog struct {
	tabId int64
	site  string
}

// Call runs one tool for a session. Every refusal is a tool result with a fixed sentence, so the agent keeps going.
func (m *Manager) Call(ctx context.Context, source string, req mcpbrowser.CallRequest) mcpbrowser.CallResult {
	start := m.now()
	s, ok := m.sessionFor(req.SessionId, source)
	if !ok {
		m.logCall(sessionInfo{id: req.SessionId}, req.Tool, callLog{}, mcpbrowser.ErrSessionEnded, start)
		return mcpbrowser.ErrorResult(mcpbrowser.ErrSessionEnded)
	}
	loc, err := m.env.LocateBlock(ctx, s.blockId)
	if err != nil || loc.View != TermView {
		m.logCall(s, req.Tool, callLog{}, mcpbrowser.ErrNotInMoltenTerm, start)
		return mcpbrowser.ErrorResult(mcpbrowser.ErrNotInMoltenTerm)
	}
	var result mcpbrowser.CallResult
	var entry callLog
	switch req.Tool {
	case mcpbrowser.ToolTabsContext:
		result = m.tabsContext(ctx, s, loc, req.Args)
	case mcpbrowser.ToolTabsCreate:
		result, entry = m.tabsCreate(ctx, s, loc)
	case mcpbrowser.ToolTabsClose:
		result, entry = m.tabsClose(ctx, s, loc, req.Args)
	default:
		result = mcpbrowser.ErrorResult(mcpbrowser.ErrUnknownTool)
	}
	outcome := logOutcomeOk
	if result.IsError {
		outcome = resultSentence(result)
	}
	m.logCall(s, req.Tool, entry, outcome, start)
	return result
}

// resultSentence keeps an error for the log only when it is one of the fixed sentences: other errors may quote
// something the page or the agent wrote.
func resultSentence(result mcpbrowser.CallResult) string {
	if len(result.Content) == 0 {
		return logOutcomeError
	}
	fixed := []string{
		mcpbrowser.ErrNotInMoltenTerm, mcpbrowser.ErrNotYourTab, mcpbrowser.ErrTakenOver, mcpbrowser.ErrStopped,
		mcpbrowser.ErrOtherEngine, mcpbrowser.ErrTabClosed, mcpbrowser.ErrNotOpenedByYou, mcpbrowser.ErrSessionEnded,
		mcpbrowser.ErrTabIdRequired, mcpbrowser.ErrUnknownTool, mcpbrowser.ErrPanelUnreadable,
	}
	if slices.Contains(fixed, result.Content[0].Text) {
		return result.Content[0].Text
	}
	return logOutcomeError
}

func (m *Manager) logCall(s sessionInfo, tool string, entry callLog, outcome string, start time.Time) {
	tab := "-"
	if entry.tabId > 0 {
		tab = strconv.FormatInt(entry.tabId, 10)
	}
	site := entry.site
	if site == "" {
		site = "-"
	}
	if !mcpbrowser.ToolNames()[tool] {
		tool = "unknown"
	}
	m.logf("%s session=%s agent=%q tool=%s tab=%s site=%s outcome=%q duration=%dms\n", logPrefix, shortId(s.id),
		s.agentName, tool, tab, site, outcome, m.now().Sub(start).Milliseconds())
}

// siteOf is the host of a page, the only part of a URL that is logged or labelled.
func siteOf(rawUrl string) string {
	u, err := url.Parse(rawUrl)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == ':' {
			return r
		}
		return -1
	}, host)
}

// untrustedBlock wraps page-originated values (DS-BRW-020). They are JSON-encoded, which escapes <, > and &, so a
// page cannot close the envelope or open another one.
func untrustedBlock(site string, payload any) string {
	data, err := json.Marshal(payload)
	if err != nil {
		data = []byte("{}")
	}
	attr := ""
	if site != "" {
		attr = fmt.Sprintf(" site=%q", site)
	}
	return mcpbrowser.UntrustedNotice + "\n<untrusted-page-content" + attr + ">" + string(data) + "</untrusted-page-content>"
}

func jsonText(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(data)
}

// parseTabId accepts the integer ids this server hands out, as a JSON number or a string of digits.
func parseTabId(args json.RawMessage) (int64, bool) {
	var parsed struct {
		TabId json.RawMessage `json:"tabId"`
	}
	if json.Unmarshal(args, &parsed) != nil || len(parsed.TabId) == 0 {
		return 0, false
	}
	raw := bytes.TrimSpace(parsed.TabId)
	if len(raw) > 0 && raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return 0, false
		}
		raw = []byte(strings.TrimSpace(text))
	}
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil || value < 1 || value > math.MaxInt32 || value != math.Trunc(value) {
		return 0, false
	}
	return int64(value), true
}

type resolvedTab struct {
	info  tabInfo
	panel Panel
	page  molten.BrowserPanelTab
}

// resolveTab is the scope check every tool acting on a tab goes through (NFR-BRW-004): the id must be one of the
// session's tabs, still in its panel, in the pane's workspace and in MoltenTerm's engine. A foreign id learns nothing
// about the tab it names. acting refuses a tab the user stopped or took over.
func (m *Manager) resolveTab(ctx context.Context, s sessionInfo, loc BlockLocation, tabId int64, acting bool) (resolvedTab, string) {
	info, ok := m.tab(s.id, tabId)
	if !ok {
		return resolvedTab{}, mcpbrowser.ErrNotYourTab
	}
	if info.state == TabStateStopped {
		return resolvedTab{}, mcpbrowser.ErrStopped
	}
	if acting && info.state == TabStateTakenOver {
		return resolvedTab{}, mcpbrowser.ErrTakenOver
	}
	panel, found, err := m.env.ReadPanel(ctx, info.key.PanelId)
	if err != nil {
		return resolvedTab{}, mcpbrowser.ErrPanelUnreadable
	}
	if !found {
		m.dropTab(s.id, tabId)
		return resolvedTab{}, mcpbrowser.ErrTabClosed
	}
	if panel.WorkspaceId != loc.WorkspaceId {
		return resolvedTab{}, mcpbrowser.ErrNotYourTab
	}
	page, inPanel := panel.findTab(info.key.BrowserTabId)
	if !inPanel {
		if info.confirmed || m.now().Sub(info.createdAt) > pendingTabGrace {
			m.dropTab(s.id, tabId)
			return resolvedTab{}, mcpbrowser.ErrTabClosed
		}
		page = molten.BrowserPanelTab{Id: info.key.BrowserTabId, Url: blankUrl}
	} else if !info.confirmed {
		m.confirmTab(s.id, tabId)
	}
	if page.Engine != "" {
		return resolvedTab{}, mcpbrowser.ErrOtherEngine
	}
	return resolvedTab{info: info, panel: panel, page: page}, ""
}

type tabEntry struct {
	TabId int64  `json:"tabId"`
	Owner string `json:"owner"`
	State string `json:"state"`
	Site  string `json:"site,omitempty"`
}

type tabPage struct {
	TabId int64  `json:"tabId"`
	Title string `json:"title"`
	Url   string `json:"url"`
}

func (m *Manager) tabsContext(ctx context.Context, s sessionInfo, loc BlockLocation, args json.RawMessage) mcpbrowser.CallResult {
	var parsed struct {
		CreateIfEmpty bool `json:"createIfEmpty"`
	}
	json.Unmarshal(args, &parsed)
	entries, pages := m.readTabs(ctx, s, loc)
	if len(entries) == 0 && parsed.CreateIfEmpty {
		if created, _ := m.tabsCreate(ctx, s, loc); created.IsError {
			return created
		}
		entries, pages = m.readTabs(ctx, s, loc)
	}
	if len(entries) == 0 {
		return mcpbrowser.TextResult(jsonText(map[string]any{"tabs": []tabEntry{}}) +
			"\nNo tabs yet: open one with tabs_create (or tabs_context with createIfEmpty).")
	}
	parts := []string{jsonText(map[string]any{"tabs": entries})}
	for i, entry := range entries {
		parts = append(parts, untrustedBlock(entry.Site, pages[i]))
	}
	return mcpbrowser.TextResult(strings.Join(parts, "\n"))
}

// readTabs lists the session's visible tabs with their page: live from the webview when the agent may act on the
// tab, else as the panel last saved it.
func (m *Manager) readTabs(ctx context.Context, s sessionInfo, loc BlockLocation) ([]tabEntry, []tabPage) {
	var entries []tabEntry
	var pages []tabPage
	for _, info := range m.listTabs(s.id) {
		resolved, errText := m.resolveTab(ctx, s, loc, info.id, false)
		if errText != "" {
			continue
		}
		page := resolved.page
		if resolved.info.state == TabStateActive && resolved.info.confirmed {
			if live, ok := m.livePage(ctx, s, info.id, resolved.info.key); ok {
				page = live
			}
		}
		owner := ownerAgent
		if info.origin == OriginShared {
			owner = ownerUser
		}
		entries = append(entries, tabEntry{TabId: info.id, Owner: owner, State: resolved.info.state, Site: siteOf(page.Url)})
		pages = append(pages, tabPage{TabId: info.id, Title: page.Title, Url: page.Url})
	}
	return entries, pages
}

type navigationHistory struct {
	CurrentIndex int `json:"currentIndex"`
	Entries      []struct {
		Url   string `json:"url"`
		Title string `json:"title"`
	} `json:"entries"`
}

// livePage reads the tab's current page through DevTools (attaching on first use, DS-BRW-012); the panel's saved
// copy lags by its save delay.
func (m *Manager) livePage(ctx context.Context, s sessionInfo, tabId int64, key TabKey) (molten.BrowserPanelTab, bool) {
	readCtx, cancel := context.WithTimeout(ctx, liveReadTimeout)
	defer cancel()
	var history navigationHistory
	errText, err := m.runOnTab(readCtx, s.id, tabId, func(ctx context.Context) error {
		raw, err := m.env.Cdp(ctx, key, "Page.getNavigationHistory", map[string]any{})
		if err != nil {
			return err
		}
		return json.Unmarshal(raw, &history)
	})
	if errText != "" || err != nil || history.CurrentIndex < 0 || history.CurrentIndex >= len(history.Entries) {
		return molten.BrowserPanelTab{}, false
	}
	current := history.Entries[history.CurrentIndex]
	return molten.BrowserPanelTab{Id: key.BrowserTabId, Url: current.Url, Title: current.Title}, true
}

// tabsCreate opens an empty tab in the panel of the pane's tab, or in a new panel next to the terminal (AC2).
func (m *Manager) tabsCreate(ctx context.Context, s sessionInfo, loc BlockLocation) (mcpbrowser.CallResult, callLog) {
	panels, recent, err := m.env.TabPanels(ctx, loc.TabId)
	if err != nil {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrPanelUnreadable), callLog{}
	}
	key := TabKey{BrowserTabId: agentTabIdPrefix + uuid.NewString()}
	panelId, err := m.env.OpenTab(ctx, OpenTabRequest{
		TermBlockId:  s.blockId,
		TabId:        loc.TabId,
		PanelId:      molten.PickBrowserPanel(panels, recent),
		BrowserTabId: key.BrowserTabId,
		Url:          blankUrl,
	})
	if err != nil || panelId == "" {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrPanelUnreadable), callLog{}
	}
	key.PanelId = panelId
	tabId := m.addTab(s.id, key, OriginOpened, actionOpened)
	if tabId == 0 {
		m.env.CloseTab(context.Background(), key)
		return mcpbrowser.ErrorResult(mcpbrowser.ErrSessionEnded), callLog{}
	}
	m.env.SetControl(key, true)
	m.publishPanel(panelId)
	m.waitForTab(ctx, s.id, tabId, key)
	return mcpbrowser.TextResult(jsonText(map[string]any{"tabId": tabId}) + "\n" +
		fmt.Sprintf("Opened an empty tab (tabId %d) in the browser panel next to the terminal.", tabId)), callLog{tabId: tabId}
}

// waitForTab returns once the panel has the tab, so the next call finds it; a panel that is not shown opens it later.
func (m *Manager) waitForTab(ctx context.Context, sessionId string, tabId int64, key TabKey) {
	deadline := m.now().Add(openWaitTimeout)
	for {
		panel, found, err := m.env.ReadPanel(ctx, key.PanelId)
		if err == nil && found {
			if _, ok := panel.findTab(key.BrowserTabId); ok {
				m.confirmTab(sessionId, tabId)
				return
			}
		}
		if m.now().After(deadline) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(openPollEvery):
		}
	}
}

// tabsClose closes a tab the session opened; shared tabs stay the user's (AC3).
func (m *Manager) tabsClose(ctx context.Context, s sessionInfo, loc BlockLocation, args json.RawMessage) (mcpbrowser.CallResult, callLog) {
	tabId, ok := parseTabId(args)
	if !ok {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrTabIdRequired), callLog{}
	}
	resolved, errText := m.resolveTab(ctx, s, loc, tabId, true)
	if errText != "" {
		return mcpbrowser.ErrorResult(errText), callLog{}
	}
	entry := callLog{tabId: tabId, site: siteOf(resolved.page.Url)}
	if resolved.info.origin != OriginOpened {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrNotOpenedByYou), entry
	}
	errText, err := m.runOnTab(ctx, s.id, tabId, func(ctx context.Context) error {
		return m.env.CloseTab(ctx, resolved.info.key)
	})
	if errText != "" {
		return mcpbrowser.ErrorResult(errText), entry
	}
	if err != nil {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrPanelUnreadable), entry
	}
	m.dropTab(s.id, tabId)
	return mcpbrowser.TextResult(fmt.Sprintf("Closed tab %d.", tabId)), entry
}
