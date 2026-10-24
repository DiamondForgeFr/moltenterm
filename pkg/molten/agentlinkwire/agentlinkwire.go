// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentlinkwire is what the MoltenTerm MCP servers (`molten mcp browser`, `molten mcp review`, in wsh) and
// wavesrv's link registry (pkg/molten/agentlinks) exchange about each server's link to MoltenTerm (FR-CONT-022,
// DS-CONT-031), with no dependency on wavesrv. Only the MCP standard and MoltenTerm's own state are relied on: any
// agent that starts the servers is seen the same way.
package agentlinkwire

// The route's plain commands (the pattern of pkg/molten/handoffwire): nothing is declared in pkg/wshrpc. Must match
// frontend/moltenterm-shell/agent-links/agent-links-model.ts.
const (
	RouteId = "molten:agentlinks"
	// A server's long-held report: wavesrv answers it after WatchHoldMs, or at once with an action.
	WatchCommand = "moltenagentlinkwatch"
	// A server that ends says goodbye: its link leaves the menu.
	ByeCommand = "moltenagentlinkbye"
	// The windows read the links of every terminal, or of one.
	StateCommand = "moltenagentlinkstate"
	// The windows' Reconnect and Stop.
	ControlCommand = "moltenagentlinkcontrol"
	// WPS event with the links of one terminal (scope: the block's oref).
	Event = "molten:agentlinks"
	// The stopped links of a terminal, kept in its block's meta so a restart of MoltenTerm keeps them stopped.
	StopsMetaKey = "molten:agentlinkstops"

	WatchHoldMs = 25000

	ActionReconnect = "reconnect"
	ActionStop      = "stop"

	StateConnected = "connected"
	// The server's link ended and its process lives: it reconnects by itself.
	StateReconnecting = "reconnecting"
	// The server's process is gone while its agent runs: the agent's MoltenTerm tools fail.
	StateBroken = "broken"
	// The developer stopped it from the menu: wavesrv refuses its calls.
	StateStopped = "stopped"
	// A server older than this change, seen only through its browser session: it cannot report or obey.
	StateLegacy = "legacy"

	ServerBrowser = "molten-browser"
	ServerReview  = "molten-review"

	// What the agent reads on every call of a stopped server.
	ErrStopped = "The developer stopped this MCP server's link to MoltenTerm from the terminal's connections menu: " +
		"MoltenTerm refuses its calls until they reconnect it there. Do not retry; tell the developer if you need it."
)

// WatchRequest is a server's report. Token is the pane's WAVETERM_JWT, verified like a handoff's.
type WatchRequest struct {
	Token  string `json:"token"`
	Server string `json:"server"`
	// Pid: the server's process (the same across an in-place re-execution, #1049); AgentPid: its parent, the agent.
	Pid      int `json:"pid"`
	AgentPid int `json:"agentpid,omitempty"`
	// ClientName, ClientVersion: what the agent said in MCP's initialize.
	ClientName    string `json:"clientname,omitempty"`
	ClientVersion string `json:"clientversion,omitempty"`
	// Version: the MoltenTerm version of the program the server runs.
	Version string `json:"version,omitempty"`
	// Failed: calls that failed for want of a link since the server started; LastError: the last such failure.
	Failed      int    `json:"failed,omitempty"`
	LastError   string `json:"lasterror,omitempty"`
	LastErrorAt int64  `json:"lasterrorat,omitempty"`
	// UpdatePending: a new program is on disk and the server switches to it at the agent's next call (#1049);
	// UpdateBlocked: why it kept its version.
	UpdatePending bool   `json:"updatepending,omitempty"`
	UpdateBlocked string `json:"updateblocked,omitempty"`
	// HoldMs: how long wavesrv may hold the answer; 0 answers at once.
	HoldMs int `json:"holdms,omitempty"`
}

type WatchResult struct {
	Action string `json:"action,omitempty"`
}

type ByeRequest struct {
	Token  string `json:"token"`
	Server string `json:"server"`
	Pid    int    `json:"pid"`
}

type StateRequest struct {
	// BlockId: one terminal; "" reads every terminal.
	BlockId string `json:"blockid,omitempty"`
}

type ControlRequest struct {
	BlockId string `json:"blockid"`
	LinkKey string `json:"linkkey"`
	Action  string `json:"action"`
}

// LinkInfo is one MCP server of a terminal as the windows show it.
type LinkInfo struct {
	Key           string `json:"key"`
	Server        string `json:"server"`
	State         string `json:"state"`
	Since         int64  `json:"since,omitempty"`
	Pid           int    `json:"pid,omitempty"`
	AgentPid      int    `json:"agentpid,omitempty"`
	ClientName    string `json:"clientname,omitempty"`
	ClientVersion string `json:"clientversion,omitempty"`
	Version       string `json:"version,omitempty"`
	// Outdated: its program is not the MoltenTerm version running now.
	Outdated      bool   `json:"outdated,omitempty"`
	UpdatePending bool   `json:"updatepending,omitempty"`
	UpdateBlocked string `json:"updateblocked,omitempty"`
	Failed        int    `json:"failed,omitempty"`
	LastError     string `json:"lasterror,omitempty"`
	LastErrorAt   int64  `json:"lasterrorat,omitempty"`
	// Controllable: wavesrv can reach it now (Reconnect and Stop work from the menu).
	Controllable bool `json:"controllable,omitempty"`
}

// AgentInfo is one agent of a terminal: the one MoltenTerm detected in the pane (Main), or another whose MCP client
// started MoltenTerm's servers in the same terminal.
type AgentInfo struct {
	Main      bool   `json:"main,omitempty"`
	Pid       int    `json:"pid,omitempty"`
	Agent     string `json:"agent,omitempty"`
	AgentName string `json:"agentname,omitempty"`
	FirstName string `json:"firstname,omitempty"`
	Model     string `json:"model,omitempty"`
	// ClientName: the MCP client's own name, for an agent MoltenTerm did not detect.
	ClientName string     `json:"clientname,omitempty"`
	Links      []LinkInfo `json:"links"`
}

// BlockLinks is a terminal's agents and links; Version is the MoltenTerm version running now.
type BlockLinks struct {
	BlockId string      `json:"blockid"`
	Version string      `json:"version"`
	Agents  []AgentInfo `json:"agents"`
}
