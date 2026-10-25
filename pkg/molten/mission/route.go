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
	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
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
	branchCi  *BranchCi
	treePrs   *TreePrs
	testCtx   *TestContexts
	launches  *Launches
	asks      *TrustAsks
	setup     *pipelinesetup.Setup
}

type ciLogRequest struct {
	Dir   string `json:"dir"`
	RunId string `json:"runid"`
	Job   string `json:"job"`
	From  int64  `json:"from,omitempty"`
}

type ciStatusRequest struct {
	Dir  string `json:"dir"`
	Rev  string `json:"rev,omitempty"`
	From string `json:"from,omitempty"`
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
		return l.ci.StatusFrom(req.Dir, req.Rev, req.From)
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
	case ReleaseDispatchCommand:
		var req ReleaseDispatchRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		return nil, l.runs.DispatchTagWorkflow(req)
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
	case BranchesCloseCommand:
		var req BranchesCloseRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.CloseAndCleanBranch(req, registeredTerminalCloser())
	case TreePrsCommand:
		var req TreePrsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.treePrs.Read(req)
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
	case UntrustedCommand:
		var req GetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.Untrusted(req.Dir)
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
	if command == TestContextCommand {
		var req TestContextRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.testCtx.Get(req)
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
	if command == BranchCiCommand {
		var req BranchCiRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.branchCi.Get(req)
	}
	if command == ReviewsRerunCommand {
		var req ReviewsRerunRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.reviews.RerunFailed(req)
	}
	if command == MergedHistoryCommand {
		var req MergedHistoryRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.reviews.MergedHistory(req)
	}
	if command == UpcomingCommand {
		var req UpcomingRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.reviews.Upcoming(req)
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
	if strings.HasPrefix(command, "moltenmissionsetup") {
		return l.handleSetup(command, data)
	}
	if strings.HasPrefix(command, "moltenmissionlaunch") {
		if l.launches == nil {
			return nil, fmt.Errorf("launching versions is not available")
		}
		return l.handleLaunch(command, data)
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
	TrustCommand:           "a project's commands can only be trusted from a MoltenTerm window",
	BranchesCleanCommand:   "branches can only be deleted from a MoltenTerm window",
	BranchesAutoDeleteCmd:  "the repository setting can only be changed from a MoltenTerm window",
	BranchesCloseCommand:   "sessions can only be closed for a branch cleanup from a MoltenTerm window",
	GitInitCommand:         "a repository can only be initialized here from a MoltenTerm window",
	GithubRunRerunCommand:  "a GitHub run can only be started again from a MoltenTerm window",
	ReviewsRerunCommand:    "a pull request's failed jobs can only be rerun from a MoltenTerm window",
	JobDescribeCommand:     "an agent can only be asked to describe a job from a MoltenTerm window",
	WorktreeRemoveCommand:  "a worktree can only be removed from a MoltenTerm window",
	ProjectTabCommand:      "the Project tab can only be opened from a MoltenTerm window",
	ReleaseStartCommand:    "a release is started from a MoltenTerm window",
	ReleaseStepCommand:     "a release step is run from a MoltenTerm window",
	ReleaseRerunCommand:    "a release's jobs are run again from a MoltenTerm window",
	ReleaseDispatchCommand: "a release's workflow is started by hand from a MoltenTerm window",
	ReleaseSaveCommand:     "release notes are saved from a MoltenTerm window",
	// The release setup writes in the project and starts a coding agent (FR-MC-036): the developer's click only.
	SetupRefineCommand: "a release setup is refined from a MoltenTerm window",
	SetupWriteCommand:  "a release setup is written from a MoltenTerm window",
	SetupUpdateCommand: "a release setup is updated from a MoltenTerm window",
	// The pull request the setup opens (#1098) is followed from the window that opened it.
	SetupPrStateCommand: "a release setup's pull request is followed from a MoltenTerm window",
	SetupTicketsCommand: "a release setup's ticket is picked from a MoltenTerm window",
	// Launch (FR-REV-031) switches the checkout and runs the project's servers: the developer's click only.
	LaunchSaveRecipeCommand: "a launch recipe is confirmed from a MoltenTerm window",
	LaunchStartCommand:      "a version is launched from a MoltenTerm window",
	LaunchStopCommand:       "a launched version is stopped from a MoltenTerm window",
	LaunchRetryCommand:      "a launch is retried from a MoltenTerm window",
}

func (l *routeLink) handleLaunch(command string, data any) (any, error) {
	switch command {
	case LaunchRecipeCommand:
		var req LaunchRecipeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.launches.RecipeOf(req)
	case LaunchSaveRecipeCommand:
		var req LaunchSaveRecipeRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.launches.SaveRecipe(req)
	case LaunchPlanCommand:
		var req LaunchPlanRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.launches.Plan(req)
	case LaunchStartCommand:
		var req LaunchStartRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.launches.Start(req)
	case LaunchLogCommand:
		var req LaunchLogRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.launches.ReadLog(req)
	}
	var req LaunchDirRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	switch command {
	case LaunchStopCommand:
		return l.launches.Stop(req)
	case LaunchRetryCommand:
		return l.launches.Retry(req)
	}
	return l.launches.State(req)
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
		Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
			answer, err := l.handle(command, data)
			if err != nil {
				return answer, err
			}
			if command == TrustCommand {
				l.asks.Granted(requestDir(data))
				return answer, nil
			}
			// A window shows its own trust sheet; a terminal (an agent, a script) can only be answered by a notification.
			if !caller.IsUi() {
				if dir := refusedDir(command, data, answer); dir != "" {
					l.asks.Refused(dir, caller.BlockId, command)
				}
			}
			return answer, nil
		},
	}
}

func registerRoute(collector *Collector, runs *Runs, ci *Ci, panes *Panes, worktrees *Worktrees, groups *Groups, reviews *Reviews, launches *Launches, asks *TrustAsks, setupTrees string, setupAnswers string) error {
	setup := pipelinesetup.MakeSetup(pipelinesetup.Runner(ExecRunner), refineAgent)
	setup.TreesDir = setupTrees
	setup.AnswersDir = setupAnswers
	link := &routeLink{collector: collector, runs: runs, ci: ci, panes: panes, worktrees: worktrees, groups: groups, reviews: reviews,
		branchCi: MakeBranchCi(collector, runs, ExecRunner), treePrs: MakeTreePrs(ExecRunner),
		testCtx: MakeTestContexts(panes, collector), launches: launches, asks: asks, setup: setup}
	_, err := localroute.Register(wshutil.DefaultRouter, link.route())
	return err
}

// The release setup's calls (FR-MC-036): the draft and the agent's proposal write nothing; the write is the
// developer's click on the reviewed diff.
func (l *routeLink) handleSetup(command string, data any) (any, error) {
	if l.setup == nil {
		return nil, fmt.Errorf("the release setup is not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	switch command {
	case SetupDraftCommand:
		var req pipelinesetup.DraftRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Draft(ctx, req)
	case SetupRefineCommand:
		var req pipelinesetup.RefineRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Refine(ctx, req)
	case SetupApplyCommand:
		var req pipelinesetup.ApplyRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Apply(req)
	case SetupPromptCommand:
		var req pipelinesetup.PromptRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Prompt(req)
	case SetupWriteCommand:
		var req pipelinesetup.WriteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Write(req)
	case SetupCheckCommand:
		var req pipelinesetup.CheckRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Check(ctx, req)
	case SetupUpdateCommand:
		var req pipelinesetup.UpdateRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Update(ctx, req)
	case SetupPrStateCommand:
		var req pipelinesetup.PrStateRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.PrState(req)
	case SetupTicketsCommand:
		var req pipelinesetup.TicketsRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Tickets(ctx, req)
	case SetupSurveyCommand:
		var req pipelinesetup.SurveyRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.Survey(ctx, req)
	case SetupAnswersCommand:
		var req pipelinesetup.AnswersRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.setup.SaveAnswers(req)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

const refineAgentTimeout = 10 * time.Minute

// refineAgent runs the coding agent the way the agent choice finds it: through the login shell's PATH, so the agent
// that runs is the one the choice said was installed, with the prompt on its standard input.
func refineAgent(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, refineAgentTimeout)
	defer cancel()
	return ExecRunnerInput(ctx, dir, []byte(prompt), argv[0], argv[1:]...)
}
