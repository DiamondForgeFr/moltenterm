// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

// The Reviews view (FR-REV-001, DS-REV-001): the pull requests waiting for the developer's review, derived from the
// collector's snapshot, so the view and `molten review list` read GitHub through the collector's limits and add no
// poller of their own. A PR is ready for review when it is open, not a draft and targets the project's PR target
// branch: under the sf-workflow guard that is exactly the tickets In Review, without reading the board. The test
// reports and the tickets' titles are one extra gh call for all the listed PRs, made only while someone asks.

// must match the names in frontend/moltenterm-shell/reviews/reviews-client.ts
const (
	ReviewsCommand = "moltenmissionreviews"
	ReviewsEvent   = "molten:mission:reviews"
)

const (
	ReviewMergeClean     = "clean"
	ReviewMergeBehind    = "behind"
	ReviewMergeConflicts = "conflicts"
	ReviewMergeBlocked   = "blocked"
	ReviewMergeFailing   = "failing"
	ReviewMergeUnknown   = "unknown"

	// What GitHub's mergeability says of a conflict with the base, for the review list and the Validate plan alike.
	ReviewConflictNone        = ""
	ReviewConflictConflicting = "conflicting"
	ReviewConflictComputing   = "computing"

	ReviewReportPresent = "present"
	ReviewReportMissing = "missing"
	ReviewReportUnknown = "unknown"

	ReviewCheckSuccess = "success"
	ReviewCheckFailure = "failure"
	ReviewCheckPending = "pending"
	ReviewCheckNeutral = "neutral"
	ReviewCheckNone    = "none"

	ReviewTicketFromClosing = "closing"
	ReviewTicketFromBranch  = "branch"

	ReviewTargetFromSaaSFoundry = ".saasfoundry.json workflow.prTargetBranch"
	ReviewTargetFromTrunk       = "the trunk"
)

const (
	// NFR-REV-002: the reports are read again at most once a minute per project while the PRs stay the same, and at
	// most every 10 s whatever happens (a forced refresh, a new PR).
	reviewReportsMaxAge      = time.Minute
	reviewReportsMinInterval = minForcedInterval
	reviewReportsTimeout     = 45 * time.Second
	// The last comments of a PR and of its ticket where a test report is looked for.
	reviewCommentsRead = 15
	// The PRs whose reports one query reads; past it, the oldest updated show their report as unknown.
	maxReviewReportPrs = 30
)

var reviewFailureWords = []string{"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
var reviewPendingWords = []string{"PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"}

// A branch named after its ticket without a declared pattern: feature/579-reviews-view, fix/12.
var defaultTicketBranchRe = regexp.MustCompile(`^[A-Za-z]+/(\d+)(?:[-_]|$)`)
var testReportHeadingRe = regexp.MustCompile(`(?i)\btest report\b`)

type ReviewsRequest struct {
	Dir   string `json:"dir"`
	Force bool   `json:"force,omitempty"`
	// Passive: the rail's counts (#688), read through Collector.WarmReviews; never starts the reports query.
	Passive bool `json:"passive,omitempty"`
}

type ReviewCheck struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Local bool   `json:"local,omitempty"`
}

type ReviewCi struct {
	State   string        `json:"state"`
	Success int           `json:"success"`
	Failure int           `json:"failure"`
	Pending int           `json:"pending"`
	Checks  []ReviewCheck `json:"checks"`
}

type ReviewReport struct {
	State string `json:"state"`
	Url   string `json:"url,omitempty"`
	// Where it was found: "pr" or "ticket".
	Where string `json:"where,omitempty"`
}

type ReviewPr struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
	// The head commit and the base branch's tip as GitHub has them (the Review tab's diff, FR-REV-002).
	HeadOid     string `json:"headoid,omitempty"`
	BaseOid     string `json:"baseoid,omitempty"`
	Author      string `json:"author,omitempty"`
	Draft       bool   `json:"draft,omitempty"`
	CreatedAt   string `json:"createdat"`
	UpdatedAt   string `json:"updatedat"`
	Ticket      int    `json:"ticket,omitempty"`
	TicketFrom  string `json:"ticketfrom,omitempty"`
	TicketTitle string `json:"tickettitle,omitempty"`
	TicketUrl   string `json:"ticketurl,omitempty"`
	// GitHub's mergeable and mergeStateStatus as read, and what the review makes of them (ReviewMerge…).
	Mergeable  string       `json:"mergeable,omitempty"`
	MergeState string       `json:"mergestate,omitempty"`
	Merge      string       `json:"merge"`
	Ci         ReviewCi     `json:"ci"`
	Report     ReviewReport `json:"report"`
	// Comments written in MoltenTerm and not published yet; the review store (DS-REV-007) fills it.
	Unpublished int `json:"unpublished"`
}

type ReviewsAnswer struct {
	Dir     string `json:"dir"`
	Missing bool   `json:"missing,omitempty"`
	// The GitHub state of the collector (GithubState…); empty until GitHub was read once.
	State   string `json:"state,omitempty"`
	Message string `json:"message,omitempty"`
	Repo    string `json:"repo,omitempty"`
	Url     string `json:"url,omitempty"`
	// The branch the listed PRs target, and where its name was read.
	Target     string     `json:"target,omitempty"`
	TargetFrom string     `json:"targetfrom,omitempty"`
	Ready      []ReviewPr `json:"ready"`
	Drafts     []ReviewPr `json:"drafts"`
	// The pull requests could not be read (the collector's prs section).
	PrsError     string `json:"prserror,omitempty"`
	GithubAt     int64  `json:"githubat,omitempty"`
	Refreshing   bool   `json:"refreshing,omitempty"`
	ReportsAt    int64  `json:"reportsat,omitempty"`
	ReportsError string `json:"reportserror,omitempty"`
}

type ghReviewRollup struct {
	Name       string `json:"name"`
	Context    string `json:"context"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	State      string `json:"state"`
}

type ghReviewPr struct {
	Number            int    `json:"number"`
	Title             string `json:"title"`
	Url               string `json:"url"`
	HeadRefName       string `json:"headRefName"`
	BaseRefName       string `json:"baseRefName"`
	HeadRefOid        string `json:"headRefOid"`
	BaseRefOid        string `json:"baseRefOid"`
	IsDraft           bool   `json:"isDraft"`
	IsCrossRepository bool   `json:"isCrossRepository"`
	CreatedAt         string `json:"createdAt"`
	UpdatedAt         string `json:"updatedAt"`
	Mergeable         string `json:"mergeable"`
	MergeStateStatus  string `json:"mergeStateStatus"`
	Author            struct {
		Login string `json:"login"`
	} `json:"author"`
	StatusCheckRollup       []ghReviewRollup `json:"statusCheckRollup"`
	ClosingIssuesReferences []struct {
		Number int `json:"number"`
	} `json:"closingIssuesReferences"`
}

func reviewCheckState(entry ghReviewRollup) string {
	if entry.Status != "" && !strings.EqualFold(entry.Status, "COMPLETED") {
		return ReviewCheckPending
	}
	word := strings.ToUpper(entry.Conclusion)
	if word == "" {
		word = strings.ToUpper(entry.State)
	}
	switch {
	case word == "SUCCESS":
		return ReviewCheckSuccess
	case containsWord(reviewFailureWords, word):
		return ReviewCheckFailure
	case containsWord(reviewPendingWords, word):
		return ReviewCheckPending
	}
	return ReviewCheckNeutral
}

func containsWord(words []string, word string) bool {
	for _, w := range words {
		if w == word {
			return true
		}
	}
	return false
}

// SummarizeReviewChecks folds a PR's checks the way the CI remote tab does (summarizeChecks in github.ts): GitHub's
// jobs and the local-* statuses, each name once (the latest wins), GitHub's first.
func SummarizeReviewChecks(rollup []ghReviewRollup) ReviewCi {
	byName := map[string]ReviewCheck{}
	for _, entry := range rollup {
		name := entry.Name
		if name == "" {
			name = entry.Context
		}
		if name == "" {
			continue
		}
		byName[name] = ReviewCheck{Name: name, State: reviewCheckState(entry), Local: strings.HasPrefix(name, "local-")}
	}
	ci := ReviewCi{State: ReviewCheckNone, Checks: []ReviewCheck{}}
	for _, check := range byName {
		ci.Checks = append(ci.Checks, check)
		switch check.State {
		case ReviewCheckSuccess:
			ci.Success++
		case ReviewCheckFailure:
			ci.Failure++
		case ReviewCheckPending:
			ci.Pending++
		}
	}
	sort.Slice(ci.Checks, func(i, j int) bool {
		a, b := ci.Checks[i], ci.Checks[j]
		if a.Local != b.Local {
			return !a.Local
		}
		return a.Name < b.Name
	})
	switch {
	case ci.Failure > 0:
		ci.State = ReviewCheckFailure
	case ci.Pending > 0:
		ci.State = ReviewCheckPending
	case ci.Success > 0:
		ci.State = ReviewCheckSuccess
	case len(ci.Checks) > 0:
		ci.State = ReviewCheckNeutral
	}
	return ci
}

// ParseReviewChecks folds a statusCheckRollup as gh prints it (gh pr view --json statusCheckRollup), for the merge plan
// of the Review tab (FR-REV-012).
func ParseReviewChecks(raw json.RawMessage) (ReviewCi, error) {
	var rollup []ghReviewRollup
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &rollup); err != nil {
			return ReviewCi{State: ReviewCheckNone, Checks: []ReviewCheck{}}, err
		}
	}
	return SummarizeReviewChecks(rollup), nil
}

// ReviewMergeOf names GitHub's mergeStateStatus in the review's words (FR-REV-001-AC2).
func ReviewMergeOf(mergeState string) string {
	switch strings.ToUpper(mergeState) {
	case "CLEAN", "HAS_HOOKS":
		return ReviewMergeClean
	case "BEHIND":
		return ReviewMergeBehind
	case "DIRTY":
		return ReviewMergeConflicts
	case "BLOCKED":
		return ReviewMergeBlocked
	case "UNSTABLE":
		return ReviewMergeFailing
	}
	return ReviewMergeUnknown
}

// ReviewConflictOf reads a conflict with the base from GitHub's mergeable and mergeStateStatus (gh's words). GitHub
// computes mergeable lazily after a push to the head or the base: UNKNOWN means it is still computing.
func ReviewConflictOf(mergeable string, mergeState string) string {
	state := strings.ToUpper(mergeState)
	switch {
	case strings.EqualFold(mergeable, "CONFLICTING") || state == "DIRTY":
		return ReviewConflictConflicting
	case strings.EqualFold(mergeable, "UNKNOWN") || state == "UNKNOWN" || state == "":
		return ReviewConflictComputing
	}
	return ReviewConflictNone
}

// ReviewMergeOfPr is a row's merge state (#683): the conflict as the Validate plan reads it first, so the row and the
// plan agree, then mergeStateStatus. A draft has no merge state of its own; mergeable still tells it is clean.
func ReviewMergeOfPr(mergeable string, mergeState string) string {
	switch ReviewConflictOf(mergeable, mergeState) {
	case ReviewConflictConflicting:
		return ReviewMergeConflicts
	case ReviewConflictComputing:
		return ReviewMergeUnknown
	}
	if strings.EqualFold(mergeState, "DRAFT") && strings.EqualFold(mergeable, "MERGEABLE") {
		return ReviewMergeClean
	}
	return ReviewMergeOf(mergeState)
}

var branchPatternFieldRe = regexp.MustCompile(`\\\{([A-Za-z]+)\\\}`)

// branchTicketRes turns the project's branch patterns (`feature/{N}-{description}`) into expressions that read the
// ticket back; the default one comes last.
func branchTicketRes(patterns map[string]string) []*regexp.Regexp {
	keys := make([]string, 0, len(patterns))
	for key := range patterns {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var rtn []*regexp.Regexp
	for _, key := range keys {
		pattern := patterns[key]
		if !strings.Contains(pattern, "{N}") {
			continue
		}
		expr := branchPatternFieldRe.ReplaceAllStringFunc(regexp.QuoteMeta(pattern), func(field string) string {
			switch field {
			case `\{N\}`:
				return `(\d+)`
			case `\{description\}`:
				return `.*`
			}
			return `[^/]*`
		})
		if re, err := regexp.Compile("^" + expr + "$"); err == nil {
			rtn = append(rtn, re)
		}
	}
	return append(rtn, defaultTicketBranchRe)
}

func ticketOfBranch(branch string, res []*regexp.Regexp) int {
	for _, re := range res {
		match := re.FindStringSubmatch(branch)
		if len(match) < 2 {
			continue
		}
		var n int
		if _, err := fmt.Sscanf(match[1], "%d", &n); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

// TicketOfBranch is the ticket a PR's head branch names (the project's branchNaming patterns, else type/N-...), 0
// when it names none.
func TicketOfBranch(dir string, branch string) int {
	return ticketOfBranch(branch, branchTicketRes(readBranchNaming(dir)))
}

// ReviewRollup is one entry of a PR's statusCheckRollup as gh returns it.
type ReviewRollup = ghReviewRollup

func readBranchNaming(dir string) map[string]string {
	var sf struct {
		Workflow struct {
			BranchNaming map[string]string `json:"branchNaming"`
		} `json:"workflow"`
	}
	data, err := os.ReadFile(filepath.Join(dir, molten.ProjectSaaSFoundryFile))
	if err != nil || json.Unmarshal(data, &sf) != nil {
		return nil
	}
	return sf.Workflow.BranchNaming
}

// reviewTarget is the branch the reviewed PRs target: the declared PR target branch, else the trunk the collector
// resolved, else the configured one.
func reviewTarget(snap Snapshot) (string, string) {
	if target := molten.PrTargetBranch(snap.Dir); target != "" {
		return target, ReviewTargetFromSaaSFoundry
	}
	if snap.Git != nil && snap.Git.Trunk != "" {
		return snap.Git.Trunk, ReviewTargetFromTrunk
	}
	return molten.ResolvedBranches(snap.Dir).Trunk, ReviewTargetFromTrunk
}

func makeReviewPr(pr ghReviewPr, ticketRes []*regexp.Regexp) ReviewPr {
	rtn := ReviewPr{
		Number:     pr.Number,
		Title:      pr.Title,
		Url:        pr.Url,
		Branch:     pr.HeadRefName,
		Base:       pr.BaseRefName,
		HeadOid:    pr.HeadRefOid,
		BaseOid:    pr.BaseRefOid,
		Author:     pr.Author.Login,
		Draft:      pr.IsDraft,
		CreatedAt:  pr.CreatedAt,
		UpdatedAt:  pr.UpdatedAt,
		Mergeable:  pr.Mergeable,
		MergeState: pr.MergeStateStatus,
		Merge:      ReviewMergeOfPr(pr.Mergeable, pr.MergeStateStatus),
		Ci:         SummarizeReviewChecks(pr.StatusCheckRollup),
		Report:     ReviewReport{State: ReviewReportUnknown},
	}
	for _, ref := range pr.ClosingIssuesReferences {
		if ref.Number > 0 {
			rtn.Ticket, rtn.TicketFrom = ref.Number, ReviewTicketFromClosing
			break
		}
	}
	if rtn.Ticket == 0 {
		if n := ticketOfBranch(pr.HeadRefName, ticketRes); n > 0 {
			rtn.Ticket, rtn.TicketFrom = n, ReviewTicketFromBranch
		}
	}
	return rtn
}

// BuildReviews derives the review list from a collector snapshot (DS-REV-001): open PRs of the repository itself
// whose base is the target branch, newest update first, drafts apart. Reports stay unknown here.
func BuildReviews(snap Snapshot) ReviewsAnswer {
	answer := ReviewsAnswer{Dir: snap.Dir, Missing: snap.Missing, Ready: []ReviewPr{}, Drafts: []ReviewPr{}, GithubAt: snap.GithubAt, Refreshing: snap.Refreshing}
	answer.Target, answer.TargetFrom = reviewTarget(snap)
	gh := snap.Github
	if gh == nil {
		return answer
	}
	answer.State, answer.Message, answer.Repo, answer.Url = gh.State, gh.Message, gh.Repo, gh.Url
	answer.PrsError = gh.Errors["prs"]
	var prs []ghReviewPr
	if len(gh.Prs) > 0 {
		if err := json.Unmarshal(gh.Prs, &prs); err != nil {
			answer.PrsError = "the pull requests could not be read: " + err.Error()
			return answer
		}
	}
	ticketRes := branchTicketRes(readBranchNaming(snap.Dir))
	for _, pr := range prs {
		if pr.IsCrossRepository || pr.BaseRefName != answer.Target {
			continue
		}
		row := makeReviewPr(pr, ticketRes)
		if row.Draft {
			answer.Drafts = append(answer.Drafts, row)
		} else {
			answer.Ready = append(answer.Ready, row)
		}
	}
	newestFirst := func(list []ReviewPr) {
		sort.SliceStable(list, func(i, j int) bool { return list[i].UpdatedAt > list[j].UpdatedAt })
	}
	newestFirst(answer.Ready)
	newestFirst(answer.Drafts)
	return answer
}

type reviewReportsState struct {
	key      string
	at       time.Time
	askedAt  time.Time
	running  bool
	again    bool
	reports  map[int]ReviewReport
	tickets  map[int]reviewTicket
	err      string
	usedAt   time.Time
	repoRef  string
	queryFor []ReviewPr
}

type reviewTicket struct {
	Title string
	Url   string
}

type Reviews struct {
	lock      sync.Mutex
	collector *Collector
	run       Runner
	now       func() time.Time
	publish   func(ReviewsAnswer)
	reports   map[string]*reviewReportsState
	// The upcoming work and the agents on each branch (#712), made on the first ask.
	upcoming *Upcoming
}

func MakeReviews(collector *Collector, run Runner, publish func(ReviewsAnswer)) *Reviews {
	return &Reviews{collector: collector, run: run, now: time.Now, publish: publish, reports: map[string]*reviewReportsState{}}
}

func publishReviews(answer ReviewsAnswer) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  ReviewsEvent,
		Scopes: []string{answer.Dir},
		Data:   answer,
	})
}

// reviewReportPrs are the PRs one query reads: the ready ones first, then the drafts.
func reviewReportPrs(answer ReviewsAnswer) []ReviewPr {
	prs := append(append([]ReviewPr{}, answer.Ready...), answer.Drafts...)
	if len(prs) > maxReviewReportPrs {
		prs = prs[:maxReviewReportPrs]
	}
	return prs
}

// reviewReportsKey changes when a listed PR is added, removed or updated (a new comment updates it).
func reviewReportsKey(repoRef string, prs []ReviewPr) string {
	parts := make([]string, 0, len(prs)+1)
	parts = append(parts, repoRef)
	for _, pr := range prs {
		parts = append(parts, fmt.Sprintf("%d@%s#%d", pr.Number, pr.UpdatedAt, pr.Ticket))
	}
	sort.Strings(parts[1:])
	return strings.Join(parts, ",")
}

// Get answers with the review list (FR-REV-001): the collector's snapshot as it is (asking it starts a refresh within
// its limits) with the reports known so far; a reports query that is due runs in the background and its result comes
// as a ReviewsEvent.
func (r *Reviews) Get(req ReviewsRequest) (ReviewsAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return ReviewsAnswer{}, err
	}
	dir := filepath.Clean(req.Dir)
	if req.Passive {
		snap, err := r.collector.WarmReviews(dir)
		if err != nil {
			return ReviewsAnswer{}, err
		}
		answer := BuildReviews(snap)
		r.applyKnownReports(&answer)
		return answer, nil
	}
	maxAge := DefaultMaxAgeSec * time.Second
	if req.Force {
		maxAge = 0
	}
	snap, err := r.collector.Get(dir, maxAge, req.Force)
	if err != nil {
		return ReviewsAnswer{}, err
	}
	answer := BuildReviews(snap)
	if start := r.prepareReports(&answer, req.Force); start {
		go r.readReports(dir)
	}
	return answer, nil
}

func (r *Reviews) applyKnownReports(answer *ReviewsAnswer) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.applyLocked(answer, r.reports[answer.Dir])
}

// prepareReports fills the answer with the reports known and says whether a query starts now.
func (r *Reviews) prepareReports(answer *ReviewsAnswer, force bool) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	if answer.State != GithubStateOk || answer.Repo == "" {
		r.applyLocked(answer, r.reports[answer.Dir])
		return false
	}
	state := r.reports[answer.Dir]
	if state == nil {
		if len(r.reports) >= maxProjects {
			r.evictLocked()
		}
		state = &reviewReportsState{}
		r.reports[answer.Dir] = state
	}
	now := r.now()
	state.usedAt = now
	r.applyLocked(answer, state)
	prs := reviewReportPrs(*answer)
	repoRef := ghRepoRef(answer.Repo, answer.Url)
	key := reviewReportsKey(repoRef, prs)
	if len(prs) == 0 {
		state.key, state.at, state.err = key, now, ""
		state.reports, state.tickets = nil, nil
		return false
	}
	if state.running {
		state.again = state.again || key != state.key || force
		return false
	}
	sinceAsked := now.Sub(state.askedAt)
	due := key != state.key || now.Sub(state.at) >= reviewReportsMaxAge || force
	if !due || sinceAsked < reviewReportsMinInterval {
		return false
	}
	state.running = true
	state.askedAt = now
	state.key = key
	state.repoRef = repoRef
	state.queryFor = prs
	return true
}

func (r *Reviews) evictLocked() {
	var oldest string
	var oldestAt time.Time
	for dir, state := range r.reports {
		if state.running {
			continue
		}
		if oldest == "" || state.usedAt.Before(oldestAt) {
			oldest, oldestAt = dir, state.usedAt
		}
	}
	if oldest != "" {
		delete(r.reports, oldest)
	}
}

func (r *Reviews) applyLocked(answer *ReviewsAnswer, state *reviewReportsState) {
	if state == nil {
		return
	}
	if !state.at.IsZero() {
		answer.ReportsAt = state.at.UnixMilli()
	}
	answer.ReportsError = state.err
	fill := func(list []ReviewPr) {
		for i := range list {
			pr := &list[i]
			if report, ok := state.reports[pr.Number]; ok {
				pr.Report = report
			}
			if ticket, ok := state.tickets[pr.Ticket]; ok && pr.Ticket > 0 {
				pr.TicketTitle, pr.TicketUrl = ticket.Title, ticket.Url
			}
		}
	}
	fill(answer.Ready)
	fill(answer.Drafts)
}

func (r *Reviews) takeQuery(dir string) (string, []ReviewPr) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.reports[dir]
	if state == nil {
		return "", nil
	}
	return state.repoRef, state.queryFor
}

func (r *Reviews) readReports(dir string) {
	defer func() {
		if rec := recover(); rec != nil {
			panichandler.PanicHandler("molten:mission:reviews", rec)
			r.storeReports(dir, nil, nil, "the test reports could not be read")
		}
	}()
	repoRef, prs := r.takeQuery(dir)
	ctx, cancel := context.WithTimeout(context.Background(), reviewReportsTimeout)
	defer cancel()
	reports, tickets, err := ReadReviewReports(ctx, r.run, dir, repoRef, prs)
	msg := ""
	if err != nil {
		msg = err.Error()
		log.Printf("molten: reading the review reports of %s: %v\n", dir, err)
	}
	again := r.storeReports(dir, reports, tickets, msg)
	if snap, ok := r.collector.Cached(dir); ok && r.publish != nil {
		r.publish(r.answerOf(snap))
	}
	if again {
		r.Get(ReviewsRequest{Dir: dir})
	}
}

func (r *Reviews) answerOf(snap Snapshot) ReviewsAnswer {
	answer := BuildReviews(snap)
	r.lock.Lock()
	defer r.lock.Unlock()
	r.applyLocked(&answer, r.reports[snap.Dir])
	return answer
}

// storeReports keeps a query's result; true when the PRs changed while it ran, so another one follows.
func (r *Reviews) storeReports(dir string, reports map[int]ReviewReport, tickets map[int]reviewTicket, errMsg string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.reports[dir]
	if state == nil {
		return false
	}
	state.running = false
	state.at = r.now()
	state.err = errMsg
	if errMsg == "" {
		state.reports, state.tickets = reports, tickets
	}
	again := state.again
	state.again = false
	return again
}

type ghReviewComment struct {
	Body string `json:"body"`
	Url  string `json:"url"`
}

type ghReviewComments struct {
	Nodes []ghReviewComment `json:"nodes"`
}

type ghReviewNode struct {
	Title    string           `json:"title"`
	Url      string           `json:"url"`
	Comments ghReviewComments `json:"comments"`
}

// IsTestReport says whether a comment is a test report: its first markdown heading names one (the sf-workflow test
// report, "## Test report (#N)").
func IsTestReport(body string) bool {
	for _, line := range strings.Split(body, "\n") {
		text := strings.TrimSpace(line)
		if !strings.HasPrefix(text, "#") {
			continue
		}
		return testReportHeadingRe.MatchString(strings.TrimLeft(text, "# "))
	}
	return false
}

func latestTestReport(comments []ghReviewComment) (string, bool) {
	for i := len(comments) - 1; i >= 0; i-- {
		if IsTestReport(comments[i].Body) {
			return comments[i].Url, true
		}
	}
	return "", false
}

// reviewReportsQuery reads, in one GraphQL query, the last comments of each PR and of its ticket, and the ticket's
// title. Numbers are integers formatted here, never text from GitHub.
func reviewReportsQuery(prs []ReviewPr) string {
	var sb strings.Builder
	sb.WriteString("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){")
	seen := map[int]bool{}
	for _, pr := range prs {
		fmt.Fprintf(&sb, "p%d:pullRequest(number:%d){title url comments(last:%d){nodes{body url}}}", pr.Number, pr.Number, reviewCommentsRead)
		if pr.Ticket <= 0 || pr.Ticket == pr.Number || seen[pr.Ticket] {
			continue
		}
		seen[pr.Ticket] = true
		fmt.Fprintf(&sb, "t%d:issueOrPullRequest(number:%d){...on Issue{title url comments(last:%d){nodes{body url}}}}", pr.Ticket, pr.Ticket, reviewCommentsRead)
	}
	sb.WriteString("}}")
	return sb.String()
}

func shortGhError(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 {
		msg = msg[i+2:]
	}
	return "gh api graphql: " + msg
}

// ReadReviewReports asks GitHub, through the developer's gh and for the named repository only, which PRs have a test
// report (on the PR, else on its ticket) and the tickets' titles.
func ReadReviewReports(ctx context.Context, run Runner, dir string, repoRef string, prs []ReviewPr) (map[int]ReviewReport, map[int]reviewTicket, error) {
	parts := strings.Split(repoRef, "/")
	if len(parts) < 2 {
		return nil, nil, fmt.Errorf("no repository to read the test reports from")
	}
	owner, name := parts[len(parts)-2], parts[len(parts)-1]
	args := []string{"api", "graphql", "-f", "query=" + reviewReportsQuery(prs), "-f", "owner=" + owner, "-f", "name=" + name}
	if len(parts) == 3 {
		args = append(args, "--hostname", parts[0])
	}
	out, err := run(ctx, dir, "gh", args...)
	var answer struct {
		Data struct {
			Repository map[string]*ghReviewNode `json:"repository"`
		} `json:"data"`
	}
	// gh prints the data it got along with GraphQL errors (a ticket number that is not an issue): keep what came.
	if jsonErr := json.Unmarshal(out, &answer); jsonErr != nil || answer.Data.Repository == nil {
		if err != nil {
			return nil, nil, fmt.Errorf("%s", shortGhError(err))
		}
		return nil, nil, fmt.Errorf("gh api graphql: unreadable answer")
	}
	nodes := answer.Data.Repository
	reports := map[int]ReviewReport{}
	tickets := map[int]reviewTicket{}
	for _, pr := range prs {
		report := ReviewReport{State: ReviewReportMissing}
		if node := nodes[fmt.Sprintf("p%d", pr.Number)]; node != nil {
			if url, ok := latestTestReport(node.Comments.Nodes); ok {
				report = ReviewReport{State: ReviewReportPresent, Url: url, Where: "pr"}
			}
			if pr.Ticket == pr.Number {
				tickets[pr.Ticket] = reviewTicket{Title: node.Title, Url: node.Url}
			}
		} else {
			report.State = ReviewReportUnknown
		}
		if pr.Ticket > 0 && pr.Ticket != pr.Number {
			if node := nodes[fmt.Sprintf("t%d", pr.Ticket)]; node != nil {
				if node.Title != "" {
					tickets[pr.Ticket] = reviewTicket{Title: node.Title, Url: node.Url}
				}
				if report.State != ReviewReportPresent {
					if url, ok := latestTestReport(node.Comments.Nodes); ok {
						report = ReviewReport{State: ReviewReportPresent, Url: url, Where: "ticket"}
					}
				}
			}
		}
		reports[pr.Number] = report
	}
	return reports, tickets, nil
}
