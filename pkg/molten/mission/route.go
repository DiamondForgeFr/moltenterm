// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The panels reach the collector through a leaf of wavesrv's router answering plain command names, so Mission Control
// declares nothing in pkg/wshrpc, the package upstream changes most (the molten command does the same towards tabs).

type routeLink struct {
	collector *Collector
	runs      *Runs
	ci        *Ci
	panes     *Panes
	worktrees *Worktrees
	groups    *Groups
	reviews   *Reviews
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

type runIdRequest struct {
	Dir   string `json:"dir"`
	RunId string `json:"runid"`
	From  int64  `json:"from,omitempty"`
}

type trustRequest struct {
	Dir  string `json:"dir"`
	Hash string `json:"hash"`
}

func (l *routeLink) handleRun(command string, data any) (any, error) {
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
	case ReleaseMilestoneCommand:
		var req ReleaseMilestoneRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return ReleaseMilestoneOf(ExecRunner, req)
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
		var req BranchesCleanRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.CleanBranches(req)
	case BranchesAutoDeleteCmd:
		var req BranchesAutoDeleteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.runs.AnswerAutoDelete(req)
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
		var req trustRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.runs.GrantTrust(req.Dir, req.Hash)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func (l *routeLink) handleGithubRun(command string, data any) (any, error) {
	var req GithubRunRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	if command == GithubRunLogCommand {
		return l.collector.ReadGithubRunLog(req)
	}
	return nil, l.collector.RerunGithubRun(req)
}

func handleJobs(command string, data any) (any, error) {
	if command == JobsCommand {
		var req JobsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return ReadCiCatalogue(req.Dir)
	}
	var req JobDescribeRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return DescribeJob(ctx, req)
}

func (l *routeLink) handle(command string, data any) (any, error) {
	if command == SpawnsCommand {
		return spawns.Snapshot(), nil
	}
	if command == PaneCommand {
		var req PaneRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.panes.Get(req)
	}
	if command == ProjectTabCommand {
		var req ProjectTabRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return ensureProjectTab(req)
	}
	if command == ReviewsCommand {
		var req ReviewsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.reviews.Get(req)
	}
	if command == GroupsCommand {
		var req GroupsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.groups.Get(req)
	}
	if command == DepsCommand {
		var req GroupsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.groups.Deps(req)
	}
	if command == DepSyncCommand {
		var req DepSyncRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.groups.Sync(req)
	}
	if command == WorktreePlanCommand || command == WorktreeRemoveCommand {
		return l.handleWorktree(command, data)
	}
	if command == GitInitCommand {
		var req GitInitRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.collector.InitGit(req)
	}
	if command == GithubRunLogCommand || command == GithubRunRerunCommand {
		return l.handleGithubRun(command, data)
	}
	if command == JobsCommand || command == JobDescribeCommand {
		return handleJobs(command, data)
	}
	if strings.HasPrefix(command, "moltenmissionci") {
		return l.handleCi(command, data)
	}
	if command != GetCommand && command != RefreshCommand {
		return l.handleRun(command, data)
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
		if req.Passive {
			return l.collector.Warm(req.Dir)
		}
		return l.collector.Get(req.Dir, maxAge, false)
	case RefreshCommand:
		return l.collector.Get(req.Dir, 0, true)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func (l *routeLink) handleWorktree(command string, data any) (any, error) {
	if command == WorktreePlanCommand {
		var req WorktreeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.worktrees.Plan(req)
	}
	var req WorktreeRemoveRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	return l.worktrees.Remove(req)
}

// windowCommands are the user's decisions, confirmed in a window: an agent in a terminal runs gh, git or a worktree
// removal itself, and never trusts a project's commands, publishes a release or types into another agent's prompt
// through MoltenTerm.
var windowCommands = map[string]string{
	TrustCommand:          "a project's commands can only be trusted from a MoltenTerm window",
	BranchesCleanCommand:  "branches can only be deleted from a MoltenTerm window",
	BranchesAutoDeleteCmd: "the repository setting can only be changed from a MoltenTerm window",
	GitInitCommand:        "a repository can only be initialized here from a MoltenTerm window",
	GithubRunRerunCommand: "a GitHub run can only be started again from a MoltenTerm window",
	JobDescribeCommand:    "an agent can only be asked to describe a job from a MoltenTerm window",
	WorktreeRemoveCommand: "a worktree can only be removed from a MoltenTerm window",
	ProjectTabCommand:     "the Project tab can only be opened from a MoltenTerm window",
	ReleaseStartCommand:   "a release is started from a MoltenTerm window",
	ReleaseStepCommand:    "a release step is run from a MoltenTerm window",
	ReleaseRerunCommand:   "a release's jobs are run again from a MoltenTerm window",
	ReleaseSaveCommand:    "release notes are saved from a MoltenTerm window",
}

// route: everything else answers the windows and local terminals (`molten ci`, `molten project`, `molten review`),
// never a remote host: running a project's commands, its CI or a release step on this computer is not a remote host's
// call, nor is reading the reviews (FR-REV-014 AC4) (#662).
func (l *routeLink) route() localroute.Route {
	policy := localroute.Policy{Default: localroute.AllowLocal, Commands: map[string]string{}, Refusals: map[string]string{}}
	for command, refusal := range windowCommands {
		policy.Commands[command] = localroute.AllowWindow
		policy.Refusals[command] = refusal
	}
	return localroute.Route{
		Id:     RouteId,
		Policy: policy,
		Handler: func(_ context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return l.handle(command, data)
		},
	}
}

func registerRoute(collector *Collector, runs *Runs, ci *Ci, panes *Panes, worktrees *Worktrees, groups *Groups, reviews *Reviews) error {
	link := &routeLink{collector: collector, runs: runs, ci: ci, panes: panes, worktrees: worktrees, groups: groups, reviews: reviews}
	_, err := localroute.Register(wshutil.DefaultRouter, link.route())
	return err
}
