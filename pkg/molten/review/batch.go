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
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// Batch merge by an agent (FR-REV-025, DS-REV-017): the developer selects PRs in the Reviews list and, once they
// confirmed the modal (the order, the method, what the agent does), wavesrv merges them one after the other. The aim is
// to spend as few CI runs as possible: a PR that still merges cleanly with green checks is merged at once through
// Validate's path (FR-REV-012), with no rebase and no new CI run; only a PR an earlier merge put in conflict goes to the
// developer's agent, out of sight in a worktree of its own (#758), which rebases it, resolves the conflicts and pushes
// with lease, and it is merged once its checks passed on the rebased head. A PR whose checks fail is never merged: the
// run stops on it and asks the developer (a notification and the PR's row), and the PRs after it wait for their
// decision. Cancel ends the run after the current step. The run is persisted in MoltenTerm's data folder and published
// to the windows, which draw the banner from it.

// Must match frontend/moltenterm-shell/reviews/reviews-batch-model.ts.
const (
	BatchStartCommand   = "moltenreviewbatchstart"
	BatchGetCommand     = "moltenreviewbatchget"
	BatchCancelCommand  = "moltenreviewbatchcancel"
	BatchDecideCommand  = "moltenreviewbatchdecide"
	BatchDismissCommand = "moltenreviewbatchdismiss"
	// WPS event with a project's BatchRun (scope: the project folder).
	BatchEvent = "molten:review:batch"

	BatchRunning = "running"
	// BatchPaused: stopped on a PR, waiting for the developer's decision.
	BatchPaused      = "paused"
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
	BatchItemStopped       = "stopped"

	// Why a PR stopped the run or was skipped; the window and the notifications word them.
	BatchReasonFailing      = "failing"
	BatchReasonAmbiguous    = "ambiguous"
	BatchReasonConflict     = "conflict"
	BatchReasonAgentExited  = "agentexited"
	BatchReasonAgentTimeout = "agenttimeout"
	BatchReasonNoAgent      = "noagent"
	BatchReasonAgentStart   = "agentstart"
	BatchReasonBlocked      = "blocked"
	BatchReasonWarnings     = "warnings"
	BatchReasonCiTimeout    = "citimeout"
	BatchReasonUnknown      = "unknown"
	BatchReasonMergeFailed  = "mergefailed"
	BatchReasonRead         = "read"
	BatchReasonHeadMoved    = "headmoved"
	BatchReasonDraft        = "draft"
	BatchReasonMergedAway   = "mergedaway"
	BatchReasonClosed       = "closed"
	BatchReasonNotReached   = "notreached"
	BatchReasonCancelled    = "cancelled"
	BatchReasonInterrupted  = "interrupted"

	BatchDecisionRetry    = "retry"
	BatchDecisionOverride = "override"
	BatchDecisionSkip     = "skip"
	BatchDecisionEnd      = "end"

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
	// A PR rebased this many times that still conflicts stops the run: the base keeps moving under it.
	maxBatchRebases = 2
	// A merge refused because the head or the base moved under it is tried again at most this many times.
	maxBatchMergeTries = 3
	// gh pr view failing this many times in a row stops the run on the PR.
	maxBatchReadErrors = 4
	batchStepTimeout   = 2 * time.Minute
)

// BatchPr is a PR of the batch as the window listed it.
type BatchPr struct {
	Number  int    `json:"number"`
	HeadRef string `json:"headref"`
	HeadOid string `json:"headoid"`
	Title   string `json:"title,omitempty"`
	Url     string `json:"url,omitempty"`
	Ticket  int    `json:"ticket,omitempty"`
}

type BatchItem struct {
	BatchPr
	State string `json:"state"`
	// Reason: BatchReason…, why it stopped the run or was skipped. Names: the failing checks or the plan's warnings;
	// Note: the agent's own words (data); Detail: a raw error, tokens masked; Code: the merge record's code.
	Reason string   `json:"reason,omitempty"`
	Names  []string `json:"names,omitempty"`
	Note   string   `json:"note,omitempty"`
	Detail string   `json:"detail,omitempty"`
	Code   string   `json:"code,omitempty"`
	// ByYou: the developer chose to skip it.
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
	// Current: the index of the PR in progress (or stopped on), -1 before the first and after the last.
	Current int         `json:"current"`
	Items   []BatchItem `json:"items"`
	// CiRuns: the CI runs the batch redid (a rebase by the agent, an update by GitHub).
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
	StartedAt   int64  `json:"startedat"`
	EndedAt     int64  `json:"endedat,omitempty"`
}

func (r BatchRun) active() bool {
	return r.State == BatchRunning || r.State == BatchPaused || r.State == BatchCancelling
}

type BatchStartRequest struct {
	Dir    string    `json:"dir"`
	Repo   string    `json:"repo"`
	Base   string    `json:"base"`
	Method string    `json:"method,omitempty"`
	Prs    []BatchPr `json:"prs"`
	// WorkspaceId: the window's workspace, where the agent's hidden tab goes; TabName: its name in the window's
	// language.
	WorkspaceId string `json:"workspaceid"`
	TabName     string `json:"tabname,omitempty"`
}

type BatchRequest struct {
	Dir string `json:"dir"`
	Id  string `json:"id,omitempty"`
}

type BatchDecideRequest struct {
	Dir      string `json:"dir"`
	Id       string `json:"id"`
	Decision string `json:"decision"`
}

// BatchEnv is what a batch reaches outside its own state; the tests give fakes.
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
}

type batchCtl struct {
	run BatchRun
	// stop cancels the waits that end at once on Cancel (checks, GitHub computing).
	stop     context.CancelFunc
	decide   chan string
	notified string
	done     chan struct{}
}

type BatchRunner struct {
	env BatchEnv

	lock sync.Mutex
	runs map[string]*batchCtl
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
	return &BatchRunner{env: env, runs: map[string]*batchCtl{}}
}

func validBatchMethod(method string) bool {
	return method == "" || hasMethod(allMergeMethods, method)
}

func (req BatchStartRequest) check() error {
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
		if pr.Number <= 0 || !reviewsession.ValidRef(pr.HeadRef) || !isOid(pr.HeadOid) {
			return fmt.Errorf("PR #%d must name its branch and head commit", pr.Number)
		}
		if seen[pr.Number] {
			return fmt.Errorf("PR #%d is listed twice", pr.Number)
		}
		seen[pr.Number] = true
	}
	return nil
}

// batchFile is a project's run: <data>/molten/reviews/batch/<project hash>.json, never in the project.
func (b *BatchRunner) batchFile(dir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	return filepath.Join(b.env.DataDir, "molten", "reviews", batchDirName, hex.EncodeToString(sum[:8])+".json")
}

func (b *BatchRunner) save(run BatchRun) {
	file := b.batchFile(run.Dir)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		log.Printf("%s batch %s: the run could not be kept: %v\n", logPrefix, run.Id, err)
		return
	}
	data, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		log.Printf("%s batch %s: the run could not be kept: %v\n", logPrefix, run.Id, err)
		return
	}
	if err := os.Rename(tmp, file); err != nil {
		log.Printf("%s batch %s: the run could not be kept: %v\n", logPrefix, run.Id, err)
	}
}

func (b *BatchRunner) load(dir string) (BatchRun, bool) {
	data, err := os.ReadFile(b.batchFile(dir))
	if err != nil {
		return BatchRun{}, false
	}
	var run BatchRun
	if err := json.Unmarshal(data, &run); err != nil || run.Id == "" {
		return BatchRun{}, false
	}
	return run, true
}

func copyRun(run BatchRun) BatchRun {
	run.Items = append([]BatchItem(nil), run.Items...)
	for i := range run.Items {
		run.Items[i].Names = append([]string(nil), run.Items[i].Names...)
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

// change applies a change to the run under the lock, then keeps and publishes the result.
func (b *BatchRunner) change(ctl *batchCtl, fn func(run *BatchRun)) BatchRun {
	b.lock.Lock()
	fn(&ctl.run)
	run := copyRun(ctl.run)
	b.lock.Unlock()
	b.publish(run)
	return run
}

func (b *BatchRunner) read(ctl *batchCtl) BatchRun {
	b.lock.Lock()
	defer b.lock.Unlock()
	return copyRun(ctl.run)
}

func (b *BatchRunner) ctlOf(dir string) *batchCtl {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.runs[filepath.Clean(dir)]
}

// Get answers the project's run: the one in memory, else the last one kept; a run kept as still going that no longer
// runs (wavesrv restarted) reads as interrupted. Nil when the project never had one.
func (b *BatchRunner) Get(req BatchRequest) (*BatchRun, error) {
	if err := checkDir(req.Dir); err != nil {
		return nil, err
	}
	if ctl := b.ctlOf(req.Dir); ctl != nil {
		run := b.read(ctl)
		return &run, nil
	}
	run, ok := b.load(req.Dir)
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

func batchItemEnded(state string) bool {
	return state == BatchItemMerged || state == BatchItemSkipped
}

// Start begins a run on the developer's confirmation (a window's only, NFR-REV-003) and returns it at once.
func (b *BatchRunner) Start(req BatchStartRequest) (BatchRun, error) {
	if err := req.check(); err != nil {
		return BatchRun{}, err
	}
	dir := filepath.Clean(req.Dir)
	items := make([]BatchItem, 0, len(req.Prs))
	for _, pr := range req.Prs {
		items = append(items, BatchItem{BatchPr: pr, State: BatchItemQueued})
	}
	ctx, stop := context.WithCancel(context.Background())
	ctl := &batchCtl{
		run: BatchRun{Id: uuid.NewString(), Dir: dir, Repo: req.Repo, Base: req.Base, Method: req.Method, State: BatchRunning,
			Current: -1, Items: items, WorkspaceId: req.WorkspaceId, StartedAt: b.env.Now().UnixMilli()},
		stop:   stop,
		decide: make(chan string, 1),
		done:   make(chan struct{}),
	}
	tabName := req.TabName
	b.lock.Lock()
	if prev := b.runs[dir]; prev != nil && prev.run.active() {
		b.lock.Unlock()
		stop()
		return BatchRun{}, uimsg.Errorf(uimsg.Make("review.batchrunning"), "a batch merge already runs in this project")
	}
	b.runs[dir] = ctl
	run := copyRun(ctl.run)
	b.lock.Unlock()
	b.publish(run)
	log.Printf("%s batch %s: %d PRs of %s into %s\n", logPrefix, run.Id, len(items), run.Repo, run.Base)
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:review:batch", recover())
		}()
		defer close(ctl.done)
		defer stop()
		b.loop(ctx, ctl, tabName)
	}()
	return run, nil
}

func (b *BatchRunner) ctlFor(dir string, id string) (*batchCtl, error) {
	if err := checkDir(dir); err != nil {
		return nil, err
	}
	ctl := b.ctlOf(dir)
	if ctl == nil || (id != "" && b.read(ctl).Id != id) {
		return nil, uimsg.Errorf(uimsg.Make("review.batchgone"), "this batch merge no longer runs")
	}
	return ctl, nil
}

// Cancel ends the run after the current step: a wait for checks ends at once, an agent's rebase or a merge already sent
// finishes, and nothing more is merged.
func (b *BatchRunner) Cancel(req BatchRequest) (BatchRun, error) {
	ctl, err := b.ctlFor(req.Dir, req.Id)
	if err != nil {
		return BatchRun{}, err
	}
	b.lock.Lock()
	if !ctl.run.active() {
		run := copyRun(ctl.run)
		b.lock.Unlock()
		return run, nil
	}
	ctl.run.CancelAsked = true
	if ctl.run.State == BatchRunning {
		ctl.run.State = BatchCancelling
	}
	run := copyRun(ctl.run)
	b.lock.Unlock()
	ctl.stop()
	select {
	case ctl.decide <- BatchDecisionEnd:
	default:
	}
	b.publish(run)
	return run, nil
}

// Decide is the developer's answer on a stopped PR: try it again, merge it despite its warnings, skip it, or end.
func (b *BatchRunner) Decide(req BatchDecideRequest) (BatchRun, error) {
	switch req.Decision {
	case BatchDecisionRetry, BatchDecisionOverride, BatchDecisionSkip, BatchDecisionEnd:
	default:
		return BatchRun{}, fmt.Errorf("decision must be retry, override, skip or end")
	}
	ctl, err := b.ctlFor(req.Dir, req.Id)
	if err != nil {
		return BatchRun{}, err
	}
	run := b.read(ctl)
	if run.State != BatchPaused {
		return run, uimsg.Errorf(uimsg.Make("review.batchnotstopped"), "the batch merge is not waiting for a decision")
	}
	select {
	case ctl.decide <- req.Decision:
	default:
	}
	return run, nil
}

// Dismiss hides an ended run's banner.
func (b *BatchRunner) Dismiss(req BatchRequest) (*BatchRun, error) {
	if err := checkDir(req.Dir); err != nil {
		return nil, err
	}
	if ctl := b.ctlOf(req.Dir); ctl != nil {
		b.lock.Lock()
		active := ctl.run.active()
		b.lock.Unlock()
		if active {
			return nil, uimsg.Errorf(uimsg.Make("review.batchrunning"), "a batch merge already runs in this project")
		}
		run := b.change(ctl, func(run *BatchRun) { run.Dismissed = true })
		return &run, nil
	}
	run, ok := b.load(req.Dir)
	if !ok {
		return nil, nil
	}
	run.Dismissed = true
	b.publish(run)
	return &run, nil
}

func (s *Service) handleBatch(command string, data any) (any, error) {
	if s.batch == nil {
		return nil, fmt.Errorf("the batch merge is not available")
	}
	switch command {
	case BatchStartCommand:
		req, err := decode[BatchStartRequest](data)
		if err != nil {
			return nil, err
		}
		return s.batch.Start(req)
	case BatchDecideCommand:
		req, err := decode[BatchDecideRequest](data)
		if err != nil {
			return nil, err
		}
		return s.batch.Decide(req)
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

// wait returns when the project's run has ended (tests).
func (b *BatchRunner) wait(dir string) {
	ctl := b.ctlOf(dir)
	if ctl != nil {
		<-ctl.done
	}
}
