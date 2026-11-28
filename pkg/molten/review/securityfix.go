// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"errors"
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
	// SecurityReasonConsentOff: the standing consent was turned off since the fix was claimed; SecurityReasonUnverified: the
	// advisory database does not know an id the scan named.
	SecurityReasonConsentOff = "consentoff"
	SecurityReasonUnverified = "unverified"
)

var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

// SecurityFixRequest is the developer's click on "Launch the fix" of a shared block (a window's only). Neither the
// advisories nor where they live are taken from it: wavesrv reads the block it names, the repository and the trunk from its
// own last assessment (Repo and Trunk are only checked, when given, and never used).
type SecurityFixRequest struct {
	Dir         string `json:"dir"`
	Repo        string `json:"repo,omitempty"`
	Trunk       string `json:"trunk,omitempty"`
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
	if req.Repo != "" || req.Trunk != "" {
		if err := checkSecurityRepo(req.Repo, req.Trunk); err != nil {
			return err
		}
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
	// Result is the project's last assessment of its failed scans (mission.LiveSecurityResult); Scope the repository and the
	// trunk it read (mission.LiveSecurityScope).
	Result func(dir string) (secfix.Result, bool)
	Scope  func(dir string) (repo string, trunk string, ok bool)
	// Lookup is what the advisory database says of an advisory, one entry per affected package; false when it holds none for
	// the id. Without it nothing is verified, so no fix starts: the ids a scan names are never trusted for what to install.
	Lookup func(ctx context.Context, id string) ([]secfix.Advisory, bool, error)
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
	// unverified are the ids of the block that the advisory database does not know: the brief shows them as the scan named
	// them and says so. Only a launch the developer asked for may have any.
	unverified []string
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
	repo, trunk, scoped := "", "", false
	if r.env.SecurityFix.Scope != nil {
		repo, trunk, scoped = r.env.SecurityFix.Scope(req.Dir)
	}
	if !scoped || checkSecurityRepo(repo, trunk) != nil {
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Reason: SecurityReasonBlockGone,
			Message: "The scan no longer fails on these advisories: there is nothing to fix."}}, nil
	}
	return r.launchSecurityFix(ctx, securityLaunch{dir: req.Dir, repo: repo, trunk: trunk, workspaceId: req.WorkspaceId,
		tabName: req.TabName, agent: req.Agent, block: block, force: true}), nil
}

// securityAssessed is told of each assessment of a project's failed scans. With the developer's consent, each shared block
// gets its fix, one after the other and in the background; without it nothing happens here, the block only offers.
func (r *Restarter) securityAssessed(assessed mission.SecurityAssessed) {
	if !r.securityConsentOn() {
		return
	}
	if len(assessed.Result.Blocks) == 0 || checkSecurityRepo(assessed.Repo, assessed.Trunk) != nil {
		return
	}
	r.apart(func() {
		defer func() { panichandler.PanicHandler("molten:review:securityfix:assessed", recover()) }()
		r.launchAssessed(assessed)
	})
}

// apart runs work off the caller's goroutine, which is told of an assessment from the one that made it; the tests run it
// where they stand, so that they know when it is over.
func (r *Restarter) apart(work func()) {
	if r.spawn != nil {
		r.spawn(work)
		return
	}
	go func() {
		defer func() { panichandler.PanicHandler("molten:review:securityfix:apart", recover()) }()
		work()
	}()
}

// securityConsentOn: the developer allowed the fix to start without a click, and the answer stands now.
func (r *Restarter) securityConsentOn() bool {
	return r.env.SecurityFix.Consent != nil && r.env.SecurityFix.Consent() == secfix.ConsentOn
}

// launchAssessed gives each shared block of an assessment its fix, one after the other.
func (r *Restarter) launchAssessed(assessed mission.SecurityAssessed) {
	for _, block := range assessed.Result.Blocks {
		if !block.Shared || len(block.Advisories) == 0 || !securityBlockLaunchable(block) || !block.TrustedForAuto() {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
		r.launchSecurityFix(ctx, securityLaunch{dir: filepath.Clean(assessed.Dir), repo: assessed.Repo, trunk: assessed.Trunk,
			block: block, auto: true})
		cancel()
	}
}

// securityBlockLaunchable: only a scan the project declared or the developer confirmed starts anything (AC10). Without a
// click, launchAssessed also asks for a block that is TrustedForAuto: a single pull request's own CI log is no ground to
// start an agent on.
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
		if in.force && decided.Auto {
			// The developer asks for it by hand now: the claim is theirs, and the consent turned off later does not drop it.
			if updated, _, _ := store.Update(in.dir, decided.Fingerprint, func(f *secfix.Fix) bool { f.Auto = false; return true }); updated.State != "" {
				decided = updated
			}
		}
		return r.startSecurityFix(ctx, in, decided, ids)
	case secfix.PlanAddendum:
		r.securityAddendum(ctx, in, decided, ids)
		return securityAnswer(SecurityFixAddendum, decided)
	case secfix.PlanHeld:
		return securityAnswer(SecurityFixHeld, decided)
	}
	return r.startSecurityFix(ctx, in, decided, ids)
}

// firstTime is true the first time it is asked for a key, for as long as MoltenTerm runs: what is told once and not again.
func (r *Restarter) firstTime(key string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.secTold[key] {
		return false
	}
	if r.secTold == nil {
		r.secTold = map[string]bool{}
	}
	r.secTold[key] = true
	return true
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
	updated, _, err := store.Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.RetryAt = secfix.FixWaiting, reason, retryAt
		f.WorkspaceId, f.Agent = firstNonEmpty(in.workspaceId, f.WorkspaceId), firstNonEmpty(in.agent, f.Agent)
		if count {
			f.Tries++
		}
		return true
	})
	if errors.Is(err, secfix.ErrEnded) {
		return securityAnswer(SecurityFixStoppedStatus, updated)
	}
	r.followSecurityFix(in.dir, fix.Fingerprint)
	return securityAnswer(SecurityFixWaiting, updated)
}

// securityGiveUp ends a fix that could not start after several tries: it is failed, so it is never started again on its
// own, and the developer is told why. A fix the developer stopped meanwhile stays stopped, and nobody is told.
func (r *Restarter) securityGiveUp(ctx context.Context, in securityLaunch, fix secfix.Fix, reason string, detail string) SecurityFixResult {
	updated, _, err := r.fixStore().Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.Outcome = secfix.FixFailed, reason, secfix.CleanLine(detail, outcomeMaxLength)
		return true
	})
	if errors.Is(err, secfix.ErrEnded) {
		return securityAnswer(SecurityFixStoppedStatus, updated)
	}
	r.notify(ctx, securityNeedsYou(updated, detail))
	return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Message: detail}, Fix: &updated}
}

// securityEnded tells whether the fix this launch works for ended meanwhile (the developer stopped it, or its claim was let
// go): a launch asks before each step that makes something, and a Stop that landed is never undone by the steps that follow.
func (r *Restarter) securityEnded(in securityLaunch, fix secfix.Fix) (secfix.Fix, bool) {
	current, ok := r.fixStore().Get(in.dir, fix.Fingerprint)
	if !ok {
		return fix, true
	}
	return current, current.Ended()
}

// startSecurityFix takes a claimed fix to a running agent: the place, the agent, the ticket, the worktree, the brief and
// the terminal, in that order, each undone when the next fails.
func (r *Restarter) startSecurityFix(ctx context.Context, in securityLaunch, fix secfix.Fix, ids []string) SecurityFixResult {
	if in.auto && !r.securityConsentOn() {
		// A claim that waited for its place outlived the consent: what the developer turned off starts nothing, not even what
		// was claimed while it was on.
		r.fixStore().Remove(in.dir, fix.Fingerprint)
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Reason: SecurityReasonConsentOff,
			Message: "The standing consent to start the fix without a click is off: nothing was started."}}
	}
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
		// Nothing is recorded for an agent that is not installed: the next assessment, or the click, tries again. The
		// developer who allowed it is told once why nothing starts.
		r.fixStore().Remove(in.dir, fix.Fingerprint)
		if in.auto && r.firstTime("noagent:"+in.dir+":"+fix.Fingerprint) {
			fix.Reason = secfix.ReasonNoAgent
			r.notify(ctx, securityNeedsYou(fix, result.Message))
		}
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
	verified, unverified, err := r.securityVerify(ctx, in)
	if err != nil {
		log.Printf("%s security fix %s: the advisories could not be checked: %v\n", logPrefix, fix.Fingerprint, err)
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, "The advisory database could not be read: "+secfix.CleanLine(err.Error(), 120))
	}
	if len(unverified) > 0 && in.auto {
		// An id the database does not know is a scan's word and nobody's: nothing starts on its own for it, and nothing is
		// kept, so the developer's click (which shows the id as the scan named it, and nothing else) is still there.
		log.Printf("%s security fix %s: the advisory database does not know %s: nothing starts on its own\n", logPrefix, fix.Fingerprint, strings.Join(unverified, ", "))
		r.fixStore().Remove(in.dir, fix.Fingerprint)
		return SecurityFixResult{RestartResult: RestartResult{Status: RestartFailed, Reason: SecurityReasonUnverified,
			Message: "The advisory database does not know " + strings.Join(shownIds(unverified), ", ") + ": nothing was started."}}
	}
	in.block.Advisories, in.unverified = verified, unverified
	if current, ended := r.securityEnded(in, fix); ended {
		return securityAnswer(SecurityFixStoppedStatus, current)
	}
	ticket, err := r.securityTicket(ctx, in, &fix)
	if err != nil {
		log.Printf("%s security fix %s: no ticket: %v\n", logPrefix, fix.Fingerprint, err)
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, err.Error())
	}
	if ticket.external {
		return r.securityExternal(ctx, in, fix, ticket)
	}
	// The ticket is kept at once, whatever happens to the fix after: a launch that fails past this point finds it again,
	// never makes a second one (a search of GitHub's may not see a ticket made a moment ago).
	if kept, found, _ := r.fixStore().Amend(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.Ticket, f.TicketUrl, f.TicketNew = ticket.number, ticket.url, ticket.created
		return true
	}); found {
		fix = kept
	}
	if current, ended := r.securityEnded(in, fix); ended {
		return securityAnswer(SecurityFixStoppedStatus, current)
	}
	branch := r.securityBranch(ctx, in.dir, ticket.number, ids)
	tree, err := r.securityTree(ctx, in.dir, in.trunk, branch, ticket.number)
	if err != nil {
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, err.Error())
	}
	// A launch that fails, or that the developer stops while it works, leaves nothing behind: its copy goes, and the branch
	// it just cut with it (nothing was pushed); what it opened (the tab, the terminal and its agent) goes too.
	var tabId, blockId string
	undo := func() {
		if blockId != "" {
			if r.env.SecurityFix.StopAgent != nil {
				r.env.SecurityFix.StopAgent(ctx, blockId)
			}
			if r.env.CloseTerminal != nil {
				r.env.CloseTerminal(ctx, blockId)
			}
		}
		if tabId != "" && r.env.CloseTab != nil {
			r.env.CloseTab(ctx, tabId)
		}
		r.git(ctx, in.dir, "worktree", "remove", "--force", tree)
		r.git(ctx, in.dir, "branch", "-D", branch)
	}
	briefPath, err := r.securityBrief(in, fix, ticket.number, branch, tree)
	if err != nil {
		undo()
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, fmt.Sprintf("the brief could not be written: %v", err))
	}
	origin := AgentOrigin{Kind: AgentOriginSecurity, Repo: in.repo, Branch: branch, Base: in.trunk, Ticket: ticket.number,
		Advisories: secfix.CleanLine(strings.Join(shownIds(ids), ", "), 80), Auto: in.auto, Mode: AgentModeBackground, At: r.env.Now().UnixMilli()}
	name := in.tabName
	if name == "" {
		name = "Security fix #" + strconv.Itoa(ticket.number)
	}
	if current, ended := r.securityEnded(in, fix); ended {
		undo()
		return securityAnswer(SecurityFixStoppedStatus, current)
	}
	tabId, err = r.env.AgentTab(ctx, in.workspaceId, name, waveobj.MetaMapType{AgentTabMetaKey: securityTabPrefix + fix.Fingerprint}, true)
	if err != nil {
		tabId = ""
		undo()
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, fmt.Sprintf("The agent's tab could not be made: %v", err))
	}
	// The last look before an agent starts: after it, a Stop finds the fix with its terminal and ends the agent itself.
	if current, ended := r.securityEnded(in, fix); ended {
		undo()
		return securityAnswer(SecurityFixStoppedStatus, current)
	}
	command := reviewsession.CommandLine(agent, []string{"--", securityPromptLine(ticket.number, ids, briefPath)})
	var openErr error
	blockId, openErr = r.env.OpenTerminal(ctx, tabId, "", waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     tree,
		molten.WorktreeMetaKey:     tree,
		OriginMetaKey:              origin,
	}, command)
	if blockId == "" {
		undo()
		return r.securityRetry(ctx, in, fix, secfix.ReasonLaunchFailed, fmt.Sprintf("The agent was not started (%v).", openErr))
	}
	started, _, uerr := r.fixStore().Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.RetryAt, f.Tries = secfix.FixWorking, "", 0, 0
		f.Ticket, f.TicketUrl, f.TicketNew = ticket.number, ticket.url, ticket.created
		f.Branch, f.Tree, f.Agent, f.AgentName = branch, tree, agent, molten.AgentDisplayName(agent)
		f.WorkspaceId, f.TabId, f.BlockId = in.workspaceId, tabId, blockId
		return true
	})
	if errors.Is(uerr, secfix.ErrEnded) {
		// Stopped while the terminal opened: the Stop did not know of it, so this launch ends what it started.
		undo()
		return securityAnswer(SecurityFixStoppedStatus, started)
	}
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
