// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"fmt"
	"sort"
	"strings"
)

// Durable sessions (FR-SHELL-020, DS-SHELL-021): every durable terminal still running, local or SSH, with what runs in
// it and where its pane is, if any. wavesrv builds the list (pkg/molten/sessions) and serves it on a router leaf that
// answers plain command names, like the agent states; the Sessions view, Welcome back (#157) and `molten session`
// (#159) read the same model. The names say "durable session" because Session is taken (agent transcripts, Mission
// Control's release sessions).

// must match frontend/moltenterm-shell/sessions/sessions-model.ts
const (
	DurableSessionsRoute = "molten:sessions"
	DurableSessionsEvent = "molten:sessions"

	DurableSessionsListCommand      = "moltensessionslist"
	DurableSessionsShowCommand      = "moltensessionsshow"
	DurableSessionsEndCommand       = "moltensessionsend"
	DurableSessionsCleanupCommand   = "moltensessionscleanup"
	DurableSessionsReconnectCommand = "moltensessionsreconnect"

	// A tab's renderer focuses this block once it shows the tab ({blockid, ts}), then clears the key.
	FocusBlockMetaKey = "molten:focusblock"

	SessionConnConnected    = "connected"
	SessionConnReconnecting = "reconnecting"
	SessionConnDisconnected = "disconnected"

	// Why a session is not in a pane.
	SessionReasonDetached = "detached"
	SessionReasonPaneGone = "panegone"
	SessionReasonReplaced = "replaced"
	// States that apply to any session, in a pane or not: it was started by an older MoltenTerm (it can only be
	// ended), or it is being ended (its host was unreachable when it was asked to end).
	SessionReasonOlderVersion = "olderversion"
	SessionReasonEnding       = "ending"

	ShortSessionIdLength = 8
)

type SessionWorktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
}

type DurableSession struct {
	// The job's id.
	Id         string `json:"id"`
	ShortId    string `json:"shortid"`
	Connection string `json:"connection"`
	ConnState  string `json:"connstate"`
	ConnError  string `json:"connerror,omitempty"`

	Agent      string `json:"agent,omitempty"`
	AgentName  string `json:"agentname,omitempty"`
	AgentState string `json:"agentstate,omitempty"`
	// The command line running, or the shell's name and "at prompt".
	Command string `json:"command,omitempty"`

	Folder   string           `json:"folder,omitempty"`
	Worktree *SessionWorktree `json:"worktree,omitempty"`

	// Unix milliseconds.
	StartedAt    int64 `json:"startedat,omitempty"`
	LastOutputAt int64 `json:"lastoutputat,omitempty"`

	WorkspaceId    string `json:"workspaceid,omitempty"`
	WorkspaceName  string `json:"workspacename,omitempty"`
	WorkspaceColor string `json:"workspacecolor,omitempty"`
	// The workspace's place in Wave's list (the rail's order); -1 without a workspace.
	WorkspaceOrder int    `json:"workspaceorder"`
	TabId          string `json:"tabid,omitempty"`
	TabName        string `json:"tabname,omitempty"`
	BlockId        string `json:"blockid,omitempty"`

	Shown   bool   `json:"shown"`
	Reason  string `json:"reason,omitempty"`
	CanShow bool   `json:"canshow"`
	CanEnd  bool   `json:"canend"`
}

type DurableSessionsData struct {
	Sessions      []DurableSession `json:"sessions"`
	RunningAgents int              `json:"runningagents"`
	Version       int64            `json:"version"`
}

type DurableSessionRequest struct {
	Id string `json:"id"`
	// show: the tab a session not in a pane opens in (the caller's).
	TabId string `json:"tabid,omitempty"`
	// end: the terminal asking (`molten session end` from a terminal), which cannot end its own session.
	CallerBlockId string `json:"callerblockid,omitempty"`
}

type DurableSessionsCleanupRequest struct {
	Ids []string `json:"ids"`
}

type DurableSessionsCleanupResult struct {
	Ended   []string `json:"ended"`
	Skipped []string `json:"skipped"`
	// Ids whose end failed (their host unreachable: they end once it is back).
	Failed []string `json:"failed,omitempty"`
}

// SessionLocation is where a session shows once the request is done.
type SessionLocation struct {
	WorkspaceId string `json:"workspaceid"`
	TabId       string `json:"tabid"`
	BlockId     string `json:"blockid"`
	// Created: the session was reattached into a new pane.
	Created bool `json:"created,omitempty"`
}

type DurableSessionEndResult struct {
	// Pending: the host is unreachable; the session ends once it is back.
	Pending bool `json:"pending,omitempty"`
}

func ShortSessionId(id string) string {
	if len(id) <= ShortSessionIdLength {
		return id
	}
	return id[:ShortSessionIdLength]
}

// ResolveSessionId finds the one id that starts with prefix (a short id from the list, or a whole id).
func ResolveSessionId(prefix string, ids []string) (string, error) {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		return "", fmt.Errorf("no session id given")
	}
	var matches []string
	for _, id := range ids {
		if id == prefix {
			return id, nil
		}
		if strings.HasPrefix(id, prefix) {
			matches = append(matches, id)
		}
	}
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no running session has the id %q", prefix)
	case 1:
		return matches[0], nil
	}
	sort.Strings(matches)
	shorts := make([]string, len(matches))
	for i, m := range matches {
		shorts[i] = ShortSessionId(m)
	}
	return "", fmt.Errorf("%q matches %d sessions (%s): give more characters", prefix, len(matches), strings.Join(shorts, ", "))
}

// SessionConnState is a session's connection as the user sees it. hostStatus is the SSH connection's status (init,
// connecting, connected, disconnected, error; ignored for local), jobStatus the job's route (connected, connecting,
// disconnected).
func SessionConnState(local bool, hostStatus string, jobStatus string) string {
	if local {
		switch jobStatus {
		case SessionConnConnected:
			return SessionConnConnected
		case "connecting":
			return SessionConnReconnecting
		}
		return SessionConnDisconnected
	}
	switch hostStatus {
	case "connecting":
		return SessionConnReconnecting
	case "connected":
		switch jobStatus {
		case SessionConnConnected:
			return SessionConnConnected
		case "connecting":
			return SessionConnReconnecting
		}
	}
	return SessionConnDisconnected
}
