// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package mcpreview is `molten mcp review` (FR-REV-004, DS-REV-005): the stdio MCP server a review session's agent
// runs to read the PR it reviews and to post into MoltenTerm. Like mcpbrowser, it holds the protocol and the tool
// definitions only: the server process is plumbing, and the session token, the link check and every effect are
// wavesrv's (pkg/molten/reviewsession). It also names the commands MoltenTerm's windows use to start and end a review
// session.
package mcpreview

import (
	"encoding/json"
	"strconv"
)

// The review sessions' route on wavesrv's router, answering plain command names: nothing is declared in pkg/wshrpc.
// Must match frontend/moltenterm-shell/review/review-session.ts.
const (
	ServerName = "molten-review"
	RouteId    = "molten:reviewsession"
	// WPS event with a session's changes (scope: ScopeOf(repo, number)).
	Event = "molten:reviewsession"

	// The MCP server's commands.
	HelloCommand = "moltenreviewhello"
	CallCommand  = "moltenreviewcall"
	ByeCommand   = "moltenreviewbye"

	// The windows' commands: start or reattach, end, read one or all sessions, set the selection, read the posts.
	StartCommand     = "moltenreviewstart"
	EndCommand       = "moltenreviewend"
	GetCommand       = "moltenreviewget"
	ListCommand      = "moltenreviewlist"
	SelectionCommand = "moltenreviewselection"
	PostsCommand     = "moltenreviewposts"
	// The Review tab moved to a new head of the PR; asking for a new briefing types a prompt into the agent.
	SetHeadCommand = "moltenreviewsethead"
	BriefCommand   = "moltenreviewbrief"
	// Ask the AI (FR-REV-003): the selection is set and the question typed into the session's terminal, or queued
	// while the agent is busy (FR-REV-006 AC4); a queued question can be removed.
	AskCommand       = "moltenreviewask"
	AskCancelCommand = "moltenreviewaskcancel"

	// The agent's environment carries the session token (DS-REV-004); the MCP server sends it with each hello.
	SessionTokenVarName = "MOLTEN_REVIEW_SESSION"
	// The review session's terminal block: its session (JSON), so a restarted wavesrv finds it again.
	SessionMetaKey = "molten:reviewsession"
)

// The tools (DS-REV-005). Read tools only read the PR; output tools only change MoltenTerm's local review state.
// No tool publishes, approves, merges or writes a file: those are MoltenTerm buttons (DS-REV-011).
const (
	ToolContext         = "review_context"
	ToolFiles           = "review_files"
	ToolDiff            = "review_diff"
	ToolSelection       = "review_selection"
	ToolPostBriefing    = "review_post_briefing"
	ToolPostExplanation = "review_post_explanation"
	ToolProposeComment  = "review_propose_comment"
	ToolSetTranslation  = "review_set_translation"
	ToolKeepNote        = "review_keep_note"
	ToolReplyComment    = "review_reply_comment"
)

// What a session's terminal is doing.
const (
	StateStarting = "starting"
	StateRunning  = "running"
	// Failed: the agent could not be started in the terminal (Message says why, Command is what to type).
	StateFailed = "failed"
)

// Start outcomes.
const (
	StatusStarted  = "started"
	StatusAttached = "attached"
	StatusNoAgent  = "noagent"
	StatusFailed   = "failed"
)

// Where the session reads the PR.
const (
	WorktreeAgent  = "agent"
	WorktreeReview = "review"
)

// What a post is.
const (
	PostBriefing    = "briefing"
	PostExplanation = "explanation"
	PostProposal    = "proposal"
	PostTranslation = "translation"
	PostKeepNote    = "keepnote"
	// Reply: the agent's answer on a comment the developer discussed (FR-REV-009).
	PostReply = "reply"
)

const (
	SideRight = "RIGHT"
	SideLeft  = "LEFT"

	DepthQuick    = "quick"
	DepthDetailed = "detailed"

	KindComment = "comment"
	KindChange  = "change"
)

// MaxResultBytes: a larger result is cut, with a note telling the agent to read the file in the worktree (DS-REV-005).
const MaxResultBytes = 64 * 1024

// Fixed sentences the agent sees.
const (
	ErrNotInMoltenTerm = "Not running in a MoltenTerm review session"
	ErrRemotePane      = "MoltenTerm's review tools answer local terminals only, not over SSH or WSL"
	ErrSessionEnded    = "This review session has ended"
	ErrUnknownTool     = "Unknown tool"
	ErrPathRequired    = "path must be a file of this PR (see review_files)"
	ErrMarkdownNeeded  = "markdown must not be empty"
	ErrTextNeeded      = "text must not be empty"
	ErrAnchorNeeded    = "anchor must be {path, side: RIGHT or LEFT, line, startline?}"
	ErrDepth           = "depth must be quick or detailed"
	ErrQuickPrinciples = "a quick answer names one principle at most: keep the one these lines show best, or answer in detailed depth"
	ErrSourcesNeeded   = "sources must list what the answer comes from: the lines read (path:line), and the ticket, plan, " +
		"SRS page, commit, code comment or project rule that gives the reason"
	ErrRelatedFormat  = "each related entry is path:line or path:start-end, a file of the worktree relative to its root: %q"
	ErrRelatedMissing = "related %q: the worktree has no such file or line; search the worktree and give a line that exists"
	ErrKind           = "kind must be comment or change"
	ErrIdNeeded       = "the id is required"
	ErrTooLarge       = "the text is too large (64 KB at most)"
	ErrNotDiscussed   = "commentid must be a comment the developer discussed in this session (review_selection names it)"
	ErrLineNotInFile  = "the anchor's lines are not in that side of the file (see review_diff)"
	ErrNotToTranslate = "commentid must be one of the items MoltenTerm asked you to translate (review_context's translate)"
)

// HelloRequest opens the MCP server's connection to its session. Token is the terminal's WAVETERM_JWT (wavesrv takes
// the terminal from it); SessionToken is MOLTEN_REVIEW_SESSION, which must be the token of that terminal's session.
type HelloRequest struct {
	Token         string `json:"token"`
	SessionToken  string `json:"sessiontoken"`
	ClientName    string `json:"clientname,omitempty"`
	ClientVersion string `json:"clientversion,omitempty"`
}

type HelloResult struct {
	ConnId string `json:"connid"`
	Repo   string `json:"repo"`
	Number int    `json:"number"`
}

// CallRequest is one tool call; the answer is an mcpbrowser.CallResult.
type CallRequest struct {
	ConnId string          `json:"connid"`
	Tool   string          `json:"tool"`
	Args   json.RawMessage `json:"args,omitempty"`
}

type ByeRequest struct {
	ConnId string `json:"connid"`
}

// Anchor is a place in the PR, exactly GitHub's review comment position (DS-REV-003): side RIGHT is the head, LEFT
// the base; startline is set for a range.
type Anchor struct {
	Path      string `json:"path"`
	Side      string `json:"side"`
	StartLine int    `json:"startline,omitempty"`
	Line      int    `json:"line"`
	HeadOid   string `json:"headoid,omitempty"`
	Excerpt   string `json:"excerpt,omitempty"`
}

// StartRequest starts the review session of a PR, or reattaches the one it has. The caller (the Review tab) knows the
// PR from the developer's gh; HeadOid is read from the project's git when it is not given.
type StartRequest struct {
	// TabId: the tab the session's terminal goes in; empty, the calling window's tab.
	TabId      string `json:"tabid,omitempty"`
	ProjectDir string `json:"projectdir"`
	// Repo: owner/name.
	Repo    string `json:"repo"`
	Number  int    `json:"number"`
	Title   string `json:"title,omitempty"`
	HeadRef string `json:"headref"`
	HeadOid string `json:"headoid,omitempty"`
	BaseRef string `json:"baseref,omitempty"`
	// Agent: claude or codex; empty, the first installed in the agent registry's order.
	Agent string `json:"agent,omitempty"`
	// Brief: the agent starts by briefing the PR (FR-REV-005); false when the review store has a briefing of this head.
	Brief bool `json:"brief,omitempty"`
	// AfterBlockId: the session's terminal is split under this block (the AI panel, DS-REV-012); empty, it is added
	// to the tab.
	AfterBlockId string `json:"afterblockid,omitempty"`
}

// SetHeadRequest moves a running session to the head the Review tab shows now; Brief asks the agent for a new
// briefing of it.
type SetHeadRequest struct {
	SessionKey
	HeadOid string `json:"headoid"`
	Brief   bool   `json:"brief,omitempty"`
}

// What asking the agent for a briefing did.
const (
	BriefAsked = "asked"
	// Typed: the prompt was typed without Enter, after an unsent draft of the developer's.
	BriefTyped = "typed"
	// Busy: the agent is working or waiting for an answer, or another program is in the foreground; nothing was typed.
	BriefBusy   = "busy"
	BriefFailed = "failed"
)

type BriefResult struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// BriefingPrompt is what MoltenTerm asks the agent, as its first prompt or typed into its terminal after a push.
func BriefingPrompt(headOid string, moved bool) string {
	if moved {
		return "MoltenTerm: the pull request moved to the head " + shortOid(headOid) + ". Read review_context again and " +
			"post a new briefing of the whole PR with review_post_briefing, following the briefing section of the review guide."
	}
	return "MoltenTerm: brief this pull request. Read review_context, then post the briefing with review_post_briefing, " +
		"following the briefing section of the review guide, in the developerlanguage it names."
}

func shortOid(oid string) string {
	if len(oid) > 8 {
		return oid[:8]
	}
	return oid
}

// SessionKey names a PR's session: by its id, or by repo and number.
type SessionKey struct {
	Id     string `json:"id,omitempty"`
	Repo   string `json:"repo,omitempty"`
	Number int    `json:"number,omitempty"`
}

// SessionInfo is a review session as the windows see it. The token is never in it.
type SessionInfo struct {
	Id           string `json:"id"`
	Repo         string `json:"repo"`
	Number       int    `json:"number"`
	Title        string `json:"title,omitempty"`
	ProjectDir   string `json:"projectdir"`
	HeadRef      string `json:"headref"`
	HeadOid      string `json:"headoid"`
	BaseRef      string `json:"baseref,omitempty"`
	Worktree     string `json:"worktree"`
	WorktreeKind string `json:"worktreekind"`
	Agent        string `json:"agent"`
	AgentName    string `json:"agentname"`
	BlockId      string `json:"blockid"`
	TabId        string `json:"tabid,omitempty"`
	// Command: the line typed in the terminal to start the agent.
	Command   string `json:"command,omitempty"`
	State     string `json:"state"`
	Message   string `json:"message,omitempty"`
	StartedAt int64  `json:"startedat"`
	// Connected: the agent's molten-review server is connected now.
	Connected bool `json:"connected"`
	// Questions: the developer's questions waiting for the agent to be idle, oldest first (FR-REV-006 AC4).
	Questions []QueuedQuestion `json:"questions,omitempty"`
	// QueueNote says why the queue does not move (a question typed without Enter) or what the last delivery did
	// when it failed.
	QueueNote string `json:"queuenote,omitempty"`
}

// QueuedQuestion is a question of Ask the AI that waits for the agent to be idle.
type QueuedQuestion struct {
	Id       string  `json:"id"`
	Anchor   *Anchor `json:"anchor,omitempty"`
	Text     string  `json:"text,omitempty"`
	Question string  `json:"question"`
	Depth    string  `json:"depth,omitempty"`
	QueuedAt int64   `json:"queuedat"`
}

type StartResult struct {
	Status  string       `json:"status"`
	Message string       `json:"message,omitempty"`
	Session *SessionInfo `json:"session,omitempty"`
}

type ListResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

// SelectionRequest sets the lines the developer selected in the Review tab (FR-REV-003), which review_selection reads.
type SelectionRequest struct {
	SessionKey
	Anchor *Anchor `json:"anchor,omitempty"`
	Text   string  `json:"text,omitempty"`
	// Question: the developer's question on the selection (Ask the AI), whole even when the typed line could not hold it.
	Question string `json:"question,omitempty"`
	// Depth: the depth the developer asked the answer in (FR-REV-007 AC8).
	Depth string `json:"depth,omitempty"`
	// Comment: the review comment the developer discusses (FR-REV-009), on the selection's lines.
	Comment *CommentRef `json:"comment,omitempty"`
}

// CommentRef is a review comment as the session's agent sees it when the developer discusses it.
type CommentRef struct {
	Id string `json:"id"`
	// Kind: comment (a remark or question for the PR's author) or change (a change request).
	Kind string `json:"kind"`
	// Subject: line (a comment on the lines) or file (a file-level comment quoting them).
	Subject  string `json:"subject,omitempty"`
	State    string `json:"state,omitempty"`
	Text     string `json:"text"`
	Lang     string `json:"lang,omitempty"`
	Outdated bool   `json:"outdated,omitempty"`
}

// DiscussRequest is Discuss on a comment (FR-REV-009): the comment and its lines become the session's selection and
// one line is typed into the agent's terminal; the answer is an AskResult. wavesrv's review service, which keeps the
// comments, sends it in process (reviewsession.Discuss): windows go through the review route.
type DiscussRequest struct {
	SessionKey
	Anchor  *Anchor    `json:"anchor"`
	Comment CommentRef `json:"comment"`
	// Message: the developer's words about the comment; empty, the agent is asked for its opinion.
	Message string `json:"message,omitempty"`
}

// SummaryId names the review's summary in a translation request and in review_set_translation (FR-REV-010).
const SummaryId = "summary"

// TranslateItem is one text to translate for publication: a staged comment (Id is its id) or the review's summary
// (SummaryId).
type TranslateItem struct {
	Id string `json:"id"`
	// Kind: comment or change; Where: the lines it lands on, for the agent's context.
	Kind  string `json:"kind,omitempty"`
	Where string `json:"where,omitempty"`
	Text  string `json:"text"`
	Lang  string `json:"lang,omitempty"`
}

// TranslateRequest asks the session's agent to translate the staged comments into the publication language
// (DS-REV-008): the items become review_context's translate, and one line is typed into the agent's terminal; the
// answer is an AskResult. wavesrv's review service sends it in process (reviewsession.Translate).
type TranslateRequest struct {
	SessionKey
	Lang     string          `json:"lang"`
	LangName string          `json:"langname,omitempty"`
	Items    []TranslateItem `json:"items"`
}

// AskRequest is Ask the AI (FR-REV-003): the selection becomes the session's (review_selection) and the question is
// typed into the agent's terminal with the selection's reference. No anchor: a question on the PR.
type AskRequest struct {
	SessionKey
	Anchor   *Anchor `json:"anchor,omitempty"`
	Text     string  `json:"text,omitempty"`
	Question string  `json:"question"`
	// Depth: the answer's depth the developer chose (FR-REV-007 AC8), quick or detailed; empty is quick.
	Depth string `json:"depth,omitempty"`
}

// AskResult: Sent, the line was typed (Submitted: with Enter; otherwise it waits in the agent's prompt behind a draft
// of the developer's). Queued: the agent is working or waiting for an answer, or other questions wait before this
// one: it is typed once the agent is idle (Position: 1 for the next one). Message says what happened in words.
type AskResult struct {
	Sent      bool `json:"sent"`
	Submitted bool `json:"submitted,omitempty"`
	Busy      bool `json:"busy,omitempty"`
	// Starting: the session's agent is starting; nothing was typed or queued, send again once it is ready (#638).
	Starting   bool   `json:"starting,omitempty"`
	Queued     bool   `json:"queued,omitempty"`
	QuestionId string `json:"questionid,omitempty"`
	Position   int    `json:"position,omitempty"`
	Line       string `json:"line,omitempty"`
	Message    string `json:"message,omitempty"`
}

// AskCancelRequest removes a queued question.
type AskCancelRequest struct {
	SessionKey
	QuestionId string `json:"questionid"`
}

// Post is what the agent posted through an output tool: a card of the AI panel, a comment proposal, a translation or
// a note to keep. The later stories keep them in the review store (DS-REV-007).
type Post struct {
	Id       string `json:"id"`
	Kind     string `json:"kind"`
	At       int64  `json:"at"`
	Markdown string `json:"markdown,omitempty"`
	Text     string `json:"text,omitempty"`
	// Question: the developer's question an explanation answers (FR-REV-006).
	Question string `json:"question,omitempty"`
	// Technique: the name of the technique or pattern an explanation teaches (FR-REV-007 AC1), the card's title.
	Technique     string   `json:"technique,omitempty"`
	Anchor        *Anchor  `json:"anchor,omitempty"`
	Depth         string   `json:"depth,omitempty"`
	Sources       []string `json:"sources,omitempty"`
	Related       []string `json:"related,omitempty"`
	Principles    []string `json:"principles,omitempty"`
	CommentKind   string   `json:"commentkind,omitempty"`
	CommentId     string   `json:"commentid,omitempty"`
	ExplanationId string   `json:"explanationid,omitempty"`
	// HeadOid: the head the session reviewed when the agent posted; Agent: the agent's id.
	HeadOid string `json:"headoid,omitempty"`
	Agent   string `json:"agent,omitempty"`
	// A proposal's subject (line inside a hunk, else file) and language, filled by MoltenTerm (FR-REV-009).
	Subject string `json:"subject,omitempty"`
	Lang    string `json:"lang,omitempty"`
}

type PostsResult struct {
	Posts []Post `json:"posts"`
}

// Update is the event's data: a session that changed, ended, or got a post (with its PR, so the review store can
// keep it).
type Update struct {
	Session *SessionInfo `json:"session,omitempty"`
	Ended   bool         `json:"ended,omitempty"`
	Post    *Post        `json:"post,omitempty"`
	Repo    string       `json:"repo,omitempty"`
	Number  int          `json:"number,omitempty"`
}

// ScopeOf is the event scope of a PR's session.
func ScopeOf(repo string, number int) string {
	return "review:" + repo + "#" + strconv.Itoa(number)
}
