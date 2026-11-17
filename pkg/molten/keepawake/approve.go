// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The coffee approvals (FR-SHELL-063, DS-SHELL-110 to DS-SHELL-112): while a workspace's coffee holds, the agents'
// PermissionRequest hooks (`molten agent permission`) get an allow for what the deny list lets through. The keeper
// holds the coffees, so it answers; the decision comes from memory, the deny list's `git symbolic-ref` aside.

const (
	PermissionCommand = "keepawakepermission"

	PermissionAllow  = "allow"
	ApprovalApproved = "approved"
	ApprovalAsked    = "asked"

	// MaxApprovals caps the decisions kept in the state; the log file keeps them all.
	MaxApprovals      = 200
	maxApprovalDetail = 300
)

// PermissionRequest is what `molten agent permission` sends of a hook's input.
type PermissionRequest struct {
	BlockId        string         `json:"blockid"`
	Agent          string         `json:"agent,omitempty"`
	SessionId      string         `json:"sessionid,omitempty"`
	Cwd            string         `json:"cwd,omitempty"`
	PermissionMode string         `json:"permissionmode,omitempty"`
	ToolName       string         `json:"toolname"`
	ToolInput      map[string]any `json:"toolinput,omitempty"`
	// Suggestions: the rules the agent offers for "always allow" (Claude Code's permission_suggestions), none when it
	// offers none (#2257).
	Suggestions []any `json:"suggestions,omitempty"`
	// HoldMs: how long the hook may wait for an answer, its own budget less a margin; 0 for an answer at once.
	HoldMs int64 `json:"holdms,omitempty"`
	// FromBlock: the caller's token names BlockId, so the request is that terminal's own. Set by wavesrv, never read
	// from the caller.
	FromBlock bool `json:"-"`
}

// PermissionAnswer: Decision is PermissionAllow, PermissionDeny (Brokk's own session, #2257), or empty to leave the
// request to the agent's prompt. Updated: the agent's own suggested rules to apply ("always allow"); Message: why a
// deny, for the agent.
type PermissionAnswer struct {
	Decision string `json:"decision,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Updated  []any  `json:"updated,omitempty"`
	Message  string `json:"message,omitempty"`
}

// PermissionDeny refuses the request for the agent (the developer's Deny in Brokk's layer, #2257).
const PermissionDeny = "deny"

// OwnSessionAsker answers the requests of MoltenTerm's own agent session (Brokk's, #2257) itself: handled is false
// for any other terminal, which the coffee approvals answer.
type OwnSessionAsker func(ctx context.Context, req PermissionRequest) (answer PermissionAnswer, handled bool)

var ownAskerLock sync.Mutex
var ownAsker OwnSessionAsker

// UseOwnSessionAsker sets the asker of the own session's requests (brokksession sets it at start).
func UseOwnSessionAsker(asker OwnSessionAsker) {
	ownAskerLock.Lock()
	defer ownAskerLock.Unlock()
	ownAsker = asker
}

func getOwnSessionAsker() OwnSessionAsker {
	ownAskerLock.Lock()
	defer ownAskerLock.Unlock()
	return ownAsker
}

// Approval is one decision taken while a coffee held.
type Approval struct {
	Id            string `json:"id"`
	At            int64  `json:"at"`
	WorkspaceId   string `json:"workspaceid,omitempty"`
	WorkspaceName string `json:"workspacename,omitempty"`
	TabName       string `json:"tabname,omitempty"`
	BlockId       string `json:"blockid"`
	Agent         string `json:"agent,omitempty"`
	SessionId     string `json:"sessionid,omitempty"`
	Tool          string `json:"tool"`
	Detail        string `json:"detail,omitempty"`
	Outcome       string `json:"outcome"`
	Reason        string `json:"reason,omitempty"`
	// ReasonText: Reason's code for the windows (#656).
	ReasonText *uimsg.Text `json:"reasontext,omitempty"`
}

// AutoApproveSession is a terminal of a coffee's workspace where an agent runs, and whether its prompts are answered.
type AutoApproveSession struct {
	WorkspaceId string `json:"workspaceid"`
	BlockId     string `json:"blockid"`
	TabName     string `json:"tabname,omitempty"`
	Agent       string `json:"agent"`
	AgentName   string `json:"agentname"`
	Approved    bool   `json:"approved"`
	Reason      string `json:"reason,omitempty"`
	// ReasonText: Reason's code for the windows (#656).
	ReasonText *uimsg.Text `json:"reasontext,omitempty"`
}

// HasCoffee tells whether a workspace's coffee covers its agents' prompts now: it is on and its work runs, or the grace
// delay after the work has not passed. A coffee left on for hours with nothing running holds the computer awake but
// answers nothing (FR-SHELL-023 AC17): the approvals' window is the one the coffee had when it ended after its grace.
func (k *Keeper) HasCoffee(wsId string) bool {
	k.lock.Lock()
	defer k.lock.Unlock()
	rec := k.coffees[wsId]
	if wsId == "" || rec == nil {
		return false
	}
	if rec.working {
		return true
	}
	return !rec.graceStart.IsZero() && k.env.Now().Sub(rec.graceStart) < k.graceLocked()
}

func (k *Keeper) graceLocked() time.Duration {
	if k.cfg.Grace <= 0 {
		return DefaultGrace
	}
	return k.cfg.Grace
}

// RecordApproval keeps a decision, logs it and publishes.
func (k *Keeper) RecordApproval(a Approval) Approval {
	a = k.addApproval(a)
	if k.env.LogApproval != nil {
		k.env.LogApproval(a)
	}
	k.publishIfChanged()
	return a
}

func (k *Keeper) addApproval(a Approval) Approval {
	k.lock.Lock()
	defer k.lock.Unlock()
	k.nextId++
	a.Id = "p" + strconv.FormatInt(k.nextId, 10)
	if a.At == 0 {
		a.At = k.env.Now().UnixMilli()
	}
	k.approvals = append(k.approvals, a)
	if len(k.approvals) > MaxApprovals {
		k.approvals = k.approvals[len(k.approvals)-MaxApprovals:]
	}
	return a
}

// refreshSessions reads which agent sessions the coffees cover; nothing is read while no coffee is on.
func (k *Keeper) refreshSessions(ctx context.Context, wsIds []string) {
	var sessions []AutoApproveSession
	if len(wsIds) > 0 && k.env.Sessions != nil {
		sessions = k.env.Sessions(ctx, wsIds)
	}
	k.lock.Lock()
	defer k.lock.Unlock()
	kept := sessions[:0]
	for _, s := range sessions {
		if k.coffees[s.WorkspaceId] != nil {
			kept = append(kept, s)
		}
	}
	k.autoApprove = kept
}

// approvalsState fills the state's approvals (newest first) and sessions; called under the lock.
func (k *Keeper) approvalsState(state *State) {
	state.AutoApprove = []AutoApproveSession{}
	for _, s := range k.autoApprove {
		if k.coffees[s.WorkspaceId] != nil {
			state.AutoApprove = append(state.AutoApprove, s)
		}
	}
	state.Approvals = make([]Approval, 0, len(k.approvals))
	for i := len(k.approvals) - 1; i >= 0; i-- {
		state.Approvals = append(state.Approvals, k.approvals[i])
	}
}

// ReasonCodexHookUntrusted: Codex runs MoltenTerm's hook only once the developer trusted it (FR-SHELL-064-AC3).
const ReasonCodexHookUntrusted = "approved once you trust MoltenTerm's hook: type /hooks in Codex and trust molten agent permission"

// ReasonReviewSession: a review session's requests are never answered (FR-REV-004 AC3, #505 R1).
const ReasonReviewSession = "a review session is read-only: its requests always ask you"

// SessionApproval says whether a terminal's agent gets its prompts answered while a coffee holds, and why not.
// hookRan: the agent's hook reached wavesrv since it started, so the agent runs it (Codex runs it only once trusted).
func SessionApproval(agent string, remote bool, report molten.AgentIntegrationReport, hasReport bool, hookRan bool) (bool, string) {
	approved, reason, _ := SessionApprovalText(agent, remote, report, hasReport, hookRan)
	return approved, reason
}

// SessionApprovalText is SessionApproval with its reason's code for the windows (#656).
func SessionApprovalText(agent string, remote bool, report molten.AgentIntegrationReport, hasReport bool, hookRan bool) (bool, string, *uimsg.Text) {
	name := molten.AgentDisplayName(agent)
	if remote {
		return false, "it runs on a remote host", uimsg.Make("keepawake.session.remote")
	}
	switch agent {
	case molten.AgentIdClaude, molten.AgentIdCodex:
	default:
		return false, "MoltenTerm cannot answer " + name + "'s prompts", uimsg.Make("keepawake.session.unsupported", "agent", name)
	}
	if !hasReport {
		return false, "it was started outside MoltenTerm's launcher", uimsg.Make("keepawake.session.nolauncher")
	}
	if report.HasCoffeeApproval() {
		if agent == molten.AgentIdCodex && !hookRan {
			return false, ReasonCodexHookUntrusted, uimsg.Make("keepawake.session.codexuntrusted")
		}
		return true, "", nil
	}
	if skipped := report.CoffeeApprovalSkipped(); skipped != "" {
		return false, skipped, report.CoffeeApprovalSkippedText()
	}
	return false, "it was started before coffee approvals existed: restart it from MoltenTerm", uimsg.Make("keepawake.session.tooold")
}

// hookRuns remembers the agents whose PermissionRequest hook reached wavesrv: for Codex, the sign it is trusted.
type hookRuns struct {
	lock   sync.Mutex
	agents map[string]bool
}

func (h *hookRuns) mark(agent string) {
	if agent == "" {
		return
	}
	h.lock.Lock()
	defer h.lock.Unlock()
	if h.agents == nil {
		h.agents = map[string]bool{}
	}
	h.agents[agent] = true
}

func (h *hookRuns) ran(agent string) bool {
	h.lock.Lock()
	defer h.lock.Unlock()
	return h.agents[agent]
}

func sortSessions(sessions []AutoApproveSession) {
	sort.Slice(sessions, func(i, j int) bool {
		a, b := sessions[i], sessions[j]
		if a.WorkspaceId != b.WorkspaceId {
			return a.WorkspaceId < b.WorkspaceId
		}
		if a.TabName != b.TabName {
			return a.TabName < b.TabName
		}
		return a.BlockId < b.BlockId
	})
}

// approvalDetail is what the log shows of a request: the command, the path, or the input itself.
func approvalDetail(req PermissionRequest) string {
	detail := ""
	for _, key := range []string{"command", "file_path", "path", "notebook_path", "url", "pattern"} {
		if s, ok := req.ToolInput[key].(string); ok && s != "" {
			detail = s
			break
		}
	}
	if detail == "" && len(req.ToolInput) > 0 {
		if data, err := json.Marshal(req.ToolInput); err == nil {
			detail = string(data)
		}
	}
	if len(detail) > maxApprovalDetail {
		detail = detail[:maxApprovalDetail] + "…"
	}
	return detail
}

// DecidePermission is the coffee approvals' rule: no answer outside a coffee; the deny list and the questions stay
// with the person; everything else is approved. logged is false when nothing is to be recorded (no coffee).
func DecidePermission(hasCoffee bool, check PermissionCheck) (answer PermissionAnswer, outcome string, logged bool) {
	if !hasCoffee {
		return PermissionAnswer{}, "", false
	}
	if reason := DenyReason(check); reason != "" {
		return PermissionAnswer{Reason: reason}, ApprovalAsked, true
	}
	return PermissionAnswer{Decision: PermissionAllow}, ApprovalApproved, true
}
