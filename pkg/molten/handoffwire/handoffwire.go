// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package handoffwire is what wsh (the MCP server, `molten agent list` and `molten agent send`) and wavesrv's handoff
// route (pkg/molten/agenthandoff) exchange, with no dependency on wavesrv.
package handoffwire

// The route's plain commands (the pattern of pkg/molten/browseragent/route.go): nothing is declared in pkg/wshrpc.
// Must match frontend/moltenterm-shell/agent-handoff.ts.
const (
	RouteId       = "molten:agenthandoff"
	ListCommand   = "moltenagenthandofflist"
	SendCommand   = "moltenagenthandoffsend"
	AnswerCommand = "moltenagenthandoffanswer"

	// The notification gesture a window runs for the developer's answer.
	AnswerGesture = "molten:agenthandoff"
	// Notifications of one request: NotificationKeyPrefix + request id.
	NotificationKeyPrefix = "agenthandoff:"
	NotificationSource    = "agents"

	DecisionOnce   = "once"
	DecisionAlways = "always"
	DecisionBlock  = "block"
	// The toast went away without an answer: this send is refused, nothing is remembered.
	DecisionDismiss = "dismiss"

	StatusDelivered = "delivered"
	// Typed without Enter: the receiver's prompt may hold the user's unsent message.
	StatusTyped  = "typed"
	StatusQueued = "queued"
	// The developer had not answered when the sender stopped waiting: the request stays in the notifications, and the
	// outcome is typed in the sender's terminal once they answer (#790).
	StatusPending = "pending"

	LinkKindTicket  = "ticket"
	LinkKindPr      = "pr"
	LinkKindSrs     = "srs"
	LinkKindUrl     = "url"
	LinkKindBrowser = "browser"
)

// ListRequest: Token is the calling pane's WAVETERM_JWT.
type ListRequest struct {
	Token string `json:"token"`
	// WaitName: wait a little for the caller's own first name when its agent is not seen yet (the MCP server asks at
	// the agent's start, which may come before MoltenTerm sees the agent).
	WaitName bool `json:"waitname,omitempty"`
}

// AgentEntry is one active agent another agent may address.
type AgentEntry struct {
	FirstName string `json:"firstname"`
	Agent     string `json:"agent"`
	AgentName string `json:"agentname"`
	State     string `json:"state,omitempty"`
	Project   string `json:"project,omitempty"`
	// ProjectDir: the project folder (the workspace's project, else the folder's git root, else the folder).
	ProjectDir string `json:"projectdir,omitempty"`
	Folder     string `json:"folder,omitempty"`
	Workspace  string `json:"workspace,omitempty"`
	Tab        string `json:"tab,omitempty"`
	// You: the caller's own agent.
	You bool `json:"you,omitempty"`
	// Model, ModelName, Effort: what the agent last reported for this run (#549), "" when unknown; `molten agent whoami`
	// signs work with them (#847).
	Model     string `json:"model,omitempty"`
	ModelName string `json:"modelname,omitempty"`
	Effort    string `json:"effort,omitempty"`
}

type ListResult struct {
	// You: the caller's own agent, when an agent runs in its pane.
	You    *AgentEntry  `json:"you,omitempty"`
	Agents []AgentEntry `json:"agents"`
}

// FileRef is a file the receiver needs. Path is absolute (a relative one is taken from the sender's folder).
type FileRef struct {
	Path    string `json:"path"`
	Project string `json:"project,omitempty"`
	// Lines: "42" or "40-60", quoted in the brief.
	Lines   string `json:"lines,omitempty"`
	Excerpt string `json:"excerpt,omitempty"`
	Note    string `json:"note,omitempty"`
}

// LinkRef is a ticket, a PR, an SRS page, a URL, or a browser page; TabId names one of the sender's MoltenTerm browser
// tabs (from tabs_context), whose page MoltenTerm reads.
type LinkRef struct {
	Url   string `json:"url,omitempty"`
	Title string `json:"title,omitempty"`
	Kind  string `json:"kind,omitempty"`
	TabId int64  `json:"tabid,omitempty"`
	Note  string `json:"note,omitempty"`
}

// Brief is what the receiver needs to act without asking back. JSON field names are matched case-insensitively, so an
// MCP client's tabId reaches TabId.
type Brief struct {
	Goal    string    `json:"goal"`
	Context string    `json:"context,omitempty"`
	Files   []FileRef `json:"files,omitempty"`
	Links   []LinkRef `json:"links,omitempty"`
	Reply   bool      `json:"reply,omitempty"`
}

type SendRequest struct {
	Token string `json:"token"`
	To    string `json:"to"`
	Brief Brief  `json:"brief"`
}

type SendResult struct {
	Status string `json:"status"`
	// To: the receiver's first name as MoltenTerm holds it.
	To        string `json:"to"`
	BriefPath string `json:"briefpath"`
	Message   string `json:"message"`
}

// AnswerRequest is the developer's answer from a window's notification.
type AnswerRequest struct {
	RequestId string `json:"requestid"`
	Decision  string `json:"decision"`
}
