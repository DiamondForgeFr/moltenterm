// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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

// permission answers a terminal's PermissionRequest hook. The answer goes out at once; naming the tab and writing
// the log follow off that path.
func (s *service) permission(ctx context.Context, req PermissionRequest) PermissionAnswer {
	if req.BlockId == "" || req.ToolName == "" {
		return PermissionAnswer{}
	}
	info, found := s.locateBlock(ctx, req.BlockId)
	// A review session reads untrusted PR content: its requests always go to the developer (#505 R1), even when a
	// hook of the developer's own settings asks.
	if !found || info.Remote || info.Review {
		return PermissionAnswer{}
	}
	// The hook ran, so the agent runs it: Codex only does once the developer trusted it.
	s.hooks.mark(req.Agent)
	home, _ := os.UserHomeDir()
	check := PermissionCheck{
		Tool: req.ToolName, Input: req.ToolInput, Cwd: req.Cwd, Home: home, TempDirs: tempDirs(), Branch: gitBranch,
	}
	answer, outcome, logged := DecidePermission(s.keeper.HasCoffee(info.WorkspaceId), check)
	if !logged {
		return answer
	}
	approval := Approval{
		At: time.Now().UnixMilli(), WorkspaceId: info.WorkspaceId, BlockId: req.BlockId, Agent: req.Agent,
		SessionId: req.SessionId, Tool: req.ToolName, Detail: approvalDetail(req), Outcome: outcome, Reason: answer.Reason,
	}
	goSafe("molten:keepawake:approval", func() {
		ctx, cancel := context.WithTimeout(context.Background(), storeTimeout)
		defer cancel()
		_, approval.WorkspaceName, approval.TabName = s.locateNames(ctx, req.BlockId)
		s.keeper.RecordApproval(approval)
	})
	return answer
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
		approved, reason := SessionApproval(run.Agent, info.Remote, report, hasReport, s.hooks.ran(run.Agent))
		if info.Review {
			approved, reason = false, ReasonReviewSession
		}
		rtn = append(rtn, AutoApproveSession{
			WorkspaceId: info.WorkspaceId, BlockId: run.BlockId, TabName: s.tabName(ctx, run.BlockId), Agent: run.Agent,
			AgentName: molten.AgentLabel(run.FirstName, run.Agent), Approved: approved, Reason: reason,
		})
	}
	sortSessions(rtn)
	return rtn
}
