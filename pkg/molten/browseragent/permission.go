// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Site permissions (FR-BRW-009, DS-BRW-013). Pages keep the user's sign-ins, so no tool loads or reads a page of a site
// without the user's decision for that site: Allow once (this session), Always for this site, or Block, stored in
// browser:agentsites for Always and Block. A call on a site without a decision publishes a request on its tab and
// waits for the answer, Stop, or 2 minutes.

const (
	defaultPermissionTimeout = 120 * time.Second
	// The wait re-reads the settings: an Always given to another agent, or set by hand, ends it.
	defaultPermissionPoll = 500 * time.Millisecond
	// A decision just written counts at once, while the settings file is being reloaded.
	recentDecisionTtl = 10 * time.Second
	// Each answer can only move the call forward; this bounds the loop if the settings keep disagreeing.
	maxPermissionRounds = 4

	outcomeAllowed = "allowed"
	outcomeRecheck = "recheck"
	outcomeTimeout = "timeout"
	outcomeEnded   = "ended"
)

type permissionRequest struct {
	id   string
	kind string
	// action says what a sensitive action request asks for (kind action), in the bar's words.
	action    string
	sessionId string
	tabId     int64
	key       TabKey
	site      string
	created   time.Time
	done      chan struct{}
	outcome   string
	waiters   int
}

type recentDecision struct {
	decision string
	at       time.Time
}

// refusal is a fixed sentence a tool returns as its error: what the agent sees, and what the log may hold.
type refusal string

func (r refusal) Error() string {
	return string(r)
}

func refusalText(err error) (string, bool) {
	var r refusal
	if errors.As(err, &r) {
		return string(r), true
	}
	return "", false
}

// siteDecision is what applies now to a page for a session: allow, block, or "" (ask).
func (m *Manager) siteDecision(sessionId string, rawUrl string, site string) string {
	stored := storedDecision(m.env.AgentSites(), rawUrl)
	if stored == SiteBlock {
		return SiteBlock
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	m.pruneRecentLocked()
	if recent, ok := m.recent[site]; ok {
		if recent.decision == SiteBlock {
			return SiteBlock
		}
		if recent.decision == SiteAllow {
			return SiteAllow
		}
	}
	if stored == SiteAllow {
		return SiteAllow
	}
	if s := m.sessions[sessionId]; s != nil && s.allowedOnce[site] {
		return SiteAllow
	}
	return ""
}

// siteAllowedNow tells, without asking, whether the session may read a page of this URL.
func (m *Manager) siteAllowedNow(sessionId string, rawUrl string) bool {
	site := permissionSite(rawUrl)
	return site != "" && m.siteDecision(sessionId, rawUrl, site) == SiteAllow
}

// ensureSite returns nil once the session may use the page's site, or the refusal to return. It runs inside runOnTab,
// so Stop and takeover cancel the wait.
func (m *Manager) ensureSite(ctx context.Context, s sessionInfo, tabId int64, key TabKey, rawUrl string) error {
	site := permissionSite(rawUrl)
	if site == "" {
		return refusal(mcpbrowser.ErrUnreadablePage)
	}
	for round := 0; round < maxPermissionRounds; round++ {
		switch m.siteDecision(s.id, rawUrl, site) {
		case SiteAllow:
			return nil
		case SiteBlock:
			return refusal(mcpbrowser.ErrSiteBlocked)
		}
		outcome, err := m.askSite(ctx, s, tabId, key, rawUrl, site)
		if err != nil {
			return err
		}
		switch outcome {
		case outcomeAllowed:
			return nil
		case DecisionBlock:
			return refusal(mcpbrowser.ErrSiteBlocked)
		case DecisionDismiss:
			return refusal(mcpbrowser.ErrSiteNotAllowed)
		case outcomeTimeout:
			return refusal(mcpbrowser.ErrPermissionTimeout)
		case outcomeEnded:
			return refusal(mcpbrowser.ErrSessionEnded)
		}
	}
	return refusal(mcpbrowser.ErrSiteNotAllowed)
}

// askSite joins the request for the site on this tab (one at a time; later calls wait on it) and waits for it. Another
// tab of the session asks on its own bar; one answer wakes the others.
func (m *Manager) askSite(ctx context.Context, s sessionInfo, tabId int64, key TabKey, rawUrl string, site string) (string, error) {
	req, created := m.joinRequest(s.id, tabId, key, site)
	if req == nil {
		return outcomeEnded, nil
	}
	defer m.leaveRequest(req)
	if created {
		m.publishPanel(req.key.PanelId)
		m.logf("%s session=%s agent=%q permission asked site=%s\n", logPrefix, shortId(s.id), s.agentName, site)
	}
	deadline := time.NewTimer(time.Until(req.created.Add(m.permissionTimeout)))
	defer deadline.Stop()
	poll := time.NewTicker(m.permissionPoll)
	defer poll.Stop()
	for {
		select {
		case <-req.done:
			return m.requestOutcome(req), nil
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			m.resolveRequest(req, outcomeTimeout)
			return outcomeTimeout, nil
		case <-poll.C:
			if decision := m.siteDecision(s.id, rawUrl, site); decision != "" {
				m.resolveRequest(req, outcomeRecheck)
				return outcomeRecheck, nil
			}
		}
	}
}

func (m *Manager) joinRequest(sessionId string, tabId int64, key TabKey, site string) (*permissionRequest, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.sessions[sessionId] == nil {
		return nil, false
	}
	for _, req := range m.requests {
		if req.kind == PromptSite && req.sessionId == sessionId && req.site == site && req.tabId == tabId && req.outcome == "" {
			req.waiters++
			return req, false
		}
	}
	req := &permissionRequest{
		id:        uuid.NewString(),
		kind:      PromptSite,
		sessionId: sessionId,
		tabId:     tabId,
		key:       key,
		site:      site,
		created:   m.now(),
		done:      make(chan struct{}),
		waiters:   1,
	}
	m.requests[req.id] = req
	return req, true
}

// leaveRequest drops a request nobody waits on any more (its calls were cancelled), so its bar goes.
func (m *Manager) leaveRequest(req *permissionRequest) {
	if !m.releaseWaiter(req) {
		return
	}
	m.publishPanel(req.key.PanelId)
}

func (m *Manager) releaseWaiter(req *permissionRequest) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	req.waiters--
	if req.waiters > 0 {
		return false
	}
	_, pending := m.requests[req.id]
	delete(m.requests, req.id)
	if req.outcome == "" {
		req.outcome = outcomeEnded
		close(req.done)
	}
	return pending
}

func (m *Manager) requestOutcome(req *permissionRequest) string {
	m.lock.Lock()
	defer m.lock.Unlock()
	return req.outcome
}

// resolveRequest ends a request with an outcome; false when it had one already.
func (m *Manager) resolveRequest(req *permissionRequest, outcome string) bool {
	if !m.setOutcome(req, outcome) {
		return false
	}
	m.publishPanel(req.key.PanelId)
	return true
}

func (m *Manager) setOutcome(req *permissionRequest, outcome string) bool {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.setOutcomeLocked(req, outcome)
}

func (m *Manager) setOutcomeLocked(req *permissionRequest, outcome string) bool {
	if req.outcome != "" {
		return false
	}
	req.outcome = outcome
	delete(m.requests, req.id)
	close(req.done)
	return true
}

// endRequestsLocked ends the requests of a session or of one of its tabs (tabId 0: all), when it ends or is stopped.
func (m *Manager) endRequestsLocked(sessionId string, tabId int64) {
	for _, req := range m.requests {
		if req.sessionId == sessionId && (tabId == 0 || req.tabId == tabId) {
			m.setOutcomeLocked(req, outcomeEnded)
		}
	}
}

// pendingPromptLocked is the oldest request waiting on a tab.
func (m *Manager) pendingPromptLocked(key TabKey) *PermissionPrompt {
	var oldest *permissionRequest
	for _, req := range m.requests {
		if req.key != key || req.outcome != "" {
			continue
		}
		if oldest == nil || req.created.Before(oldest.created) || (req.created.Equal(oldest.created) && req.id < oldest.id) {
			oldest = req
		}
	}
	if oldest == nil {
		return nil
	}
	return &PermissionPrompt{RequestId: oldest.id, Site: oldest.site, Kind: oldest.kind, Action: oldest.action}
}

func validDecision(decision string) bool {
	switch decision {
	case DecisionOnce, DecisionAlways, DecisionBlock, DecisionDismiss, DecisionAllow, DecisionDeny:
		return true
	}
	return false
}

// decisionFits: a site request takes the site answers, an action request Allow or Deny; Escape (dismiss) refuses both.
func decisionFits(kind string, decision string) bool {
	if decision == DecisionDismiss {
		return true
	}
	if kind == PromptAction {
		return decision == DecisionAllow || decision == DecisionDeny
	}
	return decision == DecisionOnce || decision == DecisionAlways || decision == DecisionBlock
}

// Answer applies the user's answer in a tab's permission bar. Only a MoltenTerm window answers, never a terminal (an
// agent cannot allow itself), and only for the tab the request is shown on.
func (m *Manager) Answer(source string, req AnswerRequest) error {
	if !isUiSource(source) {
		return errors.New("only a MoltenTerm window can answer a site permission request")
	}
	if !validDecision(req.Decision) {
		return fmt.Errorf("unknown decision %q", req.Decision)
	}
	key := TabKey{PanelId: req.BlockId, BrowserTabId: req.BrowserTabId}
	pending, info, ok := m.takeRequest(req.RequestId, key, req.Decision)
	if !ok {
		return nil
	}
	if pending.kind == PromptSite && (req.Decision == DecisionAlways || req.Decision == DecisionBlock) {
		stored := SiteAllow
		if req.Decision == DecisionBlock {
			stored = SiteBlock
		}
		if err := m.env.SetAgentSite(pending.site, stored); err != nil {
			m.logf("%s the site decision could not be saved: %v\n", logPrefix, err)
		}
	}
	m.publishPanel(key.PanelId)
	for _, panelId := range m.wakeOthers(pending, req.Decision) {
		m.publishPanel(panelId)
	}
	m.logf("%s session=%s agent=%q %s %s site=%s\n", logPrefix, shortId(info.id), info.agentName, pending.kind, req.Decision, pending.site)
	return nil
}

func (m *Manager) takeRequest(requestId string, key TabKey, decision string) (*permissionRequest, sessionInfo, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	pending := m.requests[requestId]
	if pending == nil || pending.key != key || pending.outcome != "" || !decisionFits(pending.kind, decision) {
		return nil, sessionInfo{}, false
	}
	s := m.sessions[pending.sessionId]
	if s == nil {
		return nil, sessionInfo{}, false
	}
	switch decision {
	case DecisionAllow:
		m.setOutcomeLocked(pending, outcomeAllowed)
	case DecisionDeny:
		m.setOutcomeLocked(pending, DecisionDeny)
	case DecisionOnce:
		s.allowedOnce[pending.site] = true
		m.setOutcomeLocked(pending, outcomeAllowed)
	case DecisionAlways:
		s.allowedOnce[pending.site] = true
		m.recent[pending.site] = recentDecision{decision: SiteAllow, at: m.now()}
		m.setOutcomeLocked(pending, outcomeAllowed)
	case DecisionBlock:
		m.recent[pending.site] = recentDecision{decision: SiteBlock, at: m.now()}
		m.setOutcomeLocked(pending, DecisionBlock)
	default:
		m.setOutcomeLocked(pending, DecisionDismiss)
	}
	return pending, sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, true
}

// wakeOthers ends the other requests the answer decides, so they look again: Allow once covers the session's other
// tabs, Always and Block every agent. Escape decides nothing for them.
func (m *Manager) wakeOthers(answered *permissionRequest, decision string) []string {
	m.lock.Lock()
	defer m.lock.Unlock()
	if decision == DecisionDismiss || answered.kind != PromptSite {
		return nil
	}
	var panels []string
	for _, req := range m.requests {
		if req.kind != PromptSite || req.site != answered.site || req.outcome != "" {
			continue
		}
		if decision == DecisionOnce && req.sessionId != answered.sessionId {
			continue
		}
		m.setOutcomeLocked(req, outcomeRecheck)
		panels = append(panels, req.key.PanelId)
	}
	return panels
}

// SetSite stores or forgets a site decision from the panel's menu. Forgetting or blocking also ends the Allow once of
// running sessions: a revoked site asks again.
func (m *Manager) SetSite(source string, req SiteRequest) error {
	if !isUiSource(source) {
		return errors.New("only a MoltenTerm window can change site permissions")
	}
	if !validSiteKey(req.Site) {
		return fmt.Errorf("%q is not a site", req.Site)
	}
	stored := ""
	switch req.Decision {
	case "":
	case SiteAllow, DecisionAlways:
		stored = SiteAllow
	case SiteBlock:
		stored = SiteBlock
	default:
		return fmt.Errorf("unknown decision %q", req.Decision)
	}
	if err := m.env.SetAgentSite(req.Site, stored); err != nil {
		return err
	}
	m.revokeOnce(req.Site, stored)
	m.logf("%s site decision set site=%s decision=%q\n", logPrefix, req.Site, stored)
	return nil
}

// revokeOnce applies a menu decision to the running sessions at once. Sessions hold their decisions by registrable site,
// so a key for a subdomain (mail.example.com) revokes its site (example.com) too.
func (m *Manager) revokeOnce(key string, stored string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	sites := []string{key}
	if site := permissionSite("https://" + key + "/"); site != "" && site != key {
		sites = append(sites, site)
	}
	if stored == SiteAllow {
		m.recent[key] = recentDecision{decision: SiteAllow, at: m.now()}
		return
	}
	for _, site := range sites {
		if stored == SiteBlock {
			m.recent[site] = recentDecision{decision: SiteBlock, at: m.now()}
		} else {
			delete(m.recent, site)
		}
		for _, s := range m.sessions {
			delete(s.allowedOnce, site)
		}
	}
}

// pruneRecentLocked forgets decisions older than the settings reload they bridge.
func (m *Manager) pruneRecentLocked() {
	for site, recent := range m.recent {
		if m.now().Sub(recent.at) >= recentDecisionTtl {
			delete(m.recent, site)
		}
	}
}

// askAction asks the user to allow one sensitive action (DS-BRW-016): typing into a password or payment field,
// submitting a form that holds one, a file chooser, a download. Every action asks anew and nothing is remembered; the
// call waits inside runOnTab, so Stop and takeover end the wait.
func (m *Manager) askAction(ctx context.Context, s sessionInfo, tabId int64, key TabKey, site string, reason string) error {
	// A call Stop or takeover just cancelled asks nothing (its last look at the page failed because of that).
	if err := ctx.Err(); err != nil {
		return err
	}
	if errText := m.tabStateError(s.id, tabId); errText != "" {
		return refusal(errText)
	}
	req := m.addActionRequest(s.id, tabId, key, site, reason)
	if req == nil {
		return refusal(mcpbrowser.ErrSessionEnded)
	}
	defer m.leaveRequest(req)
	m.publishPanel(req.key.PanelId)
	m.logf("%s session=%s agent=%q confirmation asked reason=%s site=%s\n", logPrefix, shortId(s.id), s.agentName, reason, site)
	return m.waitAction(ctx, req)
}

// waitAction waits for the answer to an action request; Allow returns nil, anything else the refusal to return.
func (m *Manager) waitAction(ctx context.Context, req *permissionRequest) error {
	deadline := time.NewTimer(time.Until(req.created.Add(m.permissionTimeout)))
	defer deadline.Stop()
	select {
	case <-req.done:
	case <-ctx.Done():
		return ctx.Err()
	case <-deadline.C:
		m.resolveRequest(req, outcomeTimeout)
	}
	switch m.requestOutcome(req) {
	case outcomeAllowed:
		return nil
	case outcomeTimeout:
		return refusal(mcpbrowser.ErrActionTimeout)
	case outcomeEnded:
		return refusal(mcpbrowser.ErrSessionEnded)
	}
	return refusal(mcpbrowser.ErrActionDenied)
}

func (m *Manager) addActionRequest(sessionId string, tabId int64, key TabKey, site string, reason string) *permissionRequest {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[sessionId]
	if s == nil {
		return nil
	}
	req := &permissionRequest{
		id:        uuid.NewString(),
		kind:      PromptAction,
		action:    actionPromptText(reason),
		sessionId: sessionId,
		tabId:     tabId,
		key:       key,
		site:      site,
		created:   m.now(),
		done:      make(chan struct{}),
		waiters:   1,
	}
	m.requests[req.id] = req
	if reason == reasonDownload {
		if t := s.tabs[tabId]; t != nil {
			t.download = req
		}
	}
	return req
}

// AskDownload is emain asking whether a download that a tab under an agent's control started may go on (DS-BRW-016):
// only emain asks, since it is the one that holds the download back. The user answers in the tab's bar; a call in
// flight on the tab waits for the same answer (awaitDownload). A tab the agent does not hold now gets no.
func (m *Manager) AskDownload(ctx context.Context, source string, req DownloadRequest) (DownloadAnswer, error) {
	if source != wshutil.ElectronRoute {
		return DownloadAnswer{}, errors.New("only MoltenTerm can ask about a download")
	}
	key := TabKey{PanelId: req.BlockId, BrowserTabId: req.BrowserTabId}
	s, tabId, ok := m.activeOwner(key)
	if !ok {
		return DownloadAnswer{Allow: false}, nil
	}
	site := cleanHost(req.Host)
	if len(site) > 253 {
		site = site[:253]
	}
	err := m.askAction(ctx, s, tabId, key, site, reasonDownload)
	return DownloadAnswer{Allow: err == nil}, nil
}

// activeOwner is the session that drives a tab now, and its id for the tab; false when no agent does, or the user took
// over or stopped it.
func (m *Manager) activeOwner(key TabKey) (sessionInfo, int64, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s := m.sessions[m.owners[key]]
	if s == nil {
		return sessionInfo{}, 0, false
	}
	t := s.tabFor(key)
	if t == nil || t.state != TabStateActive {
		return sessionInfo{}, 0, false
	}
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, t.id, true
}
