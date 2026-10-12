// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
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
}

// PermissionAnswer: Decision is PermissionAllow, or empty to leave the request to the agent's prompt.
type PermissionAnswer struct {
	Decision string `json:"decision,omitempty"`
	Reason   string `json:"reason,omitempty"`
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
}

// HasCoffee tells whether a workspace's coffee holds now: on, in its grace, or kept on by work.
func (k *Keeper) HasCoffee(wsId string) bool {
	k.lock.Lock()
	defer k.lock.Unlock()
	return wsId != "" && k.coffees[wsId] != nil
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

// SessionApproval says whether a terminal's agent gets its prompts answered while a coffee holds, and why not.
// hookRan: the agent's hook reached wavesrv since it started, so the agent runs it (Codex runs it only once trusted).
func SessionApproval(agent string, remote bool, report molten.AgentIntegrationReport, hasReport bool, hookRan bool) (bool, string) {
	name := molten.AgentDisplayName(agent)
	if remote {
		return false, "it runs on a remote host"
	}
	switch agent {
	case molten.AgentIdClaude, molten.AgentIdCodex:
	default:
		return false, "MoltenTerm cannot answer " + name + "'s prompts"
	}
	if !hasReport {
		return false, "it was started outside MoltenTerm's launcher"
	}
	if report.HasCoffeeApproval() {
		if agent == molten.AgentIdCodex && !hookRan {
			return false, ReasonCodexHookUntrusted
		}
		return true, ""
	}
	if skipped := report.CoffeeApprovalSkipped(); skipped != "" {
		return false, skipped
	}
	return false, "it was started before coffee approvals existed: restart it from MoltenTerm"
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
