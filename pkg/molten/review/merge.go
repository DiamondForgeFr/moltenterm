// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Validate (FR-REV-012, DS-REV-010): GitHub does not let the developer approve their own PR, so validating one is a
// merge from MoltenTerm, with a method the repository allows (#673, mergemethod.go). Validate builds a plan from one
// fresh gh pr view and the review store: the checks and the steps. The plan is kept here under an id and bound to the head it read. Merge runs only on the developer's
// click on that plan, reads the PR again, refuses when anything was pushed since, and lets GitHub refuse too
// (--match-head-commit). A PR behind its base is updated by GitHub first and merged once CI passed on the new head.
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
	// queued: a merge queue merges the PR; Validate waits until it did.
	MergeQueued    = "queued"
	MergeMerged    = "merged"
	MergeRefused   = "refused"
	MergeFailed    = "failed"
	MergeCancelled = "cancelled"

	// Why a merge was refused: the head moved since the plan (review the new commits), or a check fails now.
	RefusedHeadMoved  = "headmoved"
	RefusedBaseMoved  = "basemoved"
	RefusedCheck      = "check"
	RefusedMergedAway = "mergedaway"

	// What the sheet writes under a check (#672: Go gives codes and data, the frontend writes the sentences).
	CheckCodeNotOpen = "notopen"
	CheckCodeDraft   = "draft"
	CheckCodeFailing = "failing"
	// failingoptional: red checks GitHub does not require (it does not block the merge): a warning to confirm (#943).
	CheckCodeFailingOptional = "failingoptional"
	CheckCodeRunning         = "running"
	CheckCodeNoCheck         = "nocheck"
	CheckCodePassed          = "passed"
	CheckCodeConflicting     = "conflicting"
	CheckCodeComputing       = "computing"
	CheckCodeBlocked         = "blocked"
	CheckCodeWaitsCi         = "waitsci"
	CheckCodeBehind          = "behind"
	CheckCodeUnpublished     = "unpublished"
	CheckCodeInFlight        = "inflight"

	// What the sheet writes about a merge's outcome (MergeRecord.Code).
	MergeCodeMerged         = "merged"
	MergeCodeReread         = "reread"
	MergeCodeMergedAway     = "mergedaway"
	MergeCodeHeadMoved      = "headmoved"
	MergeCodeGithubMoved    = "githubheadmoved"
	MergeCodeCheck          = "check"
	MergeCodeNewWarning     = "newwarning"
	MergeCodeNewRed         = "newred"
	MergeCodeMergeError     = "mergeerror"
	MergeCodeMethodRefused  = "methodrefused"
	MergeCodeUpdateError    = "updateerror"
	MergeCodeStopped        = "stopped"
	MergeCodeCiTimeout      = "citimeout"
	MergeCodePollError      = "pollerror"
	MergeCodeCiFailed       = "cifailed"
	MergeCodeConflict       = "conflict"
	MergeCodeBaseMoved      = "basemoved"
	MergeCodeRebasedBlocked = "rebasedblocked"
	MergeCodeQueueClosed    = "queueclosed"
	MergeCodeQueueTimeout   = "queuetimeout"
	MergeCodeQueueStopped   = "queuestopped"

	// The errors of the merge commands, as codes the sheet translates (mergeErrorPrefix + code).
	MergeErrRunning  = "running"
	MergeErrStale    = "stale"
	MergeErrOld      = "old"
	MergeErrBlocked  = "blocked"
	MergeErrConfirm  = "confirm"
	MergeErrNotFound = "nomerge"
	MergeErrMethod   = "method"

	mergeErrorPrefix = "molten-review-merge:"
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

var prViewFields = "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,closingIssuesReferences,mergeCommit,body,author"

// GhRunner runs gh in a folder; tests fake it.
type GhRunner func(ctx context.Context, dir string, args ...string) ([]byte, error)

// MergeCheck is one pre-merge check. The sheet names it by its id and writes its detail from Code and the data.
type MergeCheck struct {
	Id    string `json:"id"`
	State string `json:"state"`
	Code  string `json:"code,omitempty"`
	// Count: failing or running checks, passed ones, unpublished comments; Local: the passed local-* statuses.
	Count   int      `json:"count,omitempty"`
	Local   int      `json:"local,omitempty"`
	Names   []string `json:"names,omitempty"`
	Base    string   `json:"base,omitempty"`
	PrState string   `json:"prstate,omitempty"`
}

// MergeStep is a step of the merge; the sheet writes it from the plan's branches and head.
type MergeStep struct {
	Id string `json:"id"`
}

func mergeError(code string) error {
	return errors.New(mergeErrorPrefix + code)
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
	// Behind: GitHub updates the branch first (a rebase for a rebase merge, a merge of the base otherwise), then CI
	// runs again on the new head before the merge (AC3).
	Behind bool `json:"behind,omitempty"`
	// Methods: the merge methods allowed, in GitHub's order; Method: the default (#673). MethodRule: what narrowed them
	// (MethodRule…); Queue: a merge queue merges the PR, with its own method.
	Methods    []string `json:"methods"`
	Method     string   `json:"method"`
	MethodRule string   `json:"methodrule,omitempty"`
	Queue      bool     `json:"queue,omitempty"`
	// MethodRefused: the repository's remembered method GitHub no longer allows; the sheet says what replaces it (#957).
	MethodRefused string              `json:"methodrefused,omitempty"`
	Checks        []MergeCheck        `json:"checks"`
	Steps         []MergeStep         `json:"steps"`
	Cleanup       []CleanupStepResult `json:"cleanup"`
	// CanMerge: no check fails or waits; Blocking: the id of the first one that does (AC4).
	CanMerge bool   `json:"canmerge"`
	Blocking string `json:"blocking,omitempty"`
	// CanQueue: nothing fails and only the CI runs, so the PR can be validated now and merged by the merge queue once
	// green (FR-REV-026, #912). GreenOnly: the review:validategreenonly setting is on and keeps it blocked.
	CanQueue  bool `json:"canqueue,omitempty"`
	GreenOnly bool `json:"greenonly,omitempty"`
	// Warnings the developer confirms to merge anyway (unpublished comments, a restart in flight).
	Warnings  []string `json:"warnings"`
	CreatedAt int64    `json:"createdat"`

	ciNames []string
	// redNames: the red checks GitHub does not require that the developer confirms merging with (#943).
	redNames []string
	// batch: the PRs a batch merge still has to merge after this one (FR-REV-025).
	batch []int
}

type MergeRequest struct {
	PrKey
	PlanId string `json:"planid"`
	// Override: the developer confirmed the plan's warnings.
	Override bool `json:"override,omitempty"`
	// Method: one of the plan's Methods; empty takes the plan's default.
	Method string `json:"method,omitempty"`
	// Batch: the PRs a batch merge (FR-REV-025) still has to merge after this one; the cleanup after this merge does
	// not ask their agents for a rebase, the batch does it.
	Batch []int `json:"batch,omitempty"`
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
	// Refused: why (Refused…). Code: what the developer reads (MergeCode…), written by the sheet from the data below;
	// Error: the raw gh error, tokens masked.
	Refused string `json:"refused,omitempty"`
	Code    string `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
	// Blocking: the check that fails now; Names: the failing checks on the rebased head; MovedFrom/MovedTo: the head
	// expected and the one found; Minutes: the CI wait that ran out.
	Blocking   *MergeCheck `json:"blocking,omitempty"`
	Names      []string    `json:"names,omitempty"`
	MovedFrom  string      `json:"movedfrom,omitempty"`
	MovedTo    string      `json:"movedto,omitempty"`
	Minutes    int         `json:"minutes,omitempty"`
	Updated    bool        `json:"updated,omitempty"`
	Overridden []string    `json:"overridden,omitempty"`
	StartedAt  int64       `json:"startedat"`
	EndedAt    int64       `json:"endedat,omitempty"`
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
	Body   string `json:"body"`
	Author struct {
		Login string `json:"login"`
	} `json:"author"`
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
	// What GitHub said of the repositories' merge methods and of their base branches' rules, for the session.
	repoMethods map[string]repoMethods
	branchRules map[string]branchRules
	// reviewer: the developer's first name for the PR body's "Reviewed by" line (#847); nil writes no line.
	reviewer func(dir string) string
	// greenOnly: the review:validategreenonly setting (#912); nil reads off.
	greenOnly func() bool
}

func MakeMerger(store *Store, gh GhRunner, publish func(k PrKey, state State)) *Merger {
	return &Merger{
		gh:          gh,
		store:       store,
		publish:     publish,
		now:         time.Now,
		pollEvery:   defaultPollEvery,
		ciTimeout:   defaultCiTimeout,
		sleep:       sleepCtx,
		plans:       map[PrKey]MergePlan{},
		running:     map[PrKey]*runningMerge{},
		done:        map[PrKey]chan struct{}{},
		repoMethods: map[string]repoMethods{},
		branchRules: map[string]branchRules{},
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
	return molten.MaskGitHubTokens(text)
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
		return nil, noGhError()
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

// listNames is for the log only; the sheet lists the names itself.
func listNames(names []string) string {
	const shown = 3
	if len(names) <= shown {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:shown], ", ") + fmt.Sprintf(" and %d more", len(names)-shown)
}

func ciCheck(ci mission.ReviewCi) MergeCheck {
	check := MergeCheck{Id: CheckIdCi}
	local := 0
	for _, c := range ci.Checks {
		if c.Local {
			local++
		}
	}
	switch ci.State {
	case mission.ReviewCheckFailure:
		check.State, check.Code, check.Count = CheckFail, CheckCodeFailing, ci.Failure
		check.Names = namesIn(ci.Checks, mission.ReviewCheckFailure)
	case mission.ReviewCheckPending:
		check.State, check.Code, check.Count = CheckPending, CheckCodeRunning, ci.Pending
		check.Names = namesIn(ci.Checks, mission.ReviewCheckPending)
	case mission.ReviewCheckNone:
		check.State, check.Code = CheckOk, CheckCodeNoCheck
	default:
		check.State, check.Code, check.Count, check.Local = CheckOk, CheckCodePassed, ci.Success, local
	}
	return check
}

// evaluate turns a fresh read of the PR and the store into the plan's checks (AC1, AC4). Fails and pendings block the
// merge; warnings need the developer's confirmation.
func evaluate(pr ghMergePr, ci mission.ReviewCi, unpublished int, restart *Round) []MergeCheck {
	var checks []MergeCheck
	open := MergeCheck{Id: CheckIdOpen, State: CheckOk}
	switch {
	case !strings.EqualFold(pr.State, "OPEN"):
		open.State, open.Code, open.PrState = CheckFail, CheckCodeNotOpen, strings.ToLower(pr.State)
	case pr.IsDraft:
		open.State, open.Code = CheckFail, CheckCodeDraft
	}
	mergeState := strings.ToUpper(pr.MergeStateStatus)
	ciRow := ciCheck(ci)
	if ciRow.Code == CheckCodeFailing && mergeState != "BLOCKED" {
		// GitHub's mergeStateStatus is the judge of what it requires (#943): red checks it does not block on (UNSTABLE)
		// are not required, so they ask for a confirmation instead of refusing what GitHub would merge.
		ciRow.State, ciRow.Code = CheckWarn, CheckCodeFailingOptional
	}
	checks = append(checks, open, ciRow)
	conflict := MergeCheck{Id: CheckIdConflict, State: CheckOk, Base: pr.BaseRefName}
	switch mission.ReviewConflictOf(pr.Mergeable, pr.MergeStateStatus) {
	case mission.ReviewConflictConflicting:
		conflict.State, conflict.Code = CheckFail, CheckCodeConflicting
	case mission.ReviewConflictComputing:
		conflict.State, conflict.Code = CheckPending, CheckCodeComputing
	}
	checks = append(checks, conflict)
	blocked := MergeCheck{Id: CheckIdBlocked, State: CheckOk}
	switch {
	case mergeState != "BLOCKED":
	case ciRow.State == CheckPending || ciRow.State == CheckFail:
		// GitHub says BLOCKED until the required checks pass (#925): the CI row carries the verdict, running or
		// failed, and the rules' row waits for it instead of counting a second failure.
		blocked.State, blocked.Code = CheckPending, CheckCodeWaitsCi
	default:
		blocked.State, blocked.Code = CheckFail, CheckCodeBlocked
	}
	checks = append(checks, blocked)
	if mergeState == "BEHIND" {
		checks = append(checks, MergeCheck{Id: CheckIdBehind, State: CheckInfo, Code: CheckCodeBehind, Base: pr.BaseRefName})
	}
	comments := MergeCheck{Id: CheckIdComments, State: CheckOk}
	if unpublished > 0 {
		comments.State, comments.Code, comments.Count = CheckWarn, CheckCodeUnpublished, unpublished
	}
	checks = append(checks, comments)
	restartCheck := MergeCheck{Id: CheckIdRestart, State: CheckOk}
	if restart != nil {
		restartCheck.State, restartCheck.Code = CheckWarn, CheckCodeInFlight
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

func blockingOf(checks []MergeCheck) *MergeCheck {
	for _, c := range checks {
		if c.State == CheckFail || c.State == CheckPending {
			return &c
		}
	}
	return nil
}

// checkCodeWaitsCi: GitHub blocks the merge only because the required checks still run (#925).
const checkCodeWaitsCi = "waitsci"

// queueable: no check fails and what waits is the CI, or GitHub's block while it runs (#925). Such a PR can be
// validated now: the merge queue merges it once green (FR-REV-026).
func queueable(checks []MergeCheck) bool {
	pending := false
	for _, c := range checks {
		switch c.State {
		case CheckFail:
			return false
		case CheckPending:
			if c.Id != CheckIdCi && !(c.Id == CheckIdBlocked && c.Code == checkCodeWaitsCi) {
				return false
			}
			pending = true
		}
	}
	return pending
}

// redNamesOf: the red checks GitHub does not require, as the CI row names them (#943).
func redNamesOf(checks []MergeCheck) []string {
	for _, c := range checks {
		if c.Id == CheckIdCi && c.Code == CheckCodeFailingOptional {
			return c.Names
		}
	}
	return nil
}

// newRed: the red checks not among the ones the developer confirmed (#943).
func newRed(red []string, confirmed []string) []string {
	known := map[string]bool{}
	for _, n := range confirmed {
		known[n] = true
	}
	var rtn []string
	for _, n := range red {
		if !known[n] {
			rtn = append(rtn, n)
		}
	}
	return rtn
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
		if uimsg.TextOf(err) == nil {
			err = uimsg.Errorf(uimsg.Make("review.readpr", "detail", err.Error()), "%w", err)
		}
		return pr, mission.ReviewCi{}, 0, State{}, err
	}
	ci, err := mission.ParseReviewChecks(pr.StatusCheckRollup)
	if err != nil {
		return pr, ci, 0, State{}, uimsg.Errorf(uimsg.Make("review.checks", "detail", uimsg.Detail(err)), "the checks could not be read: %v", err)
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
	blocking := blockingOf(checks)
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
		CanMerge:   blocking == nil,
		Warnings:   warningsOf(checks),
		CreatedAt:  m.now().UnixMilli(),
		ciNames:    checkNames(ci.Checks),
		redNames:   redNamesOf(checks),
	}
	if blocking != nil {
		plan.Blocking = blocking.Id
	}
	if queueable(checks) {
		plan.GreenOnly = m.greenOnly != nil && m.greenOnly()
		plan.CanQueue = !plan.GreenOnly
	}
	methods := m.planMethods(ctx, req.Dir, req.Repo, pr.BaseRefName)
	plan.Methods, plan.Method, plan.MethodRule, plan.Queue = methods.methods, methods.method, methods.rule, methods.queue
	plan.MethodRefused = methods.refused
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
	// A merge queue brings the branch up to date itself.
	if plan.Behind && !plan.Queue {
		steps = append(steps, MergeStep{Id: StepUpdate}, MergeStep{Id: StepWaitCi})
	}
	return append(steps, MergeStep{Id: StepMerge})
}

func (p MergePlan) mergedPr(head string, merged string) MergedPr {
	if head == "" {
		head = p.HeadOid
	}
	pr := MergedPr{Dir: p.Dir, Repo: p.Repo, Number: p.Number, Ticket: p.Ticket, Url: p.Url, HeadRef: p.HeadRef, BaseRef: p.BaseRef, HeadOid: head, MergedOid: merged, BatchPrs: p.batch}
	for _, step := range p.Cleanup {
		if step.Id == CleanupStepAgentTree && step.Code == CleanupCodeWillRemove {
			pr.AgentTree = step.Path
		}
	}
	return pr
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
		return MergePlan{}, nil, nil, mergeError(MergeErrRunning)
	}
	plan, ok := m.plans[k]
	if !ok || plan.Id != req.PlanId {
		return MergePlan{}, nil, nil, mergeError(MergeErrStale)
	}
	if m.now().Sub(time.UnixMilli(plan.CreatedAt)) > planMaxAge {
		delete(m.plans, k)
		return MergePlan{}, nil, nil, mergeError(MergeErrOld)
	}
	if !plan.CanMerge {
		return MergePlan{}, nil, nil, mergeError(MergeErrBlocked)
	}
	if len(plan.Warnings) > 0 && !req.Override {
		return MergePlan{}, nil, nil, mergeError(MergeErrConfirm)
	}
	if req.Method != "" && !hasMethod(plan.Methods, req.Method) {
		return MergePlan{}, nil, nil, mergeError(MergeErrMethod)
	}
	if req.Method != "" {
		plan.Method = req.Method
	}
	plan.batch = req.Batch
	delete(m.plans, k)
	run := &runningMerge{planId: plan.Id}
	done := make(chan struct{})
	m.running[k] = run
	m.done[k] = done
	return plan, run, done, nil
}

// takeQueuePlan hands a plan to the merge queue (FR-REV-026): the developer validated it while the CI runs, so it is
// bound to its head, its method and the warnings they confirmed; the queue merges it once green. Used once, like any
// plan.
func (m *Merger) takeQueuePlan(req MergeRequest) (MergePlan, error) {
	m.lock.Lock()
	defer m.lock.Unlock()
	k := req.PrKey
	if m.running[k] != nil {
		return MergePlan{}, mergeError(MergeErrRunning)
	}
	plan, ok := m.plans[k]
	if !ok || plan.Id != req.PlanId {
		return MergePlan{}, mergeError(MergeErrStale)
	}
	if m.now().Sub(time.UnixMilli(plan.CreatedAt)) > planMaxAge {
		delete(m.plans, k)
		return MergePlan{}, mergeError(MergeErrOld)
	}
	if !plan.CanQueue && !plan.CanMerge {
		return MergePlan{}, mergeError(MergeErrBlocked)
	}
	if len(plan.Warnings) > 0 && !req.Override {
		return MergePlan{}, mergeError(MergeErrConfirm)
	}
	if req.Method != "" && !hasMethod(plan.Methods, req.Method) {
		return MergePlan{}, mergeError(MergeErrMethod)
	}
	if req.Method != "" {
		plan.Method = req.Method
	}
	delete(m.plans, k)
	return plan, nil
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
	record := MergeRecord{PlanId: plan.Id, Method: plan.Method, PlanHead: plan.HeadOid, Head: plan.HeadOid, State: MergeChecking, StartedAt: m.now().UnixMilli()}
	if req.Override {
		record.Overridden = plan.Warnings
	}
	// The developer's choice is the repository's next default, whatever GitHub then answers.
	m.keepChosenMethod(plan.Repo, plan.Method, plan.Queue)
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
		return mergeError(MergeErrNotFound)
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

// end records the outcome: its state, why it was refused, and the code the sheet writes it from. The record's data
// (Blocking, Names, MovedFrom, ...) are set by the caller; err is the raw error, if any.
func (m *Merger) end(k PrKey, record MergeRecord, state string, refused string, code string, err error) MergeRecord {
	record.State = state
	record.Refused = refused
	record.Code = code
	if err != nil {
		record.Error = maskTokens(err.Error())
	}
	m.record(k, record)
	log.Printf("%s %s#%d merge %s: %s %s\n", logPrefix, k.Repo, k.Number, state, code, record.Error)
	return record
}

func headMoved(record MergeRecord, head string, expected string) MergeRecord {
	record.MovedFrom = expected
	record.MovedTo = head
	return record
}

func (m *Merger) run(ctx context.Context, plan MergePlan, record MergeRecord) {
	k := PrKey{Repo: plan.Repo, Number: plan.Number}
	pr, ci, unpublished, state, err := m.inputs(ctx, plan.Dir, k)
	if err != nil {
		m.end(k, record, MergeFailed, "", MergeCodeReread, err)
		return
	}
	if strings.EqualFold(pr.State, "MERGED") {
		m.end(k, record, MergeRefused, RefusedMergedAway, MergeCodeMergedAway, nil)
		return
	}
	if pr.HeadRefOid != plan.HeadOid {
		m.end(k, headMoved(record, pr.HeadRefOid, plan.HeadOid), MergeRefused, RefusedHeadMoved, MergeCodeHeadMoved, nil)
		return
	}
	checks := evaluate(pr, ci, unpublished, restartInFlight(state, pr.HeadRefOid))
	if blocking := blockingOf(checks); blocking != nil {
		record.Blocking = blocking
		m.end(k, record, MergeRefused, RefusedCheck, MergeCodeCheck, nil)
		return
	}
	if !record.overrides(warningsOf(checks)) {
		m.end(k, record, MergeRefused, RefusedCheck, MergeCodeNewWarning, nil)
		return
	}
	if red := newRed(redNamesOf(checks), plan.redNames); len(red) > 0 {
		record.Names = red
		m.end(k, record, MergeRefused, RefusedCheck, MergeCodeNewRed, nil)
		return
	}
	head := plan.HeadOid
	if strings.EqualFold(pr.MergeStateStatus, "BEHIND") && !plan.Queue {
		var ok bool
		head, record, ok = m.updateAndWait(ctx, plan, record)
		if !ok {
			return
		}
	}
	m.signReview(ctx, plan, pr, state)
	record.State = MergeMerging
	record.Head = head
	m.record(k, record)
	_, err = m.runGh(ctx, plan.Dir, plan.Repo, mergeArgs(strconv.Itoa(plan.Number), record.Method, plan.Queue, head)...)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "head branch was modified") {
			m.end(k, record, MergeRefused, RefusedHeadMoved, MergeCodeGithubMoved, err)
			return
		}
		m.forgetMethods(plan.Repo)
		if methodRefusedError(err) {
			m.end(k, record, MergeFailed, "", MergeCodeMethodRefused, err)
			return
		}
		m.end(k, record, MergeFailed, "", MergeCodeMergeError, err)
		return
	}
	after, err := m.viewPr(ctx, plan.Dir, k)
	if err == nil && strings.EqualFold(after.State, "OPEN") {
		// A merge queue (one the plan saw, or a branch protection's) took the PR: GitHub merges it later.
		var ok bool
		after, record, ok = m.waitQueue(ctx, plan, record, head)
		if !ok {
			return
		}
	}
	if err == nil && after.MergeCommit != nil {
		record.MergedOid = after.MergeCommit.Oid
	}
	record.CleanupRunning = true
	record = m.end(k, record, MergeMerged, "", MergeCodeMerged, nil)
	m.cleanup(plan, record, head)
}

// lastReviewUrl: the newest review MoltenTerm published on GitHub for the PR.
func lastReviewUrl(state State) string {
	for i := len(state.Rounds) - 1; i >= 0; i-- {
		if url := state.Rounds[i].GithubUrl; url != "" {
			return url
		}
	}
	if state.Publish != nil {
		return state.Publish.Url
	}
	return ""
}

// signReview writes "Reviewed by <first name> · <date>" in the PR body's signature block (#847) once the developer
// confirmed the merge: GitHub does not let the PR's author, the developer's own account, approve it. The line is best
// effort: a failure is logged and never stops the merge. Editing the body moves no commit, so --match-head-commit holds.
func (m *Merger) signReview(ctx context.Context, plan MergePlan, pr ghMergePr, state State) {
	if m.reviewer == nil {
		return
	}
	name := m.reviewer(plan.Dir)
	if name == "" {
		name = pr.Author.Login
	}
	if name == "" {
		return
	}
	review := agentsign.Review{Name: name, Date: m.now().Format("2006-01-02"), Url: lastReviewUrl(state)}
	body := agentsign.WithReview(pr.Body, review)
	if body == pr.Body {
		return
	}
	if _, err := m.runGh(ctx, plan.Dir, plan.Repo, "pr", "edit", strconv.Itoa(plan.Number), "--body", body); err != nil {
		log.Printf("molten review: the Reviewed by line of %s#%d could not be written: %v\n", plan.Repo, plan.Number, err)
	}
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

// updateAndWait has GitHub update the branch with its base (gh pr update-branch, --rebase for a rebase merge), then
// waits until CI passed on the new head (AC3). Another head move while waiting refuses: only GitHub's update of the
// planned head is merged.
func (m *Merger) updateAndWait(ctx context.Context, plan MergePlan, record MergeRecord) (string, MergeRecord, bool) {
	k := PrKey{Repo: plan.Repo, Number: plan.Number}
	record.State = MergeUpdating
	m.record(k, record)
	if _, err := m.runGh(ctx, plan.Dir, plan.Repo, updateBranchArgs(strconv.Itoa(plan.Number), record.Method)...); err != nil {
		m.end(k, record, MergeFailed, "", MergeCodeUpdateError, err)
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
			m.end(k, record, MergeCancelled, "", MergeCodeStopped, nil)
			return "", record, false
		}
		if m.now().After(deadline) {
			record.Minutes = int(m.ciTimeout.Minutes())
			m.end(k, record, MergeFailed, "", MergeCodeCiTimeout, nil)
			return "", record, false
		}
		pr, err := m.viewPr(ctx, plan.Dir, k)
		if err != nil {
			errors++
			if errors >= maxPollErrors {
				m.end(k, record, MergeFailed, "", MergeCodePollError, err)
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
			m.end(k, headMoved(record, pr.HeadRefOid, newHead), MergeRefused, RefusedHeadMoved, MergeCodeHeadMoved, nil)
			return "", record, false
		}
		verdict := ciOnNewHead(pr, plan.ciNames, plan.redNames)
		if !verdict.done && verdict.refused != "" {
			// Every check passed but GitHub still blocks: past a short grace, a missing review will not come by itself.
			blockedPolls++
			if blockedPolls >= maxBlockedPolls {
				m.end(k, record, MergeRefused, verdict.refused, verdict.code, nil)
				return "", record, false
			}
			continue
		}
		blockedPolls = 0
		if !verdict.done {
			continue
		}
		if verdict.outcome != "" {
			record.Names = verdict.names
			m.end(k, record, verdict.outcome, verdict.refused, verdict.code, nil)
			return "", record, false
		}
		return newHead, record, true
	}
}

// ciVerdict: done when the wait is over; outcome is set when the merge must stop, with its code.
type ciVerdict struct {
	done    bool
	outcome string
	refused string
	code    string
	names   []string
}

// ciOnNewHead tells whether the rebased head can be merged: every check the plan saw has run again and passed, and
// GitHub says it merges cleanly. The red checks the developer confirmed (#943) may fail again: GitHub still decides
// whether they block (BLOCKED waits, then refuses).
func ciOnNewHead(pr ghMergePr, planChecks []string, confirmedRed []string) ciVerdict {
	ci, err := mission.ParseReviewChecks(pr.StatusCheckRollup)
	if err != nil {
		return ciVerdict{}
	}
	if failing := newRed(namesIn(ci.Checks, mission.ReviewCheckFailure), confirmedRed); len(failing) > 0 {
		return ciVerdict{done: true, outcome: MergeFailed, code: MergeCodeCiFailed, names: failing}
	}
	mergeState := strings.ToUpper(pr.MergeStateStatus)
	if strings.EqualFold(pr.Mergeable, "CONFLICTING") || mergeState == "DIRTY" {
		return ciVerdict{done: true, outcome: MergeFailed, code: MergeCodeConflict}
	}
	present := map[string]bool{}
	for _, c := range ci.Checks {
		present[c.Name] = true
	}
	for _, name := range planChecks {
		if !present[name] {
			return ciVerdict{}
		}
	}
	if ci.Pending > 0 {
		return ciVerdict{}
	}
	switch mergeState {
	case "BEHIND":
		return ciVerdict{done: true, outcome: MergeRefused, refused: RefusedBaseMoved, code: MergeCodeBaseMoved}
	case "CLEAN", "HAS_HOOKS", "UNSTABLE":
		return ciVerdict{done: true}
	}
	if mergeState == "BLOCKED" {
		return ciVerdict{refused: RefusedCheck, code: MergeCodeRebasedBlocked}
	}
	// UNKNOWN: GitHub has not caught up with the finished checks yet.
	return ciVerdict{}
}
