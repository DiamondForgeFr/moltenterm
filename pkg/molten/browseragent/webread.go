// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"errors"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// WebReadRequest is emain asking whether `wsh web get` may read the page a Wave web block shows now (FR-BRW-009,
// #1976). Url is the page's committed address, read by emain from the guest, never what the caller says.
type WebReadRequest struct {
	Url string `json:"url"`
}

// WebReadAnswer: Allow, or the fixed sentence that refuses. Site labels the page's untrusted envelope.
type WebReadAnswer struct {
	Allow bool   `json:"allow"`
	Site  string `json:"site,omitempty"`
	Error string `json:"error,omitempty"`
}

// WebRead decides whether a terminal's `wsh web get` may read a Wave web block's page. That page shares the panel's
// signed-in session and the command runs in the page's own world, so it needs what the browser tools need: a stored
// Always for the site, and a stored Block refuses. There is no session to hold an Allow once, and no bar on a Wave web
// block to ask in: the user allows the site once in the browser panel, where the agent's browser tools ask.
func (m *Manager) WebRead(source string, req WebReadRequest) (WebReadAnswer, error) {
	if source != wshutil.ElectronRoute {
		return WebReadAnswer{}, errors.New("only MoltenTerm can ask about a web block's page")
	}
	site := permissionSite(req.Url)
	if site == "" {
		return WebReadAnswer{Error: mcpbrowser.ErrUnreadablePage}, nil
	}
	switch m.siteDecision("", req.Url, site) {
	case SiteAllow:
		m.logf("%s web block read allowed site=%s\n", logPrefix, site)
		return WebReadAnswer{Allow: true, Site: site}, nil
	case SiteBlock:
		m.logf("%s web block read refused (blocked) site=%s\n", logPrefix, site)
		return WebReadAnswer{Site: site, Error: mcpbrowser.ErrSiteBlocked}, nil
	}
	m.logf("%s web block read refused (no decision) site=%s\n", logPrefix, site)
	return WebReadAnswer{Site: site, Error: mcpbrowser.ErrWebReadNotAllowed}, nil
}
