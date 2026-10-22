// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The merge queue (FR-REV-026, #912), which the batch merge feeds too (FR-REV-025, DS-REV-017): one queue per project
// and base holds the PRs the developer validated, each bound to the head they reviewed. A PR validated while its checks
// still run joins it from the Validate sheet; a batch adds the PRs selected in the Reviews list. wavesrv merges them
// one after the other in the suggested order (#781, sent by the window on each join): a PR that still merges cleanly
// with green checks is merged at once through Validate's path (FR-REV-012), with no rebase and no new CI run; only a PR
// an earlier merge put in conflict goes to the developer's agent, out of sight in a worktree of its own (#758), which
// rebases it and pushes with lease, and it is merged once its checks passed on the rebased head. Never a red PR: a
// failing check takes that PR aside, watched on its head, and the others go on; any push the queue did not make voids
// the validation. Each PR can be withdrawn until its merge starts. The queue is persisted in MoltenTerm's data folder,
// resumes when wavesrv starts again and is published to the windows, which draw the banner and the rows from it.

// Must match frontend/moltenterm-shell/reviews/reviews-batch-model.ts.
const (
	QueueAddCommand      = "moltenreviewqueueadd"
	QueueWithdrawCommand = "moltenreviewqueuewithdraw"
	BatchGetCommand      = "moltenreviewbatchget"
	BatchCancelCommand   = "moltenreviewbatchcancel"
	BatchDismissCommand  = "moltenreviewbatchdismiss"
	// WPS event with a project's BatchRun (scope: the project folder).
	BatchEvent = "molten:review:batch"

	BatchRunning     = "running"
	BatchCancelling  = "cancelling"
	BatchDone        = "done"
	BatchCancelled   = "cancelled"
	BatchInterrupted = "interrupted"

	BatchItemQueued        = "queued"
	BatchItemChecking      = "checking"
	BatchItemRebasing      = "rebasing"
	BatchItemWaitingChecks = "waitingchecks"
	BatchItemMerging       = "merging"
	BatchItemMerged        = "merged"
	BatchItemSkipped       = "skipped"
	// stopped: the queue needs the developer on it (a new validation puts it back); failed: a check fails, the PR is
	// watched on its head and comes back once its checks are rerun green.
	BatchItemStopped = "stopped"
	BatchItemFailed  = "failed"
	// voided: a push the queue did not make changed the code the developer validated; withdrawn: Cancel validation.
	BatchItemVoided    = "voided"
	BatchItemWithdrawn = "withdrawn"

	// Where a PR came from.
	BatchSourceValidate = "validate"
	BatchSourceBatch    = "batch"

	// Why a PR stopped or was skipped; the window and the notifications word them.
	BatchReasonFailing      = "failing"
	BatchReasonAmbiguous    = "ambiguous"
	BatchReasonConflict     = "conflict"
	BatchReasonAgentExited  = "agentexited"
	BatchReasonAgentTimeout = "agenttimeout"
	BatchReasonNoAgent      = "noagent"
	// BatchReasonAgentMissing: the coding agent chosen for the project is not installed (#845); Detail names it.
	BatchReasonAgentMissing = "agentmissing"
	BatchReasonAgentStart   = "agentstart"
	BatchReasonBlocked      = "blocked"
	BatchReasonWarnings     = "warnings"
	// method: GitHub no longer allows the method shown when the PR joined (#957); Names holds it.
	BatchReasonMethod      = "method"
	BatchReasonCiTimeout   = "citimeout"
	BatchReasonUnknown     = "unknown"
	BatchReasonMergeFailed = "mergefailed"
	BatchReasonRead        = "read"
	BatchReasonHeadMoved   = "headmoved"
	BatchReasonDraft       = "draft"
	BatchReasonMergedAway  = "mergedaway"
	BatchReasonClosed      = "closed"
	BatchReasonNotReached  = "notreached"
	BatchReasonCancelled   = "cancelled"
	BatchReasonInterrupted = "interrupted"
	// BatchReasonPushed: a push the queue did not make (the validation is void); BatchReasonWithdrawn: by the developer.
	BatchReasonPushed    = "pushed"
	BatchReasonWithdrawn = "withdrawn"

	// Why the agent's worktree was kept at the end (BatchRun.Kept).
	BatchKeptChanges  = "changes"
	BatchKeptUnpushed = "unpushed"
	BatchKeptRebasing = "rebasing"
	BatchKeptWorking  = "working"
	BatchKeptUnread   = "unread"

	MaxBatchPrs = 30

	batchDirName  = "batch"
	batchTreeName = "batch-merge"
)

const (
	defaultBatchPoll  = 15 * time.Second
	defaultAgentPoll  = 3 * time.Second
	defaultAgentLimit = 90 * time.Minute
	// GitHub tells again whether a PR merges cleanly a little while after its base moved.
	defaultComputeLimit = 5 * time.Minute
	// A push starts its workflows within seconds; this long after a rebase, a check of the old head whose workflow
	// never ran on the new head is no longer waited for (#887).
	defaultChecksSettle = 3 * time.Minute
	// A PR rebased this many times that still conflicts stops: the base keeps moving under it.
	maxBatchRebases = 2
	// A merge refused because the head or the base moved under it is tried again at most this many times.
	maxBatchMergeTries = 3
	// gh pr view failing this many times in a row stops the PR.
	maxBatchReadErrors = 4
	batchStepTimeout   = 2 * time.Minute
)

// BatchPr is a PR joining the queue: from the Reviews list (a batch, bound to the head listed) or from the Validate
// sheet (PlanId: the plan the developer validated, which gives the head, the method and the warnings confirmed).
type BatchPr struct {
	Number  int    `json:"number"`
	HeadRef string `json:"headref"`
	HeadOid string `json:"headoid"`
	Title   string `json:"title,omitempty"`
	Url     string `json:"url,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
	PlanId  string `json:"planid,omitempty"`
	// Method: the one chosen in the sheet; Override: the plan's warnings were confirmed there.
	Method   string `json:"method,omitempty"`
	Override bool   `json:"override,omitempty"`
}

type BatchItem struct {
	BatchPr
	State string `json:"state"`
	// Source: BatchSource…; Valid: the head the validation is bound to (the reviewed one, then the queue's own pushes);
	// Overridden: the warnings the developer confirmed; ValidatedAt: when they validated it.
	Source      string   `json:"source,omitempty"`
	Valid       string   `json:"valid,omitempty"`
	Overridden  []string `json:"overridden,omitempty"`
	ValidatedAt int64    `json:"validatedat,omitempty"`
	// Reason: BatchReason…, why it stopped or was skipped. Names: the failing checks or the plan's warnings;
	// Note: the agent's own words (data); Detail: a raw error, tokens masked; Code: the merge record's code.
	Reason string   `json:"reason,omitempty"`
	Names  []string `json:"names,omitempty"`
	Note   string   `json:"note,omitempty"`
	Detail string   `json:"detail,omitempty"`
	Code   string   `json:"code,omitempty"`
	// ByYou: the developer withdrew it.
	ByYou bool `json:"byyou,omitempty"`
	// Head: the head read last; Rebases: how many times the agent rebased it; CiRuns: the CI runs it redid.
	Head    string `json:"head,omitempty"`
	Rebases int    `json:"rebases,omitempty"`
	CiRuns  int    `json:"ciruns,omitempty"`
	// Waiting: the agent waits for the developer's answer on this PR.
	Waiting   bool  `json:"waiting,omitempty"`
	StartedAt int64 `json:"startedat,omitempty"`
	EndedAt   int64 `json:"endedat,omitempty"`
}

type BatchRun struct {
	Id     string `json:"id"`
	Dir    string `json:"dir"`
	Repo   string `json:"repo"`
	Base   string `json:"base"`
	Method string `json:"method,omitempty"`
	State  string `json:"state"`
	// Current: the index of the PR in progress, -1 between PRs.
	Current int         `json:"current"`
	Items   []BatchItem `json:"items"`
	// CiRuns: the CI runs the queue redid (a rebase by the agent, an update by GitHub).
	CiRuns int `json:"ciruns"`
	// The agent, once one was needed: its terminal (hidden tab) and worktree.
	Agent       string `json:"agent,omitempty"`
	AgentName   string `json:"agentname,omitempty"`
	BlockId     string `json:"blockid,omitempty"`
	TabId       string `json:"tabid,omitempty"`
	Worktree    string `json:"worktree,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	// Cleaned: the agent's terminal and worktree went at the end; Kept: why the worktree stayed (BatchKept…).
	Cleaned     bool   `json:"cleaned,omitempty"`
	Kept        string `json:"kept,omitempty"`
	CancelAsked bool   `json:"cancelasked,omitempty"`
	Dismissed   bool   `json:"dismissed,omitempty"`
	// ResumedAt: the queue resumed after MoltenTerm restarted.
	ResumedAt int64 `json:"resumedat,omitempty"`
	StartedAt int64 `json:"startedat"`
	EndedAt   int64 `json:"endedat,omitempty"`
}

func (r BatchRun) active() bool {
	return r.State == BatchRunning || r.State == BatchCancelling
}

type QueueAddRequest struct {
	Dir    string    `json:"dir"`
	Repo   string    `json:"repo"`
	Base   string    `json:"base"`
	Method string    `json:"method,omitempty"`
	Prs    []BatchPr `json:"prs"`
	// Source: BatchSourceBatch for a batch from the Reviews list, else a validation.
	Source string `json:"source,omitempty"`
	// Order: the suggested merge order (#781) of the project's PRs, the ones joining included; the PRs not started yet
	// are sorted by it.
	Order []int `json:"order,omitempty"`
	// WorkspaceId: the window's workspace, where the agent's hidden tab goes; TabName: its name in the window's
	// language.
	WorkspaceId string `json:"workspaceid"`
	TabName     string `json:"tabname,omitempty"`
}

type BatchRequest struct {
	Dir  string `json:"dir"`
	Base string `json:"base,omitempty"`
	Id   string `json:"id,omitempty"`
}

type QueueWithdrawRequest struct {
	Dir    string `json:"dir"`
	Base   string `json:"base"`
	Number int    `json:"number"`
}

// BatchEnv is what the queue reaches outside its own state; the tests give fakes.
type BatchEnv struct {
	Gh     GhRunner
	Merger *Merger
	// Agents: the out-of-sight agent's env (#758): its tab, terminal, typing path, state and clean end.
	Agents  *Restarter
	DataDir string
	Publish func(run BatchRun)
	Now     func() time.Time
	Sleep   func(ctx context.Context, d time.Duration) bool
	// Every: how often GitHub is read while waiting; AgentEvery: how often the agent's result is looked for.
	Every        time.Duration
	AgentEvery   time.Duration
	AgentLimit   time.Duration
	ComputeLimit time.Duration
	// ChecksSettle: how long after a rebase every check of the old head is expected on the new one.
	ChecksSettle time.Duration
}

type batchCtl struct {
	key string
	run BatchRun
	// stop cancels the run's waits (Cancel all); itemStop the current PR's (Cancel validation on it).
	stop     context.CancelFunc
	itemStop context.CancelFunc
	// withdrawn: the PRs the developer withdrew while they were in progress.
	withdrawn map[int]bool
	// order: the suggested order last sent; preempt: a PR joining goes before the current one, which only waits for
	// its checks, so the current one goes back to its place.
	order   []int
	preempt bool
	wake    chan struct{}
	agent   *batchAgent
	done    chan struct{}
}

type BatchRunner struct {
	env BatchEnv

	// pubLock orders the changes with their saves and events, so the file and the windows never go back to an older
	// state; always taken before lock.
	pubLock sync.Mutex
	lock    sync.Mutex
	runs    map[string]*batchCtl
}

func MakeBatchRunner(env BatchEnv) *BatchRunner {
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.Sleep == nil {
		env.Sleep = sleepCtx
	}
	if env.Every <= 0 {
		env.Every = defaultBatchPoll
	}
	if env.AgentEvery <= 0 {
		env.AgentEvery = defaultAgentPoll
	}
	if env.AgentLimit <= 0 {
		env.AgentLimit = defaultAgentLimit
	}
	if env.ComputeLimit <= 0 {
		env.ComputeLimit = defaultComputeLimit
	}
	if env.ChecksSettle <= 0 {
		env.ChecksSettle = defaultChecksSettle
	}
	return &BatchRunner{env: env, runs: map[string]*batchCtl{}}
}

func validBatchMethod(method string) bool {
	return method == "" || hasMethod(allMergeMethods, method)
}

func (req QueueAddRequest) check() error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if err := checkRepo(req.Repo); err != nil {
		return err
	}
	if !reviewsession.ValidRef(req.Base) {
		return fmt.Errorf("base must be the PRs' base branch")
	}
	if !validBatchMethod(req.Method) {
		return fmt.Errorf("method must be merge, squash or rebase")
	}
	if req.Source != "" && req.Source != BatchSourceBatch && req.Source != BatchSourceValidate {
		return fmt.Errorf("source must be batch or validate")
	}
	if req.WorkspaceId == "" {
		return fmt.Errorf("workspaceid is required")
	}
	if len(req.Prs) == 0 {
		return uimsg.Errorf(uimsg.Make("review.batchempty"), "select the PRs to merge first")
	}
	if len(req.Prs) > MaxBatchPrs {
		return fmt.Errorf("a batch merges at most %d PRs", MaxBatchPrs)
	}
	seen := map[int]bool{}
	for _, pr := range req.Prs {
		if pr.Number <= 0 || !reviewsession.ValidRef(pr.HeadRef) {
			return fmt.Errorf("PR #%d must name its branch", pr.Number)
		}
		if pr.PlanId == "" && !isOid(pr.HeadOid) {
			return fmt.Errorf("PR #%d must name its head commit or the plan validated", pr.Number)
		}
		if !validBatchMethod(pr.Method) {
			return fmt.Errorf("method must be merge, squash or rebase")
		}
		if seen[pr.Number] {
			return fmt.Errorf("PR #%d is listed twice", pr.Number)
		}
		seen[pr.Number] = true
	}
	return nil
}

func queueKey(dir string, base string) string {
	return filepath.Clean(dir) + "\x00" + base
}

// batchFile is a project's queue for a base: <data>/molten/reviews/batch/<hash>.json, never in the project.
func (b *BatchRunner) batchFile(dir string, base string) string {
	sum := sha256.Sum256([]byte(queueKey(dir, base)))
	return filepath.Join(b.env.DataDir, "molten", "reviews", batchDirName, hex.EncodeToString(sum[:8])+".json")
}

func (b *BatchRunner) save(run BatchRun) {
	file := b.batchFile(run.Dir, run.Base)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		log.Printf("%s queue %s: it could not be kept: %v\n", logPrefix, run.Id, err)
		return
	}
	data, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		log.Printf("%s queue %s: it could not be kept: %v\n", logPrefix, run.Id, err)
		return
	}
	if err := os.Rename(tmp, file); err != nil {
		log.Printf("%s queue %s: it could not be kept: %v\n", logPrefix, run.Id, err)
	}
}

func readRun(file string) (BatchRun, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return BatchRun{}, false
	}
	var run BatchRun
	if err := json.Unmarshal(data, &run); err != nil || run.Id == "" {
		return BatchRun{}, false
	}
	return run, true
}

func (b *BatchRunner) load(dir string, base string) (BatchRun, bool) {
	return readRun(b.batchFile(dir, base))
}

func copyRun(run BatchRun) BatchRun {
	run.Items = append([]BatchItem(nil), run.Items...)
	for i := range run.Items {
		run.Items[i].Names = append([]string(nil), run.Items[i].Names...)
		run.Items[i].Overridden = append([]string(nil), run.Items[i].Overridden...)
	}
	return run
}

// publish keeps the run and sends it to the windows; called with a copy, outside the lock.
func (b *BatchRunner) publish(run BatchRun) {
	b.save(run)
	if b.env.Publish != nil {
		b.env.Publish(run)
	}
}

// change applies a change to the run under the lock, then keeps and publishes the result. A run a newer one replaced
// (an ended queue still cleaning up) is no longer kept or published.
func (b *BatchRunner) change(ctl *batchCtl, fn func(run *BatchRun)) BatchRun {
	b.pubLock.Lock()
	defer b.pubLock.Unlock()
	b.lock.Lock()
	fn(&ctl.run)
	run := copyRun(ctl.run)
	current := b.runs[ctl.key] == ctl
	b.lock.Unlock()
	if current {
		b.publish(run)
	}
	return run
}

func (b *BatchRunner) read(ctl *batchCtl) BatchRun {
	b.lock.Lock()
	defer b.lock.Unlock()
	return copyRun(ctl.run)
}

func (b *BatchRunner) ctlOf(dir string, base string) *batchCtl {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.runs[queueKey(dir, base)]
}

// Get answers the project's queue for the base: the one in memory, else the last one kept; a queue kept as running
// that no longer runs (it could not resume) reads as interrupted. Nil when there never was one.
func (b *BatchRunner) Get(req BatchRequest) (*BatchRun, error) {
	if err := checkDir(req.Dir); err != nil {
		return nil, err
	}
	if ctl := b.ctlOf(req.Dir, req.Base); ctl != nil {
		run := b.read(ctl)
		return &run, nil
	}
	run, ok := b.load(req.Dir, req.Base)
	if !ok {
		return nil, nil
	}
	if run.active() {
		run.State = BatchInterrupted
		run.EndedAt = b.env.Now().UnixMilli()
		for i := range run.Items {
			if !batchItemEnded(run.Items[i].State) {
				run.Items[i].State, run.Items[i].Reason = BatchItemSkipped, BatchReasonInterrupted
			}
		}
		b.save(run)
	}
	return &run, nil
}

// batchItemEnded: the PR left the queue for good (a new validation may put it back).
func batchItemEnded(state string) bool {
	switch state {
	case BatchItemMerged, BatchItemSkipped, BatchItemStopped, BatchItemVoided, BatchItemWithdrawn:
		return true
	}
	return false
}

// itemOpen: the PR still waits in the queue or is in progress (a failed one is watched).
func itemOpen(state string) bool {
	return !batchItemEnded(state)
}

// QueuedPrs: the PRs a project's queue for the base still has to merge; the cleanup after any merge leaves them to
// the queue, which rebases them itself.
func (b *BatchRunner) QueuedPrs(dir string, base string) []int {
	ctl := b.ctlOf(dir, base)
	if ctl == nil {
		return nil
	}
	run := b.read(ctl)
	if !run.active() {
		return nil
	}
	var rtn []int
	for _, it := range run.Items {
		if itemOpen(it.State) {
			rtn = append(rtn, it.Number)
		}
	}
	return rtn
}

// batchMethod is the method the queue's PRs without a plan of their own merge with (#957): the one the batch modal
// showed, else the repository's default, never left empty to be decided at merge time. The modal's choice is the
// repository's next default.
func (b *BatchRunner) batchMethod(req QueueAddRequest) (string, error) {
	if b.env.Merger == nil || !slices.ContainsFunc(req.Prs, func(pr BatchPr) bool { return pr.PlanId == "" }) {
		return req.Method, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	methods := b.env.Merger.planMethods(ctx, req.Dir, req.Repo, req.Base)
	if req.Method == "" {
		return methods.method, nil
	}
	if !hasMethod(methods.methods, req.Method) {
		return "", uimsg.Errorf(uimsg.Make("review.batchmethod"), "%s merges are not allowed on %s any more", req.Method, req.Base)
	}
	b.env.Merger.keepChosenMethod(req.Repo, req.Method, methods.queue)
	return req.Method, nil
}

// itemOf makes the queue's item of a PR joining it, bound to its head. A PR from the Validate sheet takes its plan:
// the head, the method and the warnings confirmed are the ones the developer saw.
func (b *BatchRunner) itemOf(req QueueAddRequest, pr BatchPr) (BatchItem, error) {
	source := req.Source
	if source == "" {
		source = BatchSourceValidate
	}
	item := BatchItem{BatchPr: pr, State: BatchItemQueued, Source: source, ValidatedAt: b.env.Now().UnixMilli()}
	if pr.PlanId == "" {
		item.Valid = pr.HeadOid
		// Each PR keeps the method shown when it joined: a later batch with another method does not change it.
		if item.Method == "" {
			item.Method = req.Method
		}
		return item, nil
	}
	if b.env.Merger == nil {
		return item, fmt.Errorf("Validate is not available")
	}
	plan, err := b.env.Merger.takeQueuePlan(MergeRequest{PrKey: PrKey{Repo: req.Repo, Number: pr.Number}, PlanId: pr.PlanId, Override: pr.Override, Method: pr.Method})
	if err != nil {
		return item, err
	}
	if plan.BaseRef != req.Base {
		return item, fmt.Errorf("PR #%d goes into %s, not %s", pr.Number, plan.BaseRef, req.Base)
	}
	item.HeadOid, item.Valid, item.Method = plan.HeadOid, plan.HeadOid, plan.Method
	b.env.Merger.keepChosenMethod(req.Repo, plan.Method, plan.Queue)
	if pr.Override {
		item.Overridden = plan.Warnings
	}
	if item.Title == "" {
		item.Title = plan.Title
	}
	if item.Url == "" {
		item.Url = plan.Url
	}
	if item.Ticket == 0 {
		item.Ticket = plan.Ticket
	}
	return item, nil
}

// reorder sorts the PRs not started yet by the suggested order, in the slots they hold; the others keep their place.
// A PR the order does not name keeps its place after the named ones.
func reorder(items []BatchItem, current int, order []int) {
	if len(order) == 0 {
		return
	}
	rank := map[int]int{}
	for i, n := range order {
		if _, ok := rank[n]; !ok {
			rank[n] = i
		}
	}
	var slots []int
	var waiting []BatchItem
	for i, it := range items {
		if it.State == BatchItemQueued && i != current {
			slots = append(slots, i)
			waiting = append(waiting, it)
		}
	}
	rankOf := func(it BatchItem) int {
		if r, ok := rank[it.Number]; ok {
			return r
		}
		return len(order)
	}
	slices.SortStableFunc(waiting, func(a, b BatchItem) int { return rankOf(a) - rankOf(b) })
	for i, slot := range slots {
		items[slot] = waiting[i]
	}
}

// goesBefore: a PR waiting comes before the current one in the suggested order while the current one only waits for
// its checks (no rebase or merge under way), so the queue takes it first; called under the lock.
func (b *BatchRunner) goesBefore(ctl *batchCtl) bool {
	cur := ctl.run.Current
	if cur < 0 || cur >= len(ctl.run.Items) || len(ctl.order) == 0 {
		return false
	}
	state := ctl.run.Items[cur].State
	if state != BatchItemChecking && state != BatchItemWaitingChecks {
		return false
	}
	curRank := slices.Index(ctl.order, ctl.run.Items[cur].Number)
	if curRank < 0 {
		return false
	}
	for i, it := range ctl.run.Items {
		if i == cur || it.State != BatchItemQueued {
			continue
		}
		if rank := slices.Index(ctl.order, it.Number); rank >= 0 && rank < curRank {
			return true
		}
	}
	return false
}

// Add puts PRs in the project's queue for their base, on the developer's click in a window only (NFR-REV-003), and
// returns the queue at once. A PR already in it is bound again to the new validation, unless its merge started.
func (b *BatchRunner) Add(req QueueAddRequest) (BatchRun, error) {
	if err := req.check(); err != nil {
		return BatchRun{}, err
	}
	method, err := b.batchMethod(req)
	if err != nil {
		return BatchRun{}, err
	}
	req.Method = method
	dir := filepath.Clean(req.Dir)
	items := make([]BatchItem, 0, len(req.Prs))
	for _, pr := range req.Prs {
		item, err := b.itemOf(req, pr)
		if err != nil {
			return BatchRun{}, err
		}
		items = append(items, item)
	}
	key := queueKey(dir, req.Base)
	b.pubLock.Lock()
	defer b.pubLock.Unlock()
	b.lock.Lock()
	ctl := b.runs[key]
	if ctl != nil && ctl.run.active() && !ctl.run.CancelAsked {
		for _, item := range items {
			idx := slices.IndexFunc(ctl.run.Items, func(it BatchItem) bool { return it.Number == item.Number })
			if idx < 0 {
				ctl.run.Items = append(ctl.run.Items, item)
				continue
			}
			old := ctl.run.Items[idx]
			if old.State == BatchItemMerging || old.State == BatchItemMerged {
				b.lock.Unlock()
				return BatchRun{}, uimsg.Errorf(uimsg.Make("review.queue.merging", "number", fmt.Sprint(item.Number)), "#%d is being merged already", item.Number)
			}
			if idx == ctl.run.Current {
				// In progress: the new binding applies from its next read.
				item.State, item.StartedAt, item.Head, item.Rebases = old.State, old.StartedAt, old.Head, old.Rebases
			}
			delete(ctl.withdrawn, item.Number)
			ctl.run.Items[idx] = item
		}
		if req.Method != "" {
			ctl.run.Method = req.Method
		}
		if len(req.Order) > 0 {
			ctl.order = req.Order
		}
		reorder(ctl.run.Items, ctl.run.Current, ctl.order)
		if b.goesBefore(ctl) && ctl.itemStop != nil {
			ctl.preempt = true
			ctl.itemStop()
		}
		run := copyRun(ctl.run)
		b.lock.Unlock()
		select {
		case ctl.wake <- struct{}{}:
		default:
		}
		b.publish(run)
		b.logAdd(run, items)
		return run, nil
	}
	if ctl != nil && ctl.run.active() {
		b.lock.Unlock()
		return BatchRun{}, uimsg.Errorf(uimsg.Make("review.batchrunning"), "the merge queue is being cancelled")
	}
	reorder(items, -1, req.Order)
	run := BatchRun{Id: uuid.NewString(), Dir: dir, Repo: req.Repo, Base: req.Base, Method: req.Method, State: BatchRunning,
		Current: -1, Items: items, WorkspaceId: req.WorkspaceId, StartedAt: b.env.Now().UnixMilli()}
	ctl = b.startCtl(key, run, &batchAgent{tabName: req.TabName})
	ctl.order = req.Order
	run = copyRun(ctl.run)
	b.lock.Unlock()
	b.publish(run)
	b.logAdd(run, items)
	b.launch(ctl)
	return run, nil
}

func (b *BatchRunner) logAdd(run BatchRun, items []BatchItem) {
	var numbers []string
	for _, it := range items {
		numbers = append(numbers, fmt.Sprintf("#%d@%s", it.Number, shortHead(it.Valid)))
	}
	log.Printf("%s queue %s: %s of %s into %s joined\n", logPrefix, run.Id, strings.Join(numbers, " "), run.Repo, run.Base)
}

// startCtl registers a queue's control; called under the lock.
func (b *BatchRunner) startCtl(key string, run BatchRun, agent *batchAgent) *batchCtl {
	ctl := &batchCtl{key: key, run: run, withdrawn: map[int]bool{}, wake: make(chan struct{}, 1), agent: agent, done: make(chan struct{})}
	b.runs[key] = ctl
	return ctl
}

func (b *BatchRunner) launch(ctl *batchCtl) {
	ctx, stop := context.WithCancel(context.Background())
	b.lock.Lock()
	ctl.stop = stop
	b.lock.Unlock()
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:review:queue", recover())
		}()
		defer close(ctl.done)
		defer stop()
		b.loop(ctx, ctl)
	}()
}

// Resume starts again the queues kept as running when wavesrv stopped (FR-REV-026 AC2). The PRs in progress start
// over from a fresh read; their validations still hold on the heads they were bound to.
func (b *BatchRunner) Resume() {
	dir := filepath.Join(b.env.DataDir, "molten", "reviews", batchDirName)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		run, ok := readRun(filepath.Join(dir, entry.Name()))
		if !ok || !run.active() || filepath.Join(dir, entry.Name()) != b.batchFile(run.Dir, run.Base) {
			continue
		}
		b.resume(run)
	}
}

func (b *BatchRunner) resume(run BatchRun) {
	agent := &batchAgent{}
	if run.Worktree != "" && pathExists(run.Worktree) {
		agent.tree = run.Worktree
	}
	oldBlock := run.BlockId
	run.State = BatchRunning
	if run.CancelAsked {
		run.State = BatchCancelling
	}
	run.Current = -1
	run.BlockId, run.TabId, run.Agent, run.AgentName = "", "", "", ""
	run.ResumedAt = b.env.Now().UnixMilli()
	waiting := 0
	for i := range run.Items {
		it := &run.Items[i]
		if it.Valid == "" {
			it.Valid = it.HeadOid
		}
		switch it.State {
		case BatchItemChecking, BatchItemRebasing, BatchItemWaitingChecks, BatchItemMerging:
			it.State = BatchItemQueued
		}
		it.Waiting = false
		if itemOpen(it.State) {
			waiting++
		}
	}
	key := queueKey(run.Dir, run.Base)
	b.pubLock.Lock()
	b.lock.Lock()
	if b.runs[key] != nil {
		b.lock.Unlock()
		b.pubLock.Unlock()
		return
	}
	ctl := b.startCtl(key, run, agent)
	b.lock.Unlock()
	b.publish(copyRun(run))
	b.pubLock.Unlock()
	if oldBlock != "" {
		b.closeOldAgent(oldBlock)
	}
	log.Printf("%s queue %s: resumed with %d PRs\n", logPrefix, run.Id, waiting)
	b.notifyResumed(run, waiting)
	b.launch(ctl)
}

// closeOldAgent: the agent of the queue before the restart no longer runs its session; its terminal goes.
func (b *BatchRunner) closeOldAgent(blockId string) {
	r := b.env.Agents
	if r == nil || r.env.CloseTerminal == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	if r.env.BlockExists != nil && !r.env.BlockExists(ctx, blockId) {
		return
	}
	if err := r.env.CloseTerminal(ctx, blockId); err != nil {
		log.Printf("%s queue: the agent's terminal from before the restart could not be closed: %v\n", logPrefix, err)
	}
}

func (b *BatchRunner) ctlFor(dir string, base string, id string) (*batchCtl, error) {
	if err := checkDir(dir); err != nil {
		return nil, err
	}
	ctl := b.ctlOf(dir, base)
	if ctl == nil || (id != "" && b.read(ctl).Id != id) {
		return nil, uimsg.Errorf(uimsg.Make("review.batchgone"), "this merge queue no longer runs")
	}
	return ctl, nil
}

// Withdraw is Cancel validation on one PR: it leaves the queue unless its merge started (a merge call is not undone).
func (b *BatchRunner) Withdraw(req QueueWithdrawRequest) (BatchRun, error) {
	ctl, err := b.ctlFor(req.Dir, req.Base, "")
	if err != nil {
		return BatchRun{}, err
	}
	b.pubLock.Lock()
	defer b.pubLock.Unlock()
	b.lock.Lock()
	idx := slices.IndexFunc(ctl.run.Items, func(it BatchItem) bool { return it.Number == req.Number })
	if idx < 0 {
		run := copyRun(ctl.run)
		b.lock.Unlock()
		return run, uimsg.Errorf(uimsg.Make("review.queue.notqueued", "number", fmt.Sprint(req.Number)), "#%d is not in the merge queue", req.Number)
	}
	it := &ctl.run.Items[idx]
	switch {
	case it.State == BatchItemMerging || it.State == BatchItemMerged:
		run := copyRun(ctl.run)
		b.lock.Unlock()
		return run, uimsg.Errorf(uimsg.Make("review.queue.merging", "number", fmt.Sprint(req.Number)), "#%d is being merged already", req.Number)
	case batchItemEnded(it.State):
	case idx == ctl.run.Current:
		ctl.withdrawn[req.Number] = true
		if ctl.itemStop != nil {
			ctl.itemStop()
		}
	default:
		it.State, it.Reason, it.ByYou, it.EndedAt = BatchItemWithdrawn, BatchReasonWithdrawn, true, b.env.Now().UnixMilli()
	}
	run := copyRun(ctl.run)
	current := b.runs[ctl.key] == ctl
	b.lock.Unlock()
	select {
	case ctl.wake <- struct{}{}:
	default:
	}
	if current {
		b.publish(run)
	}
	b.resolvePrNotice(run, req.Number)
	return run, nil
}

// Cancel withdraws every PR not being merged: a wait for checks ends at once, an agent's rebase or a merge already
// sent finishes, and nothing more is merged.
func (b *BatchRunner) Cancel(req BatchRequest) (BatchRun, error) {
	ctl, err := b.ctlFor(req.Dir, req.Base, req.Id)
	if err != nil {
		return BatchRun{}, err
	}
	b.pubLock.Lock()
	defer b.pubLock.Unlock()
	b.lock.Lock()
	if !ctl.run.active() {
		run := copyRun(ctl.run)
		b.lock.Unlock()
		return run, nil
	}
	ctl.run.CancelAsked = true
	ctl.run.State = BatchCancelling
	run := copyRun(ctl.run)
	stop := ctl.stop
	b.lock.Unlock()
	if stop != nil {
		stop()
	}
	b.publish(run)
	return run, nil
}

// Dismiss hides an ended queue's banner.
func (b *BatchRunner) Dismiss(req BatchRequest) (*BatchRun, error) {
	if err := checkDir(req.Dir); err != nil {
		return nil, err
	}
	if ctl := b.ctlOf(req.Dir, req.Base); ctl != nil {
		b.lock.Lock()
		active := ctl.run.active()
		b.lock.Unlock()
		if active {
			return nil, uimsg.Errorf(uimsg.Make("review.batchrunning"), "the merge queue still runs in this project")
		}
		run := b.change(ctl, func(run *BatchRun) { run.Dismissed = true })
		return &run, nil
	}
	run, ok := b.load(req.Dir, req.Base)
	if !ok {
		return nil, nil
	}
	run.Dismissed = true
	b.publish(run)
	return &run, nil
}

func (s *Service) handleBatch(command string, data any) (any, error) {
	if s.batch == nil {
		return nil, fmt.Errorf("the merge queue is not available")
	}
	switch command {
	case QueueAddCommand:
		req, err := decode[QueueAddRequest](data)
		if err != nil {
			return nil, err
		}
		return s.batch.Add(req)
	case QueueWithdrawCommand:
		req, err := decode[QueueWithdrawRequest](data)
		if err != nil {
			return nil, err
		}
		return s.batch.Withdraw(req)
	}
	req, err := decode[BatchRequest](data)
	if err != nil {
		return nil, err
	}
	switch command {
	case BatchCancelCommand:
		return s.batch.Cancel(req)
	case BatchDismissCommand:
		return s.batch.Dismiss(req)
	}
	return s.batch.Get(req)
}

// wait returns when the project's queue has ended (tests).
func (b *BatchRunner) wait(dir string, base string) {
	ctl := b.ctlOf(dir, base)
	if ctl != nil {
		<-ctl.done
	}
}
