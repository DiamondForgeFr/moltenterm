// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/molten/sfticket"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The fix of a shared security block (FR-REV-036 AC9 to AC13, #2589). When a project's dependency scan fails on advisories
// that no pull request caused (pkg/molten/secfix reads them), one ticket and one coding agent fix the set, whichever
// pull requests it blocks. The developer's click starts it ("Launch the fix"), and the developer's consent, asked once,
// lets MoltenTerm start it without a click: it is the first agent MoltenTerm starts on its own, so everything here is
// narrow. At most one fix is in flight per project; the set of advisories, not the pull request, is its unit; a fix the
// developer stopped, or that failed, is never started again on its own; MoltenTerm marks the fix's pull request ready
// when its checks are green and never merges it.
//
// The agent is the developer's usual one (the run's pick, the project's, the global, the first installed: agentchoice),
// started the way every other flow starts it: the same brief and the same command path serve Claude Code, Codex and Kimi
// Code. It works in the background, in a new worktree cut from origin/<trunk>, never in the project's checkout.

const (
	SecurityFixCommand     = "moltenreviewsecurityfix"
	SecurityFixStopCommand = "moltenreviewsecurityfixstop"

	// AgentOriginSecurity: the agent works on the fix of a shared security block (#2589).
	AgentOriginSecurity = "security"

	// SecurityFixStopGesture is the notification's Stop; must match frontend/moltenterm-shell/reviews/security-fix-model.ts.
	SecurityFixStopGesture = "review:securityfix:stop"

	securityFixDirName = "securityfix"
	securityFixTreePre = "secfix-"
	// securityNoticePrefix keys the fix's notifications apart from the stale dependencies' (molten:deps:, which their
	// publisher resolves whenever it runs), under the same source and so the same subject, "dependencies".
	securityNoticePrefix = "molten:secfix:"
	securityNoticeSource = "deps"

	// No fix starts while this many agents work: the launch waits for a place and never makes another one leave.
	securityAgentCap = 6
	// A launch that failed or waits is tried again on its own after this, at most securityMaxTries times.
	securityRetryAfter = 2 * time.Minute
	securityMaxTries   = 3
	// An open ticket or pull request citing an advisory is searched for the first few advisories of the set.
	securitySearchIds   = 4
	securitySearchLimit = 5
	securityTabPrefix   = "secfix:"
)

// What an ask for the fix answers, besides RestartStarted, RestartNoAgent, RestartFailed and RestartBusy.
const (
	// SecurityFixCovered: a fix already stands for these advisories.
	SecurityFixCovered = "covered"
	// SecurityFixAddendum: a fix is in flight for other advisories, and these join it.
	SecurityFixAddendum = "addendum"
	// SecurityFixHeld: the developer stopped the fix of this set, or it failed: it starts only on the developer's click.
	SecurityFixHeld = "held"
	// SecurityFixWaiting: the fix waits for a place or for something to be there; Fix.Reason says what.
	SecurityFixWaiting = "waiting"
	// SecurityFixExternal: someone else's pull request or agent was there first; MoltenTerm only follows it.
	SecurityFixExternal = "external"
	// SecurityFixStoppedStatus is what a Stop answers.
	SecurityFixStoppedStatus = "stopped"
)

// Why a request was refused, for the window to word.
const (
	SecurityReasonBlockGone = "blockgone"
	SecurityReasonNotShared = "notshared"
)

var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

// SecurityFixRequest is the developer's click on "Launch the fix" of a shared block (a window's only). The advisories
// are never taken from it: wavesrv reads the block it names from its own last assessment.
type SecurityFixRequest struct {
	Dir         string `json:"dir"`
	Repo        string `json:"repo"`
	Trunk       string `json:"trunk"`
	Fingerprint string `json:"fingerprint"`
	// WorkspaceId: the workspace the agent's tab goes in, named TabName (the window's words).
	WorkspaceId string `json:"workspaceid"`
	TabName     string `json:"tabname,omitempty"`
	// Agent: the coding agent picked for this run (agentchoice), "" for the project's choice.
	Agent string `json:"agent,omitempty"`
}

func (req SecurityFixRequest) check() error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if err := checkSecurityRepo(req.Repo, req.Trunk); err != nil {
		return err
	}
	if !fingerprintPattern.MatchString(req.Fingerprint) {
		return fmt.Errorf("fingerprint must be the one of the block's advisories")
	}
	if req.WorkspaceId == "" {
		return fmt.Errorf("workspaceid is required to start an agent")
	}
	if req.Agent != "" && !agentchoice.IsSupported(req.Agent) {
		return fmt.Errorf("agent must be one of %s", strings.Join(agentchoice.Supported, ", "))
	}
	return nil
}

func checkSecurityRepo(repo string, trunk string) error {
	if !repoPattern.MatchString(repo) || strings.HasPrefix(repo, ".") || strings.Contains(repo, "/.") {
		return fmt.Errorf("repo must be owner/name")
	}
	if !reviewsession.ValidRef(trunk) {
		return fmt.Errorf("trunk must be the branch the pull requests target")
	}
	return nil
}

// SecurityFixResult is a RestartResult (the agent that started, its tab, the choice the window may offer to switch) and
// what the fix stands at.
type SecurityFixResult struct {
	RestartResult
	Fix *secfix.Fix `json:"fix,omitempty"`
}

// SecurityFixStopRequest is the developer's Stop, from the block, the notification or the card (a window's only).
type SecurityFixStopRequest struct {
	Dir         string `json:"dir"`
	Fingerprint string `json:"fingerprint"`
}

// SecurityFixEnv is what the fix reaches outside git and gh; the tests give fakes. A field left nil does nothing.
type SecurityFixEnv struct {
	// Store keeps the fixes (mission's, shared with the Integration list's answer).
	Store func() *secfix.FixStore
	// Result is the project's last assessment of its failed scans (mission.LiveSecurityResult).
	Result func(dir string) (secfix.Result, bool)
	// Consent says what the developer answered about starting the fix on its own (secfix.ConsentOn, Off, Unasked).
	Consent func() string
	// Run runs a program in a folder (the project's ticket CLI).
	Run sfticket.Runner
	// ProjectWorkspace is the workspace linked to the project, "" for none (attention.ProjectWorkspace).
	ProjectWorkspace func(ctx context.Context, dir string) string
	// AgentsWorking counts the agents at work now; MachineLoaded says the computer is loaded.
	AgentsWorking func() int
	MachineLoaded func() bool
	// StopAgent ends the session of a terminal's agent; false when none ran there.
	StopAgent func(ctx context.Context, blockId string) (bool, error)
	// Declaration is the project's `ci.security` (the files of its dependency policy go in the brief).
	Declaration func(dir string) *secfix.Declaration
}

func (r *Restarter) fixStore() *secfix.FixStore {
	if r.env.SecurityFix.Store == nil {
		return nil
	}
	return r.env.SecurityFix.Store()
}

// securityLaunch is one launch: where, for which block, and who asked.
type securityLaunch struct {
	dir         string
	repo        string
	trunk       string
	workspaceId string
	tabName     string
	agent       string
	block       secfix.Block
	// auto: started without a click, under the developer's consent. force: the developer asked by hand, so a set that was
	// stopped or failed starts again.
	auto  bool
	force bool
}

func findBlock(result secfix.Result, fingerprint string) (secfix.Block, bool) {
	for _, block := range result.Blocks {
		if block.Fingerprint == fingerprint {
			return block, true
		}
	}
	return secfix.Block{}, false
}

// AskSecurityFix is the developer's click on "Launch the fix": the same launch the consent starts without one.
func (r *Restarter) AskSecurityFix(ctx context.Context, req SecurityFixRequest) (SecurityFixResult, error) {
	if err := req.check(); err != nil {
		return SecurityFixResult{}, err
	}
	req.Dir = filepath.Clean(req.Dir)
	if r.env.SecurityFix.Result == nil {
		return SecurityFixResult{}, fmt.Errorf("the security fix is not available")
	}
	result, _ := r.env.SecurityFix.Result(req.Dir)
	block, ok := findBlock(result, req.Fingerprint)
	if !ok {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Reason: SecurityReasonBlockGone,
			Message: "The scan no longer fails on these advisories: there is nothing to fix."}}, nil
	}
	if !block.Shared {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Reason: SecurityReasonNotShared,
			Message: "These advisories come from the pull request itself: fix them in it (Analyze and resolve)."}}, nil
	}
	return r.launchSecurityFix(ctx, securityLaunch{dir: req.Dir, repo: req.Repo, trunk: req.Trunk, workspaceId: req.WorkspaceId,
		tabName: req.TabName, agent: req.Agent, block: block, force: true}), nil
}

// securityAssessed is told of each assessment of a project's failed scans. With the developer's consent, each shared block
// gets its fix, one after the other and in the background; without it nothing happens here, the block only offers.
func (r *Restarter) securityAssessed(assessed mission.SecurityAssessed) {
	if r.env.SecurityFix.Consent == nil || r.env.SecurityFix.Consent() != secfix.ConsentOn {
		return
	}
	if len(assessed.Result.Blocks) == 0 || checkSecurityRepo(assessed.Repo, assessed.Trunk) != nil {
		return
	}
	go func() {
		defer func() { panichandler.PanicHandler("molten:review:securityfix:assessed", recover()) }()
		r.launchAssessed(assessed)
	}()
}

// launchAssessed gives each shared block of an assessment its fix, one after the other.
func (r *Restarter) launchAssessed(assessed mission.SecurityAssessed) {
	for _, block := range assessed.Result.Blocks {
		if !block.Shared || len(block.Advisories) == 0 || !securityBlockLaunchable(block) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
		r.launchSecurityFix(ctx, securityLaunch{dir: filepath.Clean(assessed.Dir), repo: assessed.Repo, trunk: assessed.Trunk,
			block: block, auto: true})
		cancel()
	}
}

// securityBlockLaunchable: only a scan the project declared or the developer confirmed starts anything (AC10).
func securityBlockLaunchable(block secfix.Block) bool {
	return block.Origin == secfix.OriginDeclared || block.Origin == secfix.OriginConfirmed
}

func securityKey(dir string) PrKey {
	return PrKey{Repo: "secfix:" + filepath.Clean(dir)}
}

// launchSecurityFix decides what the block's advisories call for and, when a fix is to start, starts it.
func (r *Restarter) launchSecurityFix(ctx context.Context, in securityLaunch) SecurityFixResult {
	ids := secfix.Ids(in.block.Advisories)
	store := r.fixStore()
	if store == nil || len(ids) == 0 {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Message: "the security fix is not available"}}
	}
	key := securityKey(in.dir)
	if !r.claim(key) {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartBusy, Reason: RestartReasonInFlight,
			Message: "A security fix is already being started for this project."}}
	}
	defer r.release(key)
	plan, decided, err := store.Begin(in.dir, secfix.Fix{Fingerprint: in.block.Fingerprint, Ids: ids, Auto: in.auto, Trunk: in.trunk,
		Repo: in.repo, WorkspaceId: in.workspaceId, Agent: in.agent}, in.force)
	if err != nil {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Message: err.Error()}}
	}
	switch plan {
	case secfix.PlanCovered:
		// A claim that waits for its place is the one this launch takes up again; any other fix just stands.
		if decided.State != secfix.FixWaiting || decided.External || !r.retryDue(decided, in.force) {
			return securityAnswer(SecurityFixCovered, decided)
		}
		in.workspaceId, in.agent = firstNonEmpty(in.workspaceId, decided.WorkspaceId), firstNonEmpty(in.agent, decided.Agent)
		return r.startSecurityFix(ctx, in, decided, ids)
	case secfix.PlanAddendum:
		r.securityAddendum(ctx, in, decided, ids)
		return securityAnswer(SecurityFixAddendum, decided)
	case secfix.PlanHeld:
		return securityAnswer(SecurityFixHeld, decided)
	}
	return r.startSecurityFix(ctx, in, decided, ids)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func securityAnswer(status string, fix secfix.Fix) SecurityFixResult {
	return SecurityFixResult{RestartResult: RestartResult{Status: status}, Fix: &fix}
}

func (r *Restarter) retryDue(fix secfix.Fix, force bool) bool {
	return force || fix.RetryAt <= r.env.Now().UnixMilli()
}

// securityPlace says whether an agent may start now: not while the computer is loaded, nor while the agents at work fill
// their places. Waiting never makes another agent leave.
func (r *Restarter) securityPlace() (string, bool) {
	if load := r.env.SecurityFix.MachineLoaded; load != nil && load() {
		return secfix.ReasonMachineBusy, false
	}
	if working := r.env.SecurityFix.AgentsWorking; working != nil && working() >= securityAgentCap {
		return secfix.ReasonAgentLimit, false
	}
	return "", true
}

// securityWait keeps the fix waiting, with why, to be tried again after a while.
func (r *Restarter) securityWait(in securityLaunch, fix secfix.Fix, reason string, count bool) SecurityFixResult {
	store := r.fixStore()
	retryAt := r.env.Now().Add(securityRetryAfter).UnixMilli()
	updated, _, _ := store.Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.RetryAt = secfix.FixWaiting, reason, retryAt
		f.WorkspaceId, f.Agent = firstNonEmpty(in.workspaceId, f.WorkspaceId), firstNonEmpty(in.agent, f.Agent)
		if count {
			f.Tries++
		}
		return true
	})
	r.followSecurityFix(in.dir, fix.Fingerprint)
	return securityAnswer(SecurityFixWaiting, updated)
}

// securityGiveUp ends a fix that could not start after several tries: it is failed, so it is never started again on its
// own, and the developer is told why.
func (r *Restarter) securityGiveUp(ctx context.Context, in securityLaunch, fix secfix.Fix, reason string, detail string) SecurityFixResult {
	updated, _, _ := r.fixStore().Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.Outcome = secfix.FixFailed, reason, secfix.CleanLine(detail, outcomeMaxLength)
		return true
	})
	r.notify(ctx, securityNeedsYou(updated, detail))
	return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Message: detail}, Fix: &updated}
}

// startSecurityFix takes a claimed fix to a running agent: the place, the agent, the ticket, the worktree, the brief and
// the terminal, in that order, each undone when the next fails.
func (r *Restarter) startSecurityFix(ctx context.Context, in securityLaunch, fix secfix.Fix, ids []string) SecurityFixResult {
	if reason, ok := r.securityPlace(); !ok {
		return r.securityWait(in, fix, reason, false)
	}
	rreq := RestartRequest{PrKey: securityKey(in.dir), Dir: in.dir, HeadRef: in.trunk, BaseRef: in.trunk, Start: true, Mode: AgentModeBackground,
		WorkspaceId: in.workspaceId, TabName: in.tabName, Agent: in.agent}
	var result SecurityFixResult
	agent, choice := r.pickAgent(ctx, rreq)
	noteChoice(&result.RestartResult, choice)
	if agent == "" {
		result.Status, result.Fix = RestartNoAgent, &fix
		if choice.Missing {
			result.Reason, result.Message = RestartReasonAgentMissing, choice.MissingText()+". Nothing was started."
		} else {
			result.Message = agentchoice.NoneText() + ". Nothing was started."
		}
		// Nothing is recorded for an agent that is not installed: the next assessment, or the click, tries again.
		r.fixStore().Remove(in.dir, fix.Fingerprint)
		return result
	}
	if in.workspaceId == "" && r.env.SecurityFix.ProjectWorkspace != nil {
		in.workspaceId = r.env.SecurityFix.ProjectWorkspace(ctx, in.dir)
		rreq.WorkspaceId = in.workspaceId
	}
	if in.workspaceId == "" {
		return r.securityRetry(ctx, in, fix, secfix.ReasonNoWorkspace, "no workspace is linked to the project")
	}
	if r.env.OpenTerminal == nil || r.env.AgentTab == nil {
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, "MoltenTerm cannot open terminals yet")
	}
	ticket, err := r.securityTicket(ctx, in, &fix)
	if err != nil {
		log.Printf("%s security fix %s: no ticket: %v\n", logPrefix, fix.Fingerprint, err)
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, err.Error())
	}
	if ticket.external {
		return r.securityExternal(ctx, in, fix, ticket)
	}
	branch := r.securityBranch(ctx, in.dir, ticket.number, ids)
	tree, err := r.securityTree(ctx, in.dir, in.trunk, branch, ticket.number)
	if err != nil {
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, err.Error())
	}
	removeTree := func() { r.git(ctx, in.dir, "worktree", "remove", "--force", tree) }
	briefPath, err := r.securityBrief(in, fix, ticket.number, branch, tree)
	if err != nil {
		removeTree()
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, fmt.Sprintf("the brief could not be written: %v", err))
	}
	origin := AgentOrigin{Kind: AgentOriginSecurity, Repo: in.repo, Branch: branch, Base: in.trunk, Ticket: ticket.number,
		Advisories: secfix.CleanLine(strings.Join(shownIds(ids), ", "), 80), Auto: in.auto, Mode: AgentModeBackground, At: r.env.Now().UnixMilli()}
	name := in.tabName
	if name == "" {
		name = "Security fix #" + strconv.Itoa(ticket.number)
	}
	tabId, err := r.env.AgentTab(ctx, in.workspaceId, name, waveobj.MetaMapType{AgentTabMetaKey: securityTabPrefix + fix.Fingerprint}, true)
	if err != nil {
		removeTree()
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, fmt.Sprintf("The agent's tab could not be made: %v", err))
	}
	command := reviewsession.CommandLine(agent, []string{"--", securityPromptLine(ticket.number, ids, briefPath)})
	blockId, err := r.env.OpenTerminal(ctx, tabId, "", waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     tree,
		molten.WorktreeMetaKey:     tree,
		OriginMetaKey:              origin,
	}, command)
	if blockId == "" {
		if r.env.CloseTab != nil {
			r.env.CloseTab(ctx, tabId)
		}
		removeTree()
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, fmt.Sprintf("The agent was not started (%v).", err))
	}
	started, _, _ := r.fixStore().Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.RetryAt, f.Tries = secfix.FixWorking, "", 0, 0
		f.Ticket, f.TicketUrl, f.TicketNew = ticket.number, ticket.url, ticket.created
		f.Branch, f.Tree, f.Agent, f.AgentName = branch, tree, agent, molten.AgentDisplayName(agent)
		f.WorkspaceId, f.TabId, f.BlockId = in.workspaceId, tabId, blockId
		return true
	})
	result.Status, result.BlockId, result.Agent, result.AgentName = RestartStarted, blockId, agent, molten.AgentDisplayName(agent)
	result.TabId, result.Hidden, result.Worktree, result.WorktreeCreated, result.BriefPath = tabId, true, tree, true, briefPath
	result.Branch, result.Fix = branch, &started
	result.Message = fmt.Sprintf("%s started in %s.", result.AgentName, tree)
	r.followSecurityFix(in.dir, fix.Fingerprint)
	r.notify(ctx, securityStarted(started, in.auto))
	return result
}

func shownIds(ids []string) []string {
	if len(ids) > 3 {
		return append(append([]string{}, ids[:3]...), fmt.Sprintf("+%d", len(ids)-3))
	}
	return ids
}

// securityRetry: starting the fix failed before an agent was there. The claim stays, waiting, and is tried again after a
// while; after securityMaxTries the fix is failed and the developer told.
func (r *Restarter) securityRetry(ctx context.Context, in securityLaunch, fix secfix.Fix, reason string, detail string) SecurityFixResult {
	if fix.Tries+1 >= securityMaxTries {
		return r.securityGiveUp(ctx, in, fix, reason, detail)
	}
	result := r.securityWait(in, fix, reason, true)
	result.Message = detail
	return result
}

// securityTree makes the agent's copy: a new worktree on a new branch cut from origin/<trunk>, in MoltenTerm's data folder
// (or beside the project's other worktrees), never in the project's checkout.
func (r *Restarter) securityTree(ctx context.Context, dir string, trunk string, branch string, ticket int) (string, error) {
	r.git(ctx, dir, "worktree", "prune")
	r.git(ctx, dir, "fetch", "--quiet", "origin", "+refs/heads/"+trunk+":refs/remotes/origin/"+trunk)
	start := "origin/" + trunk
	if _, err := r.git(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/remotes/"+start); err != nil {
		return "", uimsg.Errorf(uimsg.Make("review.branchmissing", "branch", trunk), "the branch %s was found neither in the project nor on origin", trunk)
	}
	entries, err := r.worktrees(ctx, dir)
	if err != nil {
		return "", err
	}
	tree := r.newTreeDir(dir, entries, ticket, branch)
	if err := os.MkdirAll(filepath.Dir(tree), 0700); err != nil {
		return "", err
	}
	if _, err := r.git(ctx, dir, "worktree", "add", "--quiet", "--no-track", "-b", branch, tree, start); err != nil {
		return "", uimsg.Errorf(uimsg.Make("review.worktreecreate", "branch", branch, "detail", uimsg.Detail(err)),
			"a worktree on %s could not be created: %w", branch, err)
	}
	return tree, nil
}

// securityBranch is the new branch's name: the project's naming for a fix (its branchNaming, fix/{N}-{description} when it
// names none) with the ticket and the advisories, made free when an earlier try left it.
func (r *Restarter) securityBranch(ctx context.Context, dir string, ticket int, ids []string) string {
	pattern := "fix/{N}-{description}"
	if r.env.Conventions != nil {
		if conv := r.env.Conventions(dir); conv != nil && strings.TrimSpace(conv.BranchNaming["fix"]) != "" {
			pattern = strings.TrimSpace(conv.BranchNaming["fix"])
		}
	}
	name := func(suffix string) string {
		branch := strings.NewReplacer("{N}", strconv.Itoa(ticket), "{description}", secfix.Slug(ids)+suffix).Replace(pattern)
		if !reviewsession.ValidRef(branch) {
			return strings.NewReplacer("{N}", strconv.Itoa(ticket), "{description}", secfix.Slug(ids)+suffix).Replace("fix/{N}-{description}")
		}
		return branch
	}
	for i := 1; i <= 6; i++ {
		suffix := ""
		if i > 1 {
			suffix = "-" + strconv.Itoa(i)
		}
		branch := name(suffix)
		_, local := r.git(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
		_, remote := r.git(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+branch)
		if local != nil && remote != nil {
			return branch
		}
	}
	return name("-" + strconv.FormatInt(r.env.Now().Unix(), 36))
}

// securityPromptLine holds the rules that must hold even if the brief is not read; it is the same line for every agent.
func securityPromptLine(ticket int, ids []string, briefPath string) string {
	return fmt.Sprintf("MoltenTerm: security fix, ticket #%d, advisories %s. Bump each dependency to its fixed version, or record an "+
		"applicability review with evidence under the project's dependency policy; never an exception, never a bypass. Work only "+
		"in this worktree, open a draft pull request that resolves #%d, never merge. Brief: %s",
		ticket, strings.Join(shownIds(ids), ", "), ticket, briefPath)
}
