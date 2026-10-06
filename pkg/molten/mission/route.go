// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The panels reach the collector through a leaf of wavesrv's router answering plain command names, so Mission Control
// declares nothing in pkg/wshrpc, the package upstream changes most (the molten command does the same towards tabs).

const routeQueueSize = 64

type routeLink struct {
	collector *Collector
	runs      *Runs
	ci        *Ci
	panes     *Panes
	worktrees *Worktrees
	output    chan []byte
}

type ciLogRequest struct {
	Dir   string `json:"dir"`
	RunId string `json:"runid"`
	Job   string `json:"job"`
	From  int64  `json:"from,omitempty"`
}

type ciStatusRequest struct {
	Dir string `json:"dir"`
	Rev string `json:"rev,omitempty"`
}

func (l *routeLink) handleCi(command string, data any) (any, error) {
	switch command {
	case CiStateCommand:
		var req GetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.ci.State(req.Dir)
	case CiRunCommand:
		var req CiRunRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.ci.Start(req)
	case CiLogCommand:
		var req ciLogRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		return l.ci.ReadLog(req.Dir, req.RunId, req.Job, req.From)
	case CiCancelCommand:
		var req runIdRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		return nil, l.ci.Cancel(req.Dir, req.RunId)
	case CiStatusCommand:
		var req ciStatusRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.ci.Status(req.Dir, req.Rev)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func (l *routeLink) GetPeerInfo() string {
	return RouteId
}

func (l *routeLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *routeLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:mission:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Source, req.Data)
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}

type runIdRequest struct {
	Dir   string `json:"dir"`
	RunId string `json:"runid"`
	From  int64  `json:"from,omitempty"`
}

type trustRequest struct {
	Dir  string `json:"dir"`
	Hash string `json:"hash"`
}

// isWindowSource tells a request from a MoltenTerm window apart from one sent by a terminal: the router stamps the
// source of every link that has a route of its own (wsh in a shell), so a terminal cannot pass for a tab.
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func (l *routeLink) handleRun(command string, source string, data any) (any, error) {
	switch command {
	case RunCommand:
		var req RunRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.Start(req)
	case BuildsCommand:
		var req struct {
			Dir   string `json:"dir"`
			Fresh bool   `json:"fresh,omitempty"`
		}
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.BuildsFacts(req.Dir, req.Fresh)
	case ReleaseCommand, ReleaseEndCommand:
		var req ReleaseNotesRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if command == ReleaseEndCommand {
			return nil, l.runs.StopFollowing(req.Dir, req.Tag)
		}
		return l.runs.ReleaseSessionOf(req.Dir)
	case ReleaseFactsCommand:
		var req GetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.ReleaseFactsOf(req.Dir)
	case ReleaseStepCommand:
		var req ReleaseStepRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.RunReleaseStep(req)
	case ReleaseRerunCommand, ReleaseNotesCommand, ReleaseSaveCommand:
		var req ReleaseNotesRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		switch command {
		case ReleaseRerunCommand:
			return nil, l.runs.RerunFailedJobs(req.Dir, req.Tag)
		case ReleaseNotesCommand:
			return l.runs.ReadReleaseNotes(req.Dir, req.Tag)
		}
		return nil, l.runs.SaveReleaseNotes(req.Dir, req.Tag, req.Text)
	case WorkCommand:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return WithWorkspaces(RunningWork(l.runs, l.ci), func(dir string) string {
			return attention.ProjectWorkspace(ctx, dir)
		}), nil
	case BranchesPlanCommand:
		var req GetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.PlanBranches(req.Dir)
	case BranchesCleanCommand:
		if !isWindowSource(source) {
			return nil, fmt.Errorf("branches can only be deleted from a MoltenTerm window")
		}
		var req BranchesCleanRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.CleanBranches(req)
	case ReleaseStartCommand:
		var req ReleaseStartRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.StartRelease(req)
	case RunsCommand:
		var req GetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		return l.runs.List(req.Dir), nil
	case LogCommand, CancelCommand, CloseCommand:
		var req runIdRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		if command == CancelCommand {
			return nil, l.runs.Cancel(req.Dir, req.RunId)
		}
		if command == CloseCommand {
			return nil, l.runs.Close(req.Dir, req.RunId)
		}
		return l.runs.ReadLog(req.Dir, req.RunId, req.From)
	case TrustCommand:
		if !isWindowSource(source) {
			return nil, fmt.Errorf("a project's commands can only be trusted from a MoltenTerm window")
		}
		var req trustRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.runs.GrantTrust(req.Dir, req.Hash)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if command == PaneCommand {
		var req PaneRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.panes.Get(req)
	}
	if command == ProjectTabCommand {
		// Tabs are the windows' business: a terminal does not add one to a workspace.
		if !isWindowSource(source) {
			return nil, fmt.Errorf("the Project tab can only be opened from a MoltenTerm window")
		}
		var req ProjectTabRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return ensureProjectTab(req)
	}
	if command == WorktreePlanCommand || command == WorktreeRemoveCommand {
		return l.handleWorktree(command, source, data)
	}
	if strings.HasPrefix(command, "moltenmissionci") {
		return l.handleCi(command, data)
	}
	if command != GetCommand && command != RefreshCommand {
		return l.handleRun(command, source, data)
	}
	var req GetRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, fmt.Errorf("reading the request: %w", err)
	}
	maxAge := time.Duration(req.MaxAgeSec) * time.Second
	if req.MaxAgeSec <= 0 {
		maxAge = DefaultMaxAgeSec * time.Second
	}
	switch command {
	case GetCommand:
		return l.collector.Get(req.Dir, maxAge, false)
	case RefreshCommand:
		return l.collector.Get(req.Dir, 0, true)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func (l *routeLink) handleWorktree(command string, source string, data any) (any, error) {
	if command == WorktreePlanCommand {
		var req WorktreeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.worktrees.Plan(req)
	}
	// An agent in a terminal links a worktree on its own, but only the user, from a window, removes one.
	if !isWindowSource(source) {
		return nil, fmt.Errorf("a worktree can only be removed from a MoltenTerm window")
	}
	var req WorktreeRemoveRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	return l.worktrees.Remove(req)
}

func registerRoute(collector *Collector, runs *Runs, ci *Ci, panes *Panes, worktrees *Worktrees) error {
	link := &routeLink{collector: collector, runs: runs, ci: ci, panes: panes, worktrees: worktrees, output: make(chan []byte, routeQueueSize)}
	_, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId)
	return err
}
