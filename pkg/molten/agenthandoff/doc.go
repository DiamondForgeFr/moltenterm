// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agenthandoff hands work from one agent to another by first name (FR-CONT-015, DS-CONT-029). The sending agent
// fills a brief (goal, context, files, links, whether it expects a reply); wavesrv writes it as Markdown in MoltenTerm's
// data folder, never in a project, and types a short prompt pointing to it into the receiver's terminal through the
// guarded path Share and tell uses (pkg/molten/termupdate), queued until the receiver's prompt is idle. The first send
// between two agents asks the developer; the answer is kept in memory for the pair until MoltenTerm restarts.
//
// The MCP tools list_agents and send_to_agent (served by `molten mcp browser`, the server MoltenTerm's launcher gives
// Claude Code and Codex) and `molten agent list` / `molten agent send` all come here with the pane's WAVETERM_JWT: the
// sender is the pane the token was issued to, never a name taken from the request. The messages are in
// pkg/molten/handoffwire.
package agenthandoff

import "github.com/wavetermdev/waveterm/pkg/molten/handoffwire"

type (
	ListRequest   = handoffwire.ListRequest
	ListResult    = handoffwire.ListResult
	AgentEntry    = handoffwire.AgentEntry
	FileRef       = handoffwire.FileRef
	LinkRef       = handoffwire.LinkRef
	Brief         = handoffwire.Brief
	SendRequest   = handoffwire.SendRequest
	SendResult    = handoffwire.SendResult
	AnswerRequest = handoffwire.AnswerRequest
)

const (
	RouteId               = handoffwire.RouteId
	ListCommand           = handoffwire.ListCommand
	SendCommand           = handoffwire.SendCommand
	AnswerCommand         = handoffwire.AnswerCommand
	AnswerGesture         = handoffwire.AnswerGesture
	NotificationKeyPrefix = handoffwire.NotificationKeyPrefix
	NotificationSource    = handoffwire.NotificationSource
	DecisionOnce          = handoffwire.DecisionOnce
	DecisionAlways        = handoffwire.DecisionAlways
	DecisionBlock         = handoffwire.DecisionBlock
	DecisionDismiss       = handoffwire.DecisionDismiss
	StatusDelivered       = handoffwire.StatusDelivered
	StatusTyped           = handoffwire.StatusTyped
	StatusQueued          = handoffwire.StatusQueued
	StatusPending         = handoffwire.StatusPending
	LinkKindTicket        = handoffwire.LinkKindTicket
	LinkKindPr            = handoffwire.LinkKindPr
	LinkKindSrs           = handoffwire.LinkKindSrs
	LinkKindUrl           = handoffwire.LinkKindUrl
	LinkKindBrowser       = handoffwire.LinkKindBrowser
)

// activeAgent is an entry of the list with the pane it is in, which the list never shows.
type activeAgent struct {
	AgentEntry
	blockId string
}
