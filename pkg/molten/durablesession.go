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

	// HandedByMetaKey: the terminal block of the agent that first handed work to this one (FR-CONT-015); the
	// Sessions table nests the receiver under it (FR-SHELL-058, #933).
	HandedByMetaKey = "molten:handedby"

	// SessionOriginReview: a Review panel session (FR-REV); the other origins are the kinds of the agents the review
	// actions start (pkg/molten/review/agentstart.go).
	SessionOriginReview = "review"

	// The state of a session's pull request, "" when the collector does not know it.
	SessionPrDraft  = "draft"
	SessionPrOpen   = "open"
	SessionPrMerged = "merged"
	SessionPrClosed = "closed"
)

type SessionWorktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	// Main: the repository's main checkout (the project), "" when unknown.
	Main string `json:"main,omitempty"`
}

// SessionOrigin says which MoltenTerm action started the session's agent (#933); nil for a direct session.
type SessionOrigin struct {
	Kind   string `json:"kind"`
	Repo   string `json:"repo,omitempty"`
	Number int    `json:"number,omitempty"`
	// At: when the developer asked, Unix milliseconds.
	At int64 `json:"at,omitempty"`
}

// SessionContext is what a session works on (#933): its ticket and its pull request, read from what MoltenTerm
// already knows (the collector's cache, the branch naming), never from a new call to GitHub.
type SessionContext struct {
	Repo    string `json:"repo,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
	Pr      int    `json:"pr,omitempty"`
	PrTitle string `json:"prtitle,omitempty"`
	PrUrl   string `json:"prurl,omitempty"`
	PrState string `json:"prstate,omitempty"`
}

// SessionContextQuery is what a build asks of the context lookup: the project (a worktree's main checkout), the
// branch, and the repository and PR an origin names.
type SessionContextQuery struct {
	Project string
	Branch  string
	Repo    string
	Number  int
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
	// FirstName: the agent's first name (FR-CONT-014); Model, ModelName, Effort: as the agent last reported them.
	FirstName string `json:"firstname,omitempty"`
	Model     string `json:"model,omitempty"`
	ModelName string `json:"modelname,omitempty"`
	Effort    string `json:"effort,omitempty"`
	// Origin: the MoltenTerm action that started it, nil for a direct session; Context: its ticket and PR.
	Origin  *SessionOrigin  `json:"origin,omitempty"`
	Context *SessionContext `json:"context,omitempty"`
	// ParentId: the session that handed it work, when that one is listed.
	ParentId string `json:"parentid,omitempty"`
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
	// show: where a session not in a pane opens, when it was dropped on a panel (drag to split, FR-SHELL-060).
	PanePlacement
}

// PanePlacement puts a reattached pane beside a panel of the tab: Split is the side (right, down, left, up). Empty,
// the pane goes where Wave puts a new block.
type PanePlacement struct {
	TargetBlockId string `json:"targetblockid,omitempty"`
	Split         string `json:"split,omitempty"`
}

// SplitAction is the layout split for the placement's side: horizontal puts the panes side by side.
func (p PanePlacement) SplitAction() (horizontal bool, position string, ok bool) {
	if p.TargetBlockId == "" {
		return false, "", false
	}
	switch p.Split {
	case "right":
		return true, "after", true
	case "left":
		return true, "before", true
	case "down":
		return false, "after", true
	case "up":
		return false, "before", true
	}
	return false, "", false
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
