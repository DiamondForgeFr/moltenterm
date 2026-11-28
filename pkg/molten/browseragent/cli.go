// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package browseragent

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentlinks"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// `molten browser` (#2596, FR-BRW-008): the same tools for an agent that has no MCP server. A command is one call of
// one tool, so it runs here, through Call, like an MCP call: the scope, the site permissions, the reuse questions, the
// control bar and the log are the tools' own. What a command line lacks is a connection that lasts, which a session
// hangs on, so the terminal's session is the one its MCP server opened when it has one (the tab ids are then the
// server's), else one the first command opens and the next ones find, whose tabs stay its own until its terminal goes.

const (
	cliSourcePrefix = "cli:"

	// How often the sessions of terminals that closed are forgotten.
	cliSweepEvery = time.Minute
)

// cliGate is the developer's Stop of a terminal's browser server (FR-CONT-022), which tests replace.
var cliGate = agentlinks.GateBlock

func cliSource(blockId string) string {
	return cliSourcePrefix + blockId
}

func isCliSource(source string) bool {
	return strings.HasPrefix(source, cliSourcePrefix)
}

// CliCall runs one tool for the terminal the caller's token names. The caller must be that terminal's own wsh, and the
// token is checked as Hello checks it: nothing else names the terminal.
func (m *Manager) CliCall(ctx context.Context, caller localroute.Caller, req mcpbrowser.CliRequest) mcpbrowser.CallResult {
	blockId, err := m.cliPane(ctx, caller, req.Token)
	if err != nil {
		return mcpbrowser.ErrorResult(err.Error())
	}
	if !mcpbrowser.CliTool(req.Tool) {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrUnknownTool)
	}
	// The developer's Stop of this terminal's browser server holds for the command line too, and ends the tabs it holds.
	if err := cliGate(blockId, agentlinkwire.ServerBrowser); err != nil {
		m.endSessions(func(s *session) bool { return s.source == cliSource(blockId) }, "stopped by the developer")
		return mcpbrowser.ErrorResult(err.Error())
	}
	var result mcpbrowser.CallResult
	// A session that went with its route between the lookup and the call is not the command's fault: look again once.
	for attempt := 0; attempt < 2; attempt++ {
		info, source := m.paneSession(blockId)
		result = m.Call(ctx, source, mcpbrowser.CallRequest{SessionId: info.id, Tool: req.Tool, Args: req.Args})
		if !(result.IsError && len(result.Content) > 0 && result.Content[0].Text == mcpbrowser.ErrSessionEnded) {
			return result
		}
	}
	return result
}

func (m *Manager) cliPane(ctx context.Context, caller localroute.Caller, token string) (string, error) {
	if token == "" || !caller.IsLocalTerminal {
		return "", errors.New(mcpbrowser.ErrNotInMoltenTerm)
	}
	blockId, err := m.env.VerifyToken(token)
	if err != nil || blockId == "" {
		return "", errors.New(mcpbrowser.ErrNotInMoltenTerm)
	}
	if caller.BlockId != "" && caller.BlockId != blockId {
		return "", errors.New(mcpbrowser.ErrNotInMoltenTerm)
	}
	if err := m.checkPane(ctx, blockId); err != nil {
		return "", err
	}
	return blockId, nil
}

// paneSession is the session the terminal's commands run in, and the route it answers to: the newest one the terminal
// has that is not parked, whoever opened it, else a new one of the command line's.
func (m *Manager) paneSession(blockId string) (sessionInfo, string) {
	if info, source, ok := m.newestSessionOf(blockId); ok {
		return info, source
	}
	name := agentDisplayName(m.env.AgentName(blockId), "")
	source := cliSource(blockId)
	info, opened := m.openSessionLocked(source, blockId, name)
	if opened {
		m.logf("%s session=%s agent=%q started by molten browser\n", logPrefix, shortId(info.id), info.agentName)
	}
	return info, source
}

func (m *Manager) newestSessionOf(blockId string) (sessionInfo, string, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	var newest *session
	for _, s := range m.sessions {
		if s.blockId != blockId || s.parked {
			continue
		}
		if newest == nil || s.started.After(newest.started) {
			newest = s
		}
	}
	if newest == nil {
		return sessionInfo{}, "", false
	}
	return sessionInfo{id: newest.id, blockId: newest.blockId, agentName: newest.agentName}, newest.source, true
}

// adoptCliSessionLocked gives the session a terminal's commands opened to the MCP server that connects for the same
// terminal: the agent keeps the tabs it opened from the command line, and the terminal keeps one session, which is
// the one the panel's Share with agent offers.
func (m *Manager) adoptCliSessionLocked(source string, blockId string, name string) (sessionInfo, bool) {
	if isCliSource(source) {
		return sessionInfo{}, false
	}
	s := m.sessionOnLocked(cliSource(blockId), blockId)
	if s == nil {
		return sessionInfo{}, false
	}
	s.source = source
	s.agentName = name
	return sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName}, true
}

// sweepCliSessions ends the command line's sessions whose terminal is gone: no route going down tells it, as it does
// for an MCP server's session. Their tabs stay open as the developer's.
func (m *Manager) sweepCliSessions(ctx context.Context) {
	for _, s := range m.cliSessions() {
		if _, ok := m.paneOf(ctx, s.blockId); ok {
			continue
		}
		m.endSessions(func(x *session) bool { return x.id == s.id && isCliSource(x.source) }, "terminal closed")
	}
}

func (m *Manager) cliSessions() []sessionInfo {
	m.lock.Lock()
	defer m.lock.Unlock()
	var rtn []sessionInfo
	for _, s := range m.sessions {
		if isCliSource(s.source) {
			rtn = append(rtn, sessionInfo{id: s.id, blockId: s.blockId, agentName: s.agentName})
		}
	}
	return rtn
}
