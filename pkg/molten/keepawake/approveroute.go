// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// wavesrv's side of the coffee approvals (FR-SHELL-063): the route's keepawakepermission answer, the sessions the
// coffee bud lists, and the log.

const (
	branchTimeout = time.Second
	tabCacheTtl   = 30 * time.Second
)

// The folders whose content is scratch: a recursive deletion there is approved.
func tempDirs() []string {
	dirs := []string{"/tmp", "/private/tmp", "/var/folders", "/private/var/folders"}
	if t := os.TempDir(); t != "" {
		dirs = append(dirs, t)
	}
	return dirs
}

// gitBranch is the branch checked out in dir, "" when unknown.
func gitBranch(dir string) string {
	if dir == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), branchTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "symbolic-ref", "--short", "-q", "HEAD").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// permission answers a terminal's PermissionRequest hook. The answer goes out at once, unless the companion holds the
// request for the developer (gate.go); naming the tab and writing the log follow off that path. In this order: Brokk's
// own session asks in his layer; a request the deny list keeps for the developer goes to the terminal, whatever
// approves around it, and the companion shows why; a coffee, then a session the developer set to approve its own
// requests, approve the rest; what is left is held for the companion when a window shows it (the answer then says so,
// and the hook awaits it: Gate.Open, Gate.Wait), and otherwise asked in the agent's own prompt. Everything but Brokk's
// own session's wait is done within the store's time, however long the hook may be willing to wait.
func (s *service) permission(ctx context.Context, req PermissionRequest) PermissionAnswer {
	if req.BlockId == "" || req.ToolName == "" {
		return PermissionAnswer{}
	}
	if req.Arrived.IsZero() {
		req.Arrived = s.clock()
	}
	storeCtx, cancel := context.WithTimeout(ctx, storeTimeout)
	defer cancel()
	info, found := s.locateBlock(storeCtx, req.BlockId)
	// A review session reads untrusted PR content: its requests always go to the developer (#505 R1), even when a
	// hook of the developer's own settings asks.
	if !found || info.Remote || info.Review {
		return PermissionAnswer{}
	}
	// The hook ran, so the agent runs it: Codex only does once the developer trusted it.
	s.hooks.mark(req.Agent)
	// Brokk's own session asks the developer in his layer, and is never approved by a coffee (#2257).
	if asker := getOwnSessionAsker(); asker != nil {
		ownCtx, cancelOwn := context.WithTimeout(ctx, permissionTimeout(req))
		answer, handled := asker(ownCtx, req)
		cancelOwn()
		if handled {
			return answer
		}
	}
	home, _ := os.UserHomeDir()
	check := PermissionCheck{
		Tool: req.ToolName, Input: req.ToolInput, Cwd: req.Cwd, Home: home, TempDirs: tempDirs(), Branch: gitBranch,
	}
	deny := DenyReason(check)
	if deny != "" && s.gate != nil {
		s.gate.NoteTerminalOnly(req, deny)
	}
	var answer PermissionAnswer
	if s.keeper.HasCoffee(info.WorkspaceId) {
		answer, outcome, _ := decideCovered(deny)
		s.recordApproval(info, req, answer, outcome, "")
		return answer
	}
	if s.gate == nil || deny != "" {
		return answer
	}
	if s.autonomous(req) {
		answer = PermissionAnswer{Decision: PermissionAllow}
		s.gate.NoteApproved(req.BlockId, req.SessionId)
		s.recordApproval(info, req, answer, ApprovalApproved, ApprovalSourceAutonomous)
		return answer
	}
	return s.hold(req)
}

// recordApproval logs a decision and shows it in the state, off the path of the answer.
func (s *service) recordApproval(info BlockInfo, req PermissionRequest, answer PermissionAnswer, outcome string, source string) {
	approval := Approval{
		At: time.Now().UnixMilli(), WorkspaceId: info.WorkspaceId, BlockId: req.BlockId, Agent: req.Agent,
		SessionId: req.SessionId, Tool: req.ToolName, Detail: approvalDetail(req), Outcome: outcome, Reason: answer.Reason,
		ReasonText: DenyReasonText(answer.Reason), Source: source,
	}
	run := s.runApproval
	if run == nil {
		run = func(fn func()) { goSafe("molten:keepawake:approval", fn) }
	}
	namesOf := s.namesOf
	if namesOf == nil {
		namesOf = s.locateNames
	}
	run(func() {
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		defer cancel()
		var tabName string
		_, approval.WorkspaceName, tabName = namesOf(ctx, req.BlockId)
		// The approvals log is English, read as a file; no window shows an approval's tab.
		approval.TabName = wconfig.ViewNameText(tabName)
		s.keeper.RecordApproval(approval)
	})
}

func (s *service) logApproval(a Approval) {
	if s.approvalLog == nil {
		return
	}
	if err := s.approvalLog.append(a); err != nil {
		log.Printf("molten: coffee approvals log: %v\n", err)
	}
}

func (s *service) tabName(ctx context.Context, blockId string) string {
	now := time.Now()
	if name, _, known := s.tabs.get(blockId, now); known {
		return name
	}
	_, _, name := s.locateNames(ctx, blockId)
	s.tabs.put(blockId, name, true, now.Add(tabCacheTtl))
	return name
}

// sessions lists the running agents of the coffees' workspaces, each with whether its prompts are answered.
func (s *service) sessions(ctx context.Context, wsIds []string) []AutoApproveSession {
	want := map[string]bool{}
	for _, id := range wsIds {
		want[id] = true
	}
	var rtn []AutoApproveSession
	for _, run := range attention.AgentRuns() {
		if !run.Running {
			continue
		}
		info, found := s.locateBlock(ctx, run.BlockId)
		if !found || !want[info.WorkspaceId] {
			continue
		}
		report, hasReport := attention.AgentIntegration(run.BlockId)
		approved, reason, text := SessionApprovalText(run.Agent, info.Remote, report, hasReport, s.hooks.ran(run.Agent))
		if info.Review {
			approved, reason, text = false, ReasonReviewSession, uimsg.Make("keepawake.session.review")
		}
		rtn = append(rtn, AutoApproveSession{
			WorkspaceId: info.WorkspaceId, BlockId: run.BlockId, TabName: s.tabName(ctx, run.BlockId), Agent: run.Agent,
			AgentName: molten.AgentLabel(run.FirstName, run.Agent), Approved: approved, Reason: reason, ReasonText: text,
		})
	}
	sortSessions(rtn)
	return rtn
}
