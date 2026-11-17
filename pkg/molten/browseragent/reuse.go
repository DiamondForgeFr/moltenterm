// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Reusing a page that is already open (FR-BRW-008, FR-BRW-011, #2333). Agents open the same page again and again, and the
// developer ends up with it many times: tabs_context lists what is open in the workspace, and tabs_create with an
// address reuses a page that shows it. The session's own tab is shown again; a tab the developer opened is asked for on
// its bar, and nothing is taken without their Allow. The logic is here, in the tools, so every agent CLI behaves alike.

const (
	// How long tabs_create waits for the developer's answer about a page they opened.
	defaultReuseTimeout = 60 * time.Second

	// A workspace with more pages than this lists the first ones.
	maxListedPages = 40
	maxListedTab   = 60

	pageOwnerUser  = "user"
	pageOwnerAgent = "agent"

	pageStateOpen       = "open"
	pageStateInUse      = "in use"
	pageStateControlled = "controlled"

	pageReuseAsk = "ask"

	otherPagesHint = "otherPages are pages open in this workspace that are not yours: they have no tabId, and you cannot " +
		"read or act on them. To use one, call tabs_create with its address: MoltenTerm reuses the page (it asks the " +
		"user first when the page is theirs) instead of opening it again."
)

// pageEntry is one page of the workspace that is not the session's, as tabs_context lists it (its title and address
// come in the untrusted block of the same page number).
type pageEntry struct {
	Page  int    `json:"page"`
	Owner string `json:"owner"`
	Agent string `json:"agent,omitempty"`
	State string `json:"state"`
	Site  string `json:"site,omitempty"`
	// Panel: where the page is, in the words of the workspace's layout.
	Panel string `json:"panel"`
	// Reuse: "ask" when tabs_create with its address asks the user for it.
	Reuse string `json:"reuse,omitempty"`
}

type otherPage struct {
	Page  int    `json:"page"`
	Tab   string `json:"tab,omitempty"`
	Title string `json:"title,omitempty"`
	Url   string `json:"url"`
}

// holderTab: the session that holds a tab, with the tab's state there.
func (m *Manager) holderTab(key TabKey) (sessionInfo, string, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[m.owners[key]]
	if s == nil {
		return sessionInfo{}, "", false
	}
	t := s.tabFor(key)
	if t == nil {
		return sessionInfo{}, "", false
	}
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, t.state, true
}

// readOtherPages lists the pages of the session's workspace that are not its own, for tabs_context: whose they are and
// where, never their content. A page's title and address come back only for a site the session may use, the address
// without credentials or secrets; a site the user blocked agents on is left out.
func (m *Manager) readOtherPages(ctx context.Context, s sessionInfo, loc BlockLocation) ([]pageEntry, []otherPage) {
	panels, err := m.env.WorkspacePanels(ctx, loc.WorkspaceId)
	if err != nil {
		return nil, nil
	}
	var entries []pageEntry
	var pages []otherPage
	for _, wp := range panels {
		for _, tab := range wp.Tabs {
			if len(entries) >= maxListedPages {
				return entries, pages
			}
			site := permissionSite(tab.Url)
			if tab.Engine != "" || site == "" || m.siteDecision(s.id, tab.Url, site) == SiteBlock {
				continue
			}
			holder, state, held := m.holderTab(TabKey{PanelId: wp.BlockId, BrowserTabId: tab.Id})
			if held && holder.id == s.id {
				continue
			}
			here := wp.TabId == loc.TabId
			place := "another tab"
			if here {
				place = "this tab"
			}
			entry := pageEntry{
				Page:  len(entries) + 1,
				Owner: pageOwnerUser,
				State: pageStateOpen,
				Site:  siteOf(tab.Url),
				Panel: fmt.Sprintf("panel %d of %s", wp.Order, place),
			}
			switch {
			case held && state == TabStateActive:
				entry.Owner, entry.Agent, entry.State = pageOwnerAgent, holder.agentName, pageStateControlled
			case held:
				entry.State = pageStateInUse
			case here:
				entry.Reuse = pageReuseAsk
			}
			page := otherPage{Page: entry.Page, Tab: shortName(wp.TabName), Url: originOf(tab.Url)}
			if m.siteAllowedNow(s.id, tab.Url) {
				page.Title = shareTitle(tab.Title, entry.Site)
				if masked := molten.MaskPageAddress(tab.Url); masked != "" {
					page.Url = masked
				}
			}
			entries = append(entries, entry)
			pages = append(pages, page)
		}
	}
	return entries, pages
}

func shortName(name string) string {
	name = strings.Join(strings.Fields(stripControls(name)), " ")
	if runes := []rune(name); len(runes) > maxListedTab {
		name = string(runes[:maxListedTab-1]) + "…"
	}
	return name
}

// pageCandidate is a page that may be the one an address names: the session's own tab (tabId is its id), or a page of
// the developer's (tabId 0).
type pageCandidate struct {
	page  molten.OpenPage
	tabId int64
	state string
	url   string
}

func (c pageCandidate) key() TabKey {
	return TabKey{PanelId: c.page.PanelId, BrowserTabId: c.page.TabId}
}

func recentOf(wp WorkspacePanel, known bool) int {
	if !known {
		return -1
	}
	return wp.Recent
}

// ownPages reads the pages of the session's own tabs, live from the webview when the agent may act on the tab (as
// tabs_context does), else as the panel saved them. The tabs are read in parallel.
func (m *Manager) ownPages(ctx context.Context, s sessionInfo, loc BlockLocation, panels map[string]WorkspacePanel) []pageCandidate {
	infos := m.listTabs(s.id)
	reads := make([]pageCandidate, len(infos))
	found := make([]bool, len(infos))
	var wg sync.WaitGroup
	for i, info := range infos {
		wg.Add(1)
		go func(i int, info tabInfo) {
			defer func() {
				panichandler.PanicHandler("molten:browseragent:reuseread", recover())
			}()
			defer wg.Done()
			resolved, errText := m.resolveTab(ctx, s, loc, info.id, false)
			if errText != "" {
				return
			}
			page := resolved.page
			if resolved.info.state == TabStateActive && resolved.info.confirmed && resolved.info.engaged {
				if live, ok := m.livePage(ctx, s, info.id, resolved.info.key); ok {
					page = live
				}
			}
			key := resolved.info.key
			wp, known := panels[key.PanelId]
			reads[i] = pageCandidate{
				page: molten.OpenPage{
					PanelId: key.PanelId,
					TabId:   key.BrowserTabId,
					Url:     page.Url,
					Own:     true,
					InView:  known && wp.Shown && wp.Active == key.BrowserTabId,
					Recent:  recentOf(wp, known),
					Seq:     info.id,
				},
				tabId: info.id,
				state: resolved.info.state,
				url:   page.Url,
			}
			found[i] = true
		}(i, info)
	}
	wg.Wait()
	var rtn []pageCandidate
	for i, c := range reads {
		if found[i] {
			rtn = append(rtn, c)
		}
	}
	return rtn
}

// developerPages are the pages the developer opened in the panels beside the agent's terminal (its own Wave tab), that
// no agent holds and that the user did not block agents on. A page in another Wave tab is not offered: the developer is
// not looking there, so a question would go unseen (the rule of #594 for sharing).
func (m *Manager) developerPages(s sessionInfo, loc BlockLocation, panels []WorkspacePanel) []pageCandidate {
	var rtn []pageCandidate
	for _, wp := range panels {
		if wp.TabId != loc.TabId {
			continue
		}
		for i, tab := range wp.Tabs {
			site := permissionSite(tab.Url)
			if tab.Engine != "" || site == "" {
				continue
			}
			key := TabKey{PanelId: wp.BlockId, BrowserTabId: tab.Id}
			if _, _, held := m.holderTab(key); held || m.siteDecision(s.id, tab.Url, site) == SiteBlock {
				continue
			}
			rtn = append(rtn, pageCandidate{
				page: molten.OpenPage{
					PanelId: wp.BlockId,
					TabId:   tab.Id,
					Url:     tab.Url,
					InView:  wp.Shown && wp.Active == tab.Id,
					Recent:  wp.Recent,
					Seq:     int64(wp.Order)*1000 + int64(i),
				},
				url: tab.Url,
			})
		}
	}
	return rtn
}

// reuseResult is what looking for an open page decided: handled says tabs_create is answered (result and entry), else
// it opens a new tab, and note tells why in the new tab's sentence.
type reuseResult struct {
	result  mcpbrowser.CallResult
	entry   callLog
	handled bool
	note    string
}

func reuseDone(result mcpbrowser.CallResult, entry callLog) reuseResult {
	return reuseResult{result: result, entry: entry, handled: true}
}

func reuseFailed(text string) reuseResult {
	return reuseDone(mcpbrowser.ErrorResult(text), callLog{})
}

// reuseOpenPage looks for an open page that shows the target address (the session's own tab first, then the one in view,
// then the most recently focused, then the newest) and reuses it. A page of the developer's is asked for.
func (m *Manager) reuseOpenPage(ctx context.Context, s sessionInfo, loc BlockLocation, target string, reload bool) reuseResult {
	panels, err := m.env.WorkspacePanels(ctx, loc.WorkspaceId)
	if err != nil {
		return reuseFailed(mcpbrowser.ErrPanelUnreadable)
	}
	byPanel := make(map[string]WorkspacePanel, len(panels))
	for _, wp := range panels {
		byPanel[wp.BlockId] = wp
	}
	candidates := append(m.ownPages(ctx, s, loc, byPanel), m.developerPages(s, loc, panels)...)
	byKey := make(map[TabKey]pageCandidate, len(candidates))
	pages := make([]molten.OpenPage, 0, len(candidates))
	for _, c := range candidates {
		byKey[c.key()] = c
		pages = append(pages, c.page)
	}
	takenOver := int64(0)
	var developer *pageCandidate
	for _, match := range molten.MatchingOpenPages(pages, target) {
		c := byKey[TabKey{PanelId: match.PanelId, BrowserTabId: match.TabId}]
		if c.tabId == 0 {
			developer = &c
			break
		}
		if c.state == TabStateActive {
			result, entry := m.showReused(ctx, s, loc, c.tabId, reload, false)
			return reuseDone(result, entry)
		}
		if takenOver == 0 {
			takenOver = c.tabId
		}
	}
	if takenOver != 0 {
		return reuseDone(mcpbrowser.ErrorResult(mcpbrowser.ErrTakenOver), callLog{tabId: takenOver, site: siteOf(target)})
	}
	if developer == nil {
		return reuseResult{}
	}
	return m.reuseDevelopersPage(ctx, s, loc, *developer, target, reload)
}

// reuseDevelopersPage asks the developer, on the page's own bar, whether the agent may use it. Allow gives the tab to the
// agent as Share does; Open another tab, or Escape, leaves it alone and a new tab opens; no answer in time says so and
// opens nothing.
func (m *Manager) reuseDevelopersPage(ctx context.Context, s sessionInfo, loc BlockLocation, c pageCandidate, target string, reload bool) reuseResult {
	key := c.key()
	site := siteOf(c.url)
	outcome, err := m.askReuse(ctx, s, key, site)
	if err != nil {
		return reuseFailed(mcpbrowser.ErrCallCancelled)
	}
	switch outcome {
	case outcomeAllowed:
	case DecisionDeny, DecisionDismiss:
		return reuseResult{note: " (the developer kept their own tab of this page, so this one is another)"}
	case outcomeTimeout:
		return reuseDone(mcpbrowser.TextResult(jsonText(map[string]any{"status": mcpbrowser.ReuseWaitingStatus})+"\n"+
			"Waiting for the developer: that page is open in one of their tabs and they have not answered yet whether you may "+
			"use it. Nothing was opened and nothing was taken, and the question is withdrawn. Call tabs_create with the same "+
			"address to ask again later, or pass newTab: true to open a separate copy."), callLog{site: site})
	default:
		return reuseFailed(mcpbrowser.ErrSessionEnded)
	}
	// The page may have changed while the developer was asked: they allowed this page, not another.
	if panel, found, err := m.env.ReadPanel(ctx, key.PanelId); err != nil || !found || !samePage(panel, key, target) {
		return reuseResult{note: " (the page of the developer's tab changed while they were asked, so this one is another)"}
	}
	shared := m.shareTab(s.id, key, false, site)
	switch shared.result {
	case shareHeld:
		return reuseResult{note: " (another agent holds that page now, so this one is another)"}
	case shareGone:
		return reuseFailed(mcpbrowser.ErrSessionEnded)
	case shareFull:
		return reuseFailed(mcpbrowser.ErrTooManyTabs)
	}
	// A second call of the session on the same page finds the tab the first one took.
	tabId := shared.tabId
	if tabId == 0 {
		tabId = m.tabIdOf(s.id, key)
	}
	if tabId == 0 {
		return reuseFailed(mcpbrowser.ErrNotYourTab)
	}
	m.dropNotice(s.id, tabId)
	m.publishPanel(key.PanelId)
	m.logf("%s session=%s agent=%q tab=%d shared (reuse)\n", logPrefix, shortId(s.id), s.agentName, tabId)
	result, entry := m.showReused(ctx, s, loc, tabId, reload, true)
	return reuseDone(result, entry)
}

// tabIdOf is the session's id for a panel tab it holds, 0 when it holds none.
func (m *Manager) tabIdOf(sessionId string, key TabKey) int64 {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return 0
	}
	if t := s.tabFor(key); t != nil {
		return t.id
	}
	return 0
}

// samePage: the panel's tab still shows the address.
func samePage(panel Panel, key TabKey, target string) bool {
	page, ok := panel.findTab(key.BrowserTabId)
	if !ok || page.Engine != "" {
		return false
	}
	want, okWant := molten.NormalizePageAddress(target)
	got, okGot := molten.NormalizePageAddress(page.Url)
	return okWant && okGot && want == got
}

// showReused puts the page of one of the session's tabs in front of the developer, as tabs_show does (no site
// permission, nothing read), and loads it again when asked. handedOver: the developer just let the agent use this tab.
func (m *Manager) showReused(ctx context.Context, s sessionInfo, loc BlockLocation, tabId int64, reload bool, handedOver bool) (mcpbrowser.CallResult, callLog) {
	resolved, errText := m.resolveTab(ctx, s, loc, tabId, true)
	if errText != "" {
		return mcpbrowser.ErrorResult(errText), callLog{tabId: tabId}
	}
	entry := callLog{tabId: tabId, site: siteOf(resolved.page.Url)}
	errText, _ = m.runOnTab(ctx, s.id, tabId, func(ctx context.Context) error {
		m.showPage(s.id, tabId, actionShown)
		return nil
	})
	if errText != "" {
		return mcpbrowser.ErrorResult(errText), entry
	}
	head := jsonText(map[string]any{"tabId": tabId, "result": fmt.Sprintf("reused tab %d", tabId), "reused": true})
	sentence := fmt.Sprintf("Reused tab %d: that page was already open, so no new tab was opened. It is in front of the user, whose keyboard focus did not move.", tabId)
	if handedOver {
		sentence = fmt.Sprintf("Reused tab %d: that page was open in the developer's own tab and they let you use it, so no new tab was opened. "+
			"It is in front of the user, whose keyboard focus did not move.", tabId)
	}
	if !reload {
		return mcpbrowser.TextResult(head + "\n" + sentence), entry
	}
	loaded, loadedEntry := m.navigate(ctx, s, loc, json.RawMessage(fmt.Sprintf(`{"tabId":%d,"url":%q}`, tabId, urlReload)))
	if loaded.IsError {
		loaded.Content = append(loaded.Content, mcpbrowser.ContentItem{Type: mcpbrowser.ContentText,
			Text: fmt.Sprintf("Tab %d is the reused tab: it was shown but not loaded again.", tabId)})
		return loaded, loadedEntry
	}
	return mcpbrowser.TextResult(head + "\n" + sentence + " It was loaded again.\n" + firstText(loaded)), loadedEntry
}

func firstText(result mcpbrowser.CallResult) string {
	for _, c := range result.Content {
		if c.Type == mcpbrowser.ContentText {
			return c.Text
		}
	}
	return ""
}

// openPage is tabs_create with an address: a page that is already open is reused (unless newTab is set), else a new tab
// opens and loads it, the site permission first (navigate's).
func (m *Manager) openPage(ctx context.Context, s sessionInfo, loc BlockLocation, target string, args tabsCreateArgs) (mcpbrowser.CallResult, callLog) {
	note := ""
	if !args.NewTab {
		reused := m.reuseOpenPage(ctx, s, loc, target, args.Reload)
		if reused.handled {
			return reused.result, reused.entry
		}
		note = reused.note
	}
	tabId, failed := m.openEmptyTab(ctx, s, loc)
	if failed != nil {
		return *failed, callLog{}
	}
	head := jsonText(map[string]any{"tabId": tabId, "result": fmt.Sprintf("opened tab %d", tabId), "reused": false})
	sentence := fmt.Sprintf("Opened tab %d in the browser panel next to the terminal%s.", tabId, note)
	navArgs, _ := json.Marshal(map[string]any{"tabId": tabId, "url": target})
	loaded, entry := m.navigate(ctx, s, loc, navArgs)
	entry.tabId = tabId
	if loaded.IsError {
		loaded.Content = append(loaded.Content, mcpbrowser.ContentItem{Type: mcpbrowser.ContentText,
			Text: fmt.Sprintf("Tab %d is open and empty: the page was not loaded in it.", tabId)})
		return loaded, entry
	}
	return mcpbrowser.TextResult(head + "\n" + sentence + "\n" + firstText(loaded)), entry
}

// The user's question about a page of theirs (#2333, DS-BRW-017).

// askReuse asks the developer, on the tab's own bar, whether the session may use the page; it returns outcomeAllowed,
// DecisionDeny or DecisionDismiss (the answers), outcomeTimeout or outcomeEnded. Two calls of one session on the same
// tab share the question.
func (m *Manager) askReuse(ctx context.Context, s sessionInfo, key TabKey, site string) (string, error) {
	req, created := m.joinReuseRequest(s.id, key, site)
	if req == nil {
		return outcomeEnded, nil
	}
	defer func() {
		m.leaveRequest(req)
		m.publishPanel(key.PanelId)
	}()
	if created {
		m.publishPanel(key.PanelId)
		m.logf("%s session=%s agent=%q reuse asked site=%s\n", logPrefix, shortId(s.id), s.agentName, site)
	}
	deadline := time.NewTimer(time.Until(req.created.Add(m.reuseTimeout)))
	defer deadline.Stop()
	select {
	case <-req.done:
	case <-ctx.Done():
		return "", ctx.Err()
	case <-deadline.C:
		m.resolveRequest(req, outcomeTimeout)
	}
	return m.requestOutcome(req), nil
}

func (m *Manager) joinReuseRequest(sessionId string, key TabKey, site string) (*permissionRequest, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.sessions[sessionId] == nil {
		return nil, false
	}
	for _, req := range m.requests {
		if req.kind == PromptReuse && req.sessionId == sessionId && req.key == key && req.outcome == "" {
			req.waiters++
			return req, false
		}
	}
	req := &permissionRequest{
		id:        uuid.NewString(),
		kind:      PromptReuse,
		sessionId: sessionId,
		key:       key,
		site:      site,
		created:   m.now(),
		done:      make(chan struct{}),
		waiters:   1,
	}
	m.requests[req.id] = req
	return req, true
}

// reuseAsksLocked lists the questions waiting on the panel's pages, oldest first.
func (m *Manager) reuseAsksLocked(panelId string) []PanelReuseAsk {
	rtn := []PanelReuseAsk{}
	for _, req := range m.requests {
		if req.kind != PromptReuse || req.key.PanelId != panelId || req.outcome != "" {
			continue
		}
		s := m.sessions[req.sessionId]
		if s == nil {
			continue
		}
		rtn = append(rtn, PanelReuseAsk{
			BrowserTabId: req.key.BrowserTabId,
			RequestId:    req.id,
			AgentName:    s.agentName,
			AgentBlockId: s.blockId,
			Since:        req.created.UnixMilli(),
		})
	}
	sort.Slice(rtn, func(i, j int) bool {
		if rtn[i].Since != rtn[j].Since {
			return rtn[i].Since < rtn[j].Since
		}
		return rtn[i].RequestId < rtn[j].RequestId
	})
	return rtn
}
