// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Validate (FR-REV-012, DS-REV-010): GitHub does not let the developer approve their own PR, so validating one is a
// rebase and merge from MoltenTerm. Validate builds a plan from one fresh gh pr view and the review store: the checks
// and the steps. The plan is kept here under an id and bound to the head it read. Merge runs only on the developer's
// click on that plan, reads the PR again, refuses when anything was pushed since, and lets GitHub refuse too
// (--match-head-commit). A PR behind its base is rebased by GitHub first and merged once CI passed on the new head.
// The merge is never retried: a refusal or a failure asks for a new Validate. Its progress and outcome are kept in the
// review store; the cleanup after a merge is the PostMerge hook's (FR-REV-013, postmerge.go).

const (
	MergeMethodRebase = "rebase"

	CheckOk      = "ok"
	CheckInfo    = "info"
	CheckWarn    = "warn"
	CheckPending = "pending"
	CheckFail    = "fail"

	CheckIdOpen     = "open"
	CheckIdCi       = "ci"
	CheckIdConflict = "conflict"
	CheckIdBlocked  = "blocked"
	CheckIdBehind   = "behind"
	CheckIdComments = "comments"
	CheckIdRestart  = "restart"

	StepUpdate = "update"
	StepWaitCi = "waitci"
	StepMerge  = "merge"

	MergeChecking  = "checking"
	MergeUpdating  = "updating"
	MergeWaitingCi = "waitingci"
	MergeMerging   = "merging"
	MergeMerged    = "merged"
	MergeRefused   = "refused"
	MergeFailed    = "failed"
	MergeCancelled = "cancelled"

	// Why a merge was refused: the head moved since the plan (review the new commits), or a check fails now.
	RefusedHeadMoved  = "headmoved"
	RefusedBaseMoved  = "basemoved"
	RefusedCheck      = "check"
	RefusedMergedAway = "mergedaway"
)

const (
	// A plan is a decision on what the developer saw: an old one is not merged on.
	planMaxAge = 30 * time.Minute
	// The rebase by GitHub then CI on the new head; past this, the merge gives up (never merges late unseen).
	defaultCiTimeout = 45 * time.Minute
	defaultPollEvery = 15 * time.Second
	ghCallTimeout    = 2 * time.Minute
	// gh pr view failing this many times in a row while waiting for CI stops the merge.
	maxPollErrors = 4
	// GitHub may still say BLOCKED for a little while after the last check passed.
	maxBlockedPolls = 8
)

var prViewFields = "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences,mergeCommit"

// DS-REV-011: gh's messages are kept, but never a token in gh's formats.
var ghTokenRe = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`)

// GhRunner runs gh in a folder; tests fake it.
type GhRunner func(ctx context.Context, dir string, args ...string) ([]byte, error)

type MergeCheck struct {
	Id     string `json:"id"`
	Label  string `json:"label"`
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
}

type MergeStep struct {
	Id     string `json:"id"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

type MergePlanRequest struct {
	PrKey
	Dir string `json:"dir"`
	// Ticket: the Review tab's (closingIssuesReferences, else the branch pattern); the PR's closing reference otherwise.
	Ticket int `json:"ticket,omitempty"`
}

type MergePlan struct {
	Id         string `json:"id"`
	Repo       string `json:"repo"`
	Number     int    `json:"number"`
	Dir        string `json:"dir"`
	Title      string `json:"title,omitempty"`
	Url        string `json:"url,omitempty"`
	Ticket     int    `json:"ticket,omitempty"`
	HeadRef    string `json:"headref"`
	BaseRef    string `json:"baseref"`
	HeadOid    string `json:"headoid"`
	PrState    string `json:"prstate"`
	MergeState string `json:"mergestate,omitempty"`
	Mergeable  string `json:"mergeable,omitempty"`
	// Behind: GitHub rebases the branch first, then CI runs again on the new head before the merge (AC3).
	Behind  bool                `json:"behind,omitempty"`
	Checks  []MergeCheck        `json:"checks"`
	Steps   []MergeStep         `json:"steps"`
	Cleanup []CleanupStepResult `json:"cleanup"`
	// CanMerge: no check fails or waits; Reason: the first one that does (AC4).
	CanMerge bool   `json:"canmerge"`
	Reason   string `json:"reason,omitempty"`
	// Warnings the developer confirms to merge anyway (unpublished comments, a restart in flight).
	Warnings  []string `json:"warnings"`
	CreatedAt int64    `json:"createdat"`

	ciNames []string
}

type MergeRequest struct {
	PrKey
	PlanId string `json:"planid"`
	// Override: the developer confirmed the plan's warnings.
	Override bool `json:"override,omitempty"`
}

// MergeRecord is the merge's progress and outcome, kept in the review store (AC5).
type MergeRecord struct {
	PlanId string `json:"planid"`
	Method string `json:"method"`
	// PlanHead: the head the plan was made for; Head: the head merged (or to merge), the rebased one when GitHub
	// updated the branch first.
	PlanHead  string `json:"planhead"`
	Head      string `json:"head,omitempty"`
	MergedOid string `json:"mergedoid,omitempty"`
	State     string `json:"state"`
	// Refused: why (Refused…); Message: what the developer reads.
	Refused    string   `json:"refused,omitempty"`
	Message    string   `json:"message,omitempty"`
	Updated    bool     `json:"updated,omitempty"`
	Overridden []string `json:"overridden,omitempty"`
	StartedAt  int64    `json:"startedat"`
	EndedAt    int64    `json:"endedat,omitempty"`
	// CleanupRunning: the post-merge hook runs; its outcome is the store's State.Cleanup.
	CleanupRunning bool `json:"cleanuprunning,omitempty"`
}

func (r MergeRecord) ended() bool {
	switch r.State {
	case MergeMerged, MergeRefused, MergeFailed, MergeCancelled:
		return true
	}
	return false
}

type ghMergePr struct {
	Number                  int             `json:"number"`
	Title                   string          `json:"title"`
	Url                     string          `json:"url"`
	State                   string          `json:"state"`
	IsDraft                 bool            `json:"isDraft"`
	HeadRefName             string          `json:"headRefName"`
	BaseRefName             string          `json:"baseRefName"`
	HeadRefOid              string          `json:"headRefOid"`
	Mergeable               string          `json:"mergeable"`
	MergeStateStatus        string          `json:"mergeStateStatus"`
	StatusCheckRollup       json.RawMessage `json:"statusCheckRollup"`
	ClosingIssuesReferences []struct {
		Number int `json:"number"`
	} `json:"closingIssuesReferences"`
	MergeCommit *struct {
		Oid string `json:"oid"`
	} `json:"mergeCommit"`
}

type runningMerge struct {
	planId string
	cancel context.CancelFunc
}

// Merger plans and runs the merges; one at a time per PR.
type Merger struct {
	gh        GhRunner
	store     *Store
	publish   func(k PrKey, state State)
	now       func() time.Time
	pollEvery time.Duration
	ciTimeout time.Duration
	sleep     func(ctx context.Context, d time.Duration) bool

	lock    sync.Mutex
	plans   map[PrKey]MergePlan
	running map[PrKey]*runningMerge
	// done is closed when a merge's goroutine ends; tests wait on it.
	done map[PrKey]chan struct{}
}

func MakeMerger(store *Store, gh GhRunner, publish func(k PrKey, state State)) *Merger {
	return &Merger{
		gh:        gh,
		store:     store,
		publish:   publish,
		now:       time.Now,
		pollEvery: defaultPollEvery,
		ciTimeout: defaultCiTimeout,
		sleep:     sleepCtx,
		plans:     map[PrKey]MergePlan{},
		running:   map[PrKey]*runningMerge{},
		done:      map[PrKey]chan struct{}{},
	}
}

// mergeRunner runs gh for Validate in wavesrv (a test build may replace it, cleanup_testoverride.go).
var mergeRunner mission.Runner = mission.ExecRunner

func ExecGh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return mergeRunner(ctx, dir, "gh", args...)
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func maskTokens(text string) string {
	return ghTokenRe.ReplaceAllString(text, "<github-token>")
}

func shortHead(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

// runGh names the repository in every call (the ghArgs rule of pkg/molten/release): gh resolves a remote named
// upstream before origin. With --repo, gh pr merge --delete-branch also leaves the local checkout and branch alone:
// those are the cleanup's (FR-REV-013), which checks them first.
func (m *Merger) runGh(ctx context.Context, dir string, repo string, args ...string) ([]byte, error) {
	if m.gh == nil {
		return nil, fmt.Errorf("gh is not available")
	}
	ctx, cancel := context.WithTimeout(ctx, ghCallTimeout)
	defer cancel()
	out, err := m.gh(ctx, dir, append(args, "--repo", repo)...)
	if err != nil {
		return out, fmt.Errorf("%s", maskTokens(err.Error()))
	}
	return out, nil
}

func (m *Merger) viewPr(ctx context.Context, dir string, k PrKey) (ghMergePr, error) {
	var pr ghMergePr
	out, err := m.runGh(ctx, dir, k.Repo, "pr", "view", strconv.Itoa(k.Number), "--json", prViewFields)
	if err != nil {
		return pr, err
	}
	if err := json.Unmarshal(out, &pr); err != nil {
		return pr, fmt.Errorf("gh pr view answered something unreadable: %v", err)
	}
	if pr.Number != k.Number || !isOid(pr.HeadRefOid) {
		return pr, fmt.Errorf("gh pr view did not answer pull request #%d", k.Number)
	}
	return pr, nil
}

func checkNames(checks []mission.ReviewCheck) []string {
	rtn := make([]string, 0, len(checks))
	for _, c := range checks {
		rtn = append(rtn, c.Name)
	}
	return rtn
}

func namesIn(checks []mission.ReviewCheck, state string) []string {
	var rtn []string
	for _, c := range checks {
		if c.State == state {
			rtn = append(rtn, c.Name)
		}
	}
	return rtn
}

func listNames(names []string) string {
	const shown = 3
	if len(names) <= shown {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:shown], ", ") + fmt.Sprintf(" and %d more", len(names)-shown)
}

func ciCheck(ci mission.ReviewCi) MergeCheck {
	check := MergeCheck{Id: CheckIdCi, Label: "CI is green, local-* statuses included"}
	local := 0
	for _, c := range ci.Checks {
		if c.Local {
			local++
		}
	}
	switch ci.State {
	case mission.ReviewCheckFailure:
		check.State = CheckFail
		check.Detail = fmt.Sprintf("%d failing: %s", ci.Failure, listNames(namesIn(ci.Checks, mission.ReviewCheckFailure)))
	case mission.ReviewCheckPending:
		check.State = CheckPending
		check.Detail = fmt.Sprintf("%d still running: %s", ci.Pending, listNames(namesIn(ci.Checks, mission.ReviewCheckPending)))
	case mission.ReviewCheckNone:
		check.State = CheckOk
		check.Detail = "No check reported on this pull request"
	default:
		check.State = CheckOk
		check.Detail = fmt.Sprintf("%d passed", ci.Success)
		if local > 0 {
			check.Detail += fmt.Sprintf(", %d of them local", local)
		}
	}
	return check
}

// evaluate turns a fresh read of the PR and the store into the plan's checks (AC1, AC4). Fails and pendings block the
// merge; warnings need the developer's confirmation.
func evaluate(pr ghMergePr, ci mission.ReviewCi, unpublished int, restart *Round) []MergeCheck {
	var checks []MergeCheck
	open := MergeCheck{Id: CheckIdOpen, Label: "Open and ready for review", State: CheckOk}
	switch {
	case !strings.EqualFold(pr.State, "OPEN"):
		open.State = CheckFail
		open.Detail = fmt.Sprintf("The pull request is %s", strings.ToLower(pr.State))
	case pr.IsDraft:
		open.State = CheckFail
		open.Detail = "The pull request is a draft: mark it ready for review first"
	}
	checks = append(checks, open, ciCheck(ci))
	mergeState := strings.ToUpper(pr.MergeStateStatus)
	conflict := MergeCheck{Id: CheckIdConflict, Label: "No conflict with the base", State: CheckOk}
	switch {
	case strings.EqualFold(pr.Mergeable, "CONFLICTING") || mergeState == "DIRTY":
		conflict.State = CheckFail
		conflict.Detail = fmt.Sprintf("The branch conflicts with %s: it needs a rebase (Restart work can hand it to an agent)", pr.BaseRefName)
	case strings.EqualFold(pr.Mergeable, "UNKNOWN") || mergeState == "UNKNOWN" || mergeState == "":
		conflict.State = CheckPending
		conflict.Detail = "GitHub is still computing whether it merges cleanly: re-check in a moment"
	}
	checks = append(checks, conflict)
	blocked := MergeCheck{Id: CheckIdBlocked, Label: "Not blocked by the repository's rules", State: CheckOk}
	if mergeState == "BLOCKED" {
		blocked.State = CheckFail
		blocked.Detail = "GitHub blocks the merge: a required check or review is missing"
	}
	checks = append(checks, blocked)
	if mergeState == "BEHIND" {
		checks = append(checks, MergeCheck{
			Id:     CheckIdBehind,
			Label:  "Up to date with the base",
			State:  CheckInfo,
			Detail: fmt.Sprintf("Behind %s: GitHub rebases it first, then the merge waits for CI on the new head", pr.BaseRefName),
		})
	}
	comments := MergeCheck{Id: CheckIdComments, Label: "No unpublished comment", State: CheckOk}
	if unpublished > 0 {
		comments.State = CheckWarn
		comments.Detail = fmt.Sprintf("%d comment(s) written in MoltenTerm are not published: they stay here, unpublished", unpublished)
	}
	checks = append(checks, comments)
	restartCheck := MergeCheck{Id: CheckIdRestart, Label: "No restart of the work in flight", State: CheckOk}
	if restart != nil {
		restartCheck.State = CheckWarn
		restartCheck.Detail = "Restart work was sent on this head and nothing was pushed since: an agent may still be working on it"
	}
	checks = append(checks, restartCheck)
	return checks
}

// restartInFlight: the last round was handed back to an agent (Restart work, FR-REV-011) and the head did not move
// since, so its work is not pushed yet.
func restartInFlight(state State, head string) *Round {
	if len(state.Rounds) == 0 {
		return nil
	}
	last := state.Rounds[len(state.Rounds)-1]
	if last.RestartedAt == 0 || last.HeadOid != head {
		return nil
	}
	return &last
}

func blockingOf(checks []MergeCheck) (bool, string) {
	for _, c := range checks {
		if c.State == CheckFail || c.State == CheckPending {
			reason := c.Detail
			if reason == "" {
				reason = c.Label
			}
			return true, reason
		}
	}
	return false, ""
}

func warningsOf(checks []MergeCheck) []string {
	rtn := []string{}
	for _, c := range checks {
		if c.State == CheckWarn {
			rtn = append(rtn, c.Id)
		}
	}
	return rtn
}

func ticketOf(req int, pr ghMergePr) int {
	if req > 0 {
		return req
	}
	for _, ref := range pr.ClosingIssuesReferences {
		if ref.Number > 0 {
			return ref.Number
		}
	}
	return 0
}

func (m *Merger) inputs(ctx context.Context, dir string, k PrKey) (ghMergePr, mission.ReviewCi, int, State, error) {
	pr, err := m.viewPr(ctx, dir, k)
	if err != nil {
		return pr, mission.ReviewCi{}, 0, State{}, err
	}
	ci, err := mission.ParseReviewChecks(pr.StatusCheckRollup)
	if err != nil {
		return pr, ci, 0, State{}, fmt.Errorf("the checks could not be read: %v", err)
	}
	unpublished, err := m.store.Unpublished(k)
	if err != nil {
		return pr, ci, 0, State{}, err
	}
	state, err := m.store.Get(k)
	if err != nil {
		return pr, ci, 0, State{}, err
	}
	return pr, ci, unpublished, state, nil
}

// Plan reads the PR once and builds the plan sheet (AC1); it changes nothing on GitHub.
func (m *Merger) Plan(ctx context.Context, req MergePlanRequest) (MergePlan, error) {
	if err := checkDir(req.Dir); err != nil {
		return MergePlan{}, err
	}
	if err := req.PrKey.check(); err != nil {
		return MergePlan{}, err
	}
	pr, ci, unpublished, state, err := m.inputs(ctx, req.Dir, req.PrKey)
	if err != nil {
		return MergePlan{}, err
	}
	checks := evaluate(pr, ci, unpublished, restartInFlight(state, pr.HeadRefOid))
	blocked, reason := blockingOf(checks)
	plan := MergePlan{
		Id:         uuid.NewString(),
		Repo:       req.Repo,
		Number:     req.Number,
		Dir:        req.Dir,
		Title:      pr.Title,
		Url:        pr.Url,
		Ticket:     ticketOf(req.Ticket, pr),
		HeadRef:    pr.HeadRefName,
		BaseRef:    pr.BaseRefName,
		HeadOid:    pr.HeadRefOid,
		PrState:    pr.State,
		MergeState: pr.MergeStateStatus,
		Mergeable:  pr.Mergeable,
		Behind:     strings.EqualFold(pr.MergeStateStatus, "BEHIND"),
		Checks:     checks,
		CanMerge:   !blocked,
		Reason:     reason,
		Warnings:   warningsOf(checks),
		CreatedAt:  m.now().UnixMilli(),
		ciNames:    checkNames(ci.Checks),
	}
	plan.Steps = planSteps(plan)
	plan.Cleanup = currentPostMerge().Plan(ctx, plan.mergedPr("", ""))
	if plan.Cleanup == nil {
		plan.Cleanup = []CleanupStepResult{}
	}
	m.keepPlan(plan)
	return plan, nil
}

func planSteps(plan MergePlan) []MergeStep {
	var steps []MergeStep
	if plan.Behind {
		steps = append(steps,
			MergeStep{Id: StepUpdate, Label: fmt.Sprintf("GitHub rebases %s on %s", plan.HeadRef, plan.BaseRef), Detail: "gh pr update-branch --rebase"},
			MergeStep{Id: StepWaitCi, Label: "Wait for CI on the rebased head", Detail: "The merge goes on only when every check passed again"},
		)
	}
	steps = append(steps, MergeStep{
		Id:     StepMerge,
		Label:  fmt.Sprintf("Rebase and merge into %s, then delete %s on GitHub", plan.BaseRef, plan.HeadRef),
		Detail: fmt.Sprintf("Bound to head %s: refused if anything is pushed after this plan", shortHead(plan.HeadOid)),
	})
	return steps
}

func (p MergePlan) mergedPr(head string, merged string) MergedPr {
	if head == "" {
		head = p.HeadOid
	}
	return MergedPr{Dir: p.Dir, Repo: p.Repo, Number: p.Number, Ticket: p.Ticket, Url: p.Url, HeadRef: p.HeadRef, BaseRef: p.BaseRef, HeadOid: head, MergedOid: merged}
}

func (m *Merger) keepPlan(plan MergePlan) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.plans[PrKey{Repo: plan.Repo, Number: plan.Number}] = plan
}

// takePlan hands the plan to one merge: a plan is used once, so a refused or failed merge needs a new Validate.
func (m *Merger) takePlan(req MergeRequest) (MergePlan, *runningMerge, chan struct{}, error) {
	m.lock.Lock()
	defer m.lock.Unlock()
	k := req.PrKey
	if m.running[k] != nil {
		return MergePlan{}, nil, nil, fmt.Errorf("a merge of #%d is already running", k.Number)
	}
	plan, ok := m.plans[k]
	if !ok || plan.Id != req.PlanId {
		return MergePlan{}, nil, nil, fmt.Errorf("this plan is no longer current: Validate again")
	}
	if m.now().Sub(time.UnixMilli(plan.CreatedAt)) > planMaxAge {
		delete(m.plans, k)
		return MergePlan{}, nil, nil, fmt.Errorf("this plan is more than %d minutes old: Validate again", int(planMaxAge.Minutes()))
	}
	if !plan.CanMerge {
		return MergePlan{}, nil, nil, fmt.Errorf("the plan does not allow the merge: %s", plan.Reason)
	}
	if len(plan.Warnings) > 0 && !req.Override {
		return MergePlan{}, nil, nil, fmt.Errorf("confirm the plan's warnings to merge anyway")
	}
	delete(m.plans, k)
	run := &runningMerge{planId: plan.Id}
	done := make(chan struct{})
	m.running[k] = run
	m.done[k] = done
	return plan, run, done, nil
}

func (m *Merger) finishRun(k PrKey, run *runningMerge) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.running[k] == run {
		delete(m.running, k)
	}
}

// Merge starts the merge the developer clicked (AC2, AC5) and returns at once; the progress goes to the store.
func (m *Merger) Merge(req MergeRequest) (MergeRecord, error) {
	if err := req.PrKey.check(); err != nil {
		return MergeRecord{}, err
	}
	plan, run, done, err := m.takePlan(req)
	if err != nil {
		return MergeRecord{}, err
	}
	record := MergeRecord{PlanId: plan.Id, Method: MergeMethodRebase, PlanHead: plan.HeadOid, Head: plan.HeadOid, State: MergeChecking, StartedAt: m.now().UnixMilli()}
	if req.Override {
		record.Overridden = plan.Warnings
	}
	m.record(req.PrKey, record)
	ctx, cancel := context.WithTimeout(context.Background(), m.ciTimeout+10*time.Minute)
	run.cancel = cancel
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:review:merge", recover())
		}()
		defer close(done)
		defer m.finishRun(req.PrKey, run)
		defer cancel()
		m.run(ctx, plan, record)
	}()
	return record, nil
}

// Cancel stops a merge still waiting (the rebase by GitHub or CI); a merge call already sent is not undone.
func (m *Merger) Cancel(k PrKey) error {
	if err := k.check(); err != nil {
		return err
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	run := m.running[k]
	if run == nil || run.cancel == nil {
		return fmt.Errorf("no merge of #%d is running", k.Number)
	}
	run.cancel()
	return nil
}

// wait returns when the PR's merge goroutine has ended (tests).
func (m *Merger) wait(k PrKey) {
	m.lock.Lock()
	done := m.done[k]
	m.lock.Unlock()
	if done != nil {
		<-done
	}
}

func (m *Merger) record(k PrKey, record MergeRecord) {
	if record.ended() && record.EndedAt == 0 {
		record.EndedAt = m.now().UnixMilli()
	}
	state, changed, err := m.store.SetMerge(k, record)
	if err != nil {
		log.Printf("%s %s#%d: the merge record could not be kept: %v\n", logPrefix, k.Repo, k.Number, err)
		return
	}
	if changed && m.publish != nil {
		m.publish(k, state)
	}
}

func (m *Merger) end(k PrKey, record MergeRecord, state string, refused string, message string) MergeRecord {
	record.State = state
	record.Refused = refused
	record.Message = maskTokens(message)
	m.record(k, record)
	log.Printf("%s %s#%d merge %s: %s\n", logPrefix, k.Repo, k.Number, state, record.Message)
	return record
}

func headMovedMessage(head string, planHead string) string {
	return fmt.Sprintf("New commits were pushed since the plan (head %s, the plan was made for %s): review them, then Validate again", shortHead(head), shortHead(planHead))
}

func (m *Merger) run(ctx context.Context, plan MergePlan, record MergeRecord) {
	k := PrKey{Repo: plan.Repo, Number: plan.Number}
	pr, ci, unpublished, state, err := m.inputs(ctx, plan.Dir, k)
	if err != nil {
		m.end(k, record, MergeFailed, "", "The pull request could not be read again before the merge: "+err.Error())
		return
	}
	if strings.EqualFold(pr.State, "MERGED") {
		m.end(k, record, MergeRefused, RefusedMergedAway, "The pull request was merged outside MoltenTerm")
		return
	}
	if pr.HeadRefOid != plan.HeadOid {
		m.end(k, record, MergeRefused, RefusedHeadMoved, headMovedMessage(pr.HeadRefOid, plan.HeadOid))
		return
	}
	checks := evaluate(pr, ci, unpublished, restartInFlight(state, pr.HeadRefOid))
	if blocked, reason := blockingOf(checks); blocked {
		m.end(k, record, MergeRefused, RefusedCheck, "Not merged: "+reason)
		return
	}
	if !record.overrides(warningsOf(checks)) {
		m.end(k, record, MergeRefused, RefusedCheck, "Not merged: a new warning appeared since the plan, Validate again")
		return
	}
	head := plan.HeadOid
	if strings.EqualFold(pr.MergeStateStatus, "BEHIND") {
		var ok bool
		head, record, ok = m.updateAndWait(ctx, plan, record)
		if !ok {
			return
		}
	}
	record.State = MergeMerging
	record.Head = head
	m.record(k, record)
	_, err = m.runGh(ctx, plan.Dir, plan.Repo, "pr", "merge", strconv.Itoa(plan.Number), "--rebase", "--delete-branch", "--match-head-commit", head)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "head branch was modified") {
			m.end(k, record, MergeRefused, RefusedHeadMoved, "GitHub refused the merge because the branch moved: review the new commits, then Validate again")
			return
		}
		m.end(k, record, MergeFailed, "", "The merge failed and is not retried: "+err.Error())
		return
	}
	if after, err := m.viewPr(ctx, plan.Dir, k); err == nil && after.MergeCommit != nil {
		record.MergedOid = after.MergeCommit.Oid
	}
	record.CleanupRunning = true
	record = m.end(k, record, MergeMerged, "", fmt.Sprintf("Rebased and merged into %s at %s", plan.BaseRef, shortHead(head)))
	m.cleanup(plan, record, head)
}

func (r MergeRecord) overrides(warnings []string) bool {
	for _, w := range warnings {
		found := false
		for _, o := range r.Overridden {
			if o == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// cleanup runs the post-merge hook once (FR-REV-013); the hook records its outcome in the store.
func (m *Merger) cleanup(plan MergePlan, record MergeRecord, head string) {
	k := PrKey{Repo: plan.Repo, Number: plan.Number}
	currentPostMerge().Run(context.Background(), plan.mergedPr(head, record.MergedOid))
	record.CleanupRunning = false
	m.record(k, record)
}

// updateAndWait has GitHub rebase the branch on its base (gh pr update-branch --rebase), then waits until CI passed
// on the new head (AC3). Another head move while waiting refuses: only GitHub's rebase of the planned head is merged.
func (m *Merger) updateAndWait(ctx context.Context, plan MergePlan, record MergeRecord) (string, MergeRecord, bool) {
	k := PrKey{Repo: plan.Repo, Number: plan.Number}
	record.State = MergeUpdating
	m.record(k, record)
	if _, err := m.runGh(ctx, plan.Dir, plan.Repo, "pr", "update-branch", strconv.Itoa(plan.Number), "--rebase"); err != nil {
		m.end(k, record, MergeFailed, "", "GitHub could not rebase the branch on its base: "+err.Error())
		return "", record, false
	}
	record.Updated = true
	record.State = MergeWaitingCi
	m.record(k, record)
	deadline := m.now().Add(m.ciTimeout)
	newHead := ""
	errors := 0
	blockedPolls := 0
	for {
		if !m.sleep(ctx, m.pollEvery) {
			m.end(k, record, MergeCancelled, "", "Stopped while waiting for CI: nothing was merged")
			return "", record, false
		}
		if m.now().After(deadline) {
			m.end(k, record, MergeFailed, "", fmt.Sprintf("CI did not finish on the rebased head within %d minutes: nothing was merged", int(m.ciTimeout.Minutes())))
			return "", record, false
		}
		pr, err := m.viewPr(ctx, plan.Dir, k)
		if err != nil {
			errors++
			if errors >= maxPollErrors {
				m.end(k, record, MergeFailed, "", "The pull request could not be read while waiting for CI: "+err.Error())
				return "", record, false
			}
			continue
		}
		errors = 0
		if pr.HeadRefOid == plan.HeadOid {
			// GitHub has not rebased it yet.
			continue
		}
		if newHead == "" {
			newHead = pr.HeadRefOid
			record.Head = newHead
			m.record(k, record)
		} else if pr.HeadRefOid != newHead {
			m.end(k, record, MergeRefused, RefusedHeadMoved, headMovedMessage(pr.HeadRefOid, newHead))
			return "", record, false
		}
		done, outcome, refused, message := ciOnNewHead(pr, plan.ciNames)
		if !done && refused != "" {
			// Every check passed but GitHub still blocks: past a short grace, a missing review will not come by itself.
			blockedPolls++
			if blockedPolls >= maxBlockedPolls {
				m.end(k, record, MergeRefused, refused, message+": nothing was merged")
				return "", record, false
			}
			continue
		}
		blockedPolls = 0
		if !done {
			continue
		}
		if outcome != "" {
			m.end(k, record, outcome, refused, message)
			return "", record, false
		}
		return newHead, record, true
	}
}

// ciOnNewHead tells whether the rebased head can be merged: every check the plan saw has run again and passed, and
// GitHub says it merges cleanly. outcome is set when the merge must stop.
func ciOnNewHead(pr ghMergePr, planChecks []string) (bool, string, string, string) {
	ci, err := mission.ParseReviewChecks(pr.StatusCheckRollup)
	if err != nil {
		return false, "", "", ""
	}
	if failing := namesIn(ci.Checks, mission.ReviewCheckFailure); len(failing) > 0 {
		return true, MergeFailed, "", "CI failed on the rebased head (" + listNames(failing) + "): nothing was merged"
	}
	mergeState := strings.ToUpper(pr.MergeStateStatus)
	if strings.EqualFold(pr.Mergeable, "CONFLICTING") || mergeState == "DIRTY" {
		return true, MergeFailed, "", "The rebased branch conflicts with its base: nothing was merged"
	}
	present := map[string]bool{}
	for _, c := range ci.Checks {
		present[c.Name] = true
	}
	for _, name := range planChecks {
		if !present[name] {
			return false, "", "", ""
		}
	}
	if ci.Pending > 0 {
		return false, "", "", ""
	}
	switch mergeState {
	case "BEHIND":
		return true, MergeRefused, RefusedBaseMoved, "The base moved again while CI ran: nothing was merged, Validate again"
	case "CLEAN", "HAS_HOOKS", "UNSTABLE":
		return true, "", "", ""
	}
	if mergeState == "BLOCKED" {
		return false, "", RefusedCheck, "GitHub blocks the merge of the rebased head: a required check or review is missing"
	}
	// UNKNOWN: GitHub has not caught up with the finished checks yet.
	return false, "", "", ""
}
