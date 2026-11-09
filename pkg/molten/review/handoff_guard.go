// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The hand-off guard (#2145, FR-REV-022 AC22). A card sends what it read of the PR: its head, a conflict, the red
// checks. The list that card came from can be minutes behind GitHub (the minute-long cache, GitHub computing the
// mergeability after a push), and a click on Resume or Ask for a rebase then sent the lead agent a brief about a state
// the PR no longer had, five times in six minutes. So wavesrv never believes the card: before a task of the Integration
// panel is typed, sent or started it reads the PR on GitHub, once.
//
//   - the PR is not open, its head is not the card's, or every problem the card asked about is gone: nothing is sent,
//     the result says so (RestartStale) with the head GitHub has, and the list reads the PR again (PushSeen);
//   - otherwise the task goes with the current head, naming only the problems that remain;
//   - the same task for the same PR and head, while the hand-off it already got is handled, sends nothing more and says
//     who has it (RestartBusy, RestartReasonAlreadyHanded).
//
// GitHub not answering is not a verdict on the PR: the task goes as the card asked.

const (
	// RestartStale: the PR is not what the card said, so nothing was sent; Reason says how and Head is the PR's head.
	RestartStale = "stale"

	RestartReasonHeadMoved   = "headmoved"
	RestartReasonProblemGone = "problemgone"
	RestartReasonPrClosed    = "prclosed"
	// RestartReasonAlreadyHanded: the same task is already handled on this head; FirstName or AgentName says by whom.
	RestartReasonAlreadyHanded = "alreadyhanded"

	// The tasks of the Integration panel that hand work to an agent.
	HandoffRebase      = "rebase"
	HandoffInvestigate = "investigate"
	HandoffFinish      = "finish"

	// A hand-off counts as handled for this long whatever the agent shows (it takes a moment to start on it, a lead
	// acknowledges and delegates), then for as long as the agent that took it works or waits. It matches the card's own
	// grace before it calls a task stopped (reviews-task-model.ts StuckGraceMs).
	handedWindow = 2 * time.Minute
	// handedKeep: how long a hand-off is remembered at all.
	handedKeep = 12 * time.Hour

	guardTimeout = 30 * time.Second
	guardFields  = "state,isDraft,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"
)

// handoffCovers: a hand-off of a task also covers the tasks it includes, so a rebase asked right after Resume (whose
// brief asks for the rebase too) is not sent again.
var handoffCovers = map[string][]string{
	HandoffRebase:      {HandoffRebase, HandoffInvestigate, HandoffFinish},
	HandoffInvestigate: {HandoffInvestigate, HandoffFinish},
	HandoffFinish:      {HandoffFinish},
}

type handedKey struct {
	PrKey
	kind string
	head string
}

type handedTask struct {
	at        time.Time
	blockId   string
	firstName string
	agentName string
	// queued: the request waits for its receiver's prompt (RestartQueued); it is handled until it leaves the queue.
	queued bool
}

// handoffTask is what a request MoltenTerm types to a lead is about, carried by the context of the click: the task, the
// PR and the head the card knew, and whether the problems it names remain on the PR. A request that waits for the
// lead's prompt asks it before it is typed and before it is said to have expired (agenthandoff.AppRequest.Applies).
type handoffTask struct {
	kind string
	req  RestartRequest
	head string
	// remains: some problem the request names is still on the PR; nil when the request names none.
	remains func(now prNow) bool
	// resend: the notification action that asks the same task again, from the card's own flow.
	resend *molten.NotificationAction
}

type handoffTaskKey struct{}

func withTask(ctx context.Context, task *handoffTask) context.Context {
	return context.WithValue(ctx, handoffTaskKey{}, task)
}

func taskOf(ctx context.Context) *handoffTask {
	task, _ := ctx.Value(handoffTaskKey{}).(*handoffTask)
	return task
}

// ResendGesture asks a task of a PR again from its notification; must match
// frontend/moltenterm-shell/reviews/reviews-resend-gesture.ts.
const ResendGesture = "reviews:resend"

// resendAction is the calm notice's Resend: the card's own flow runs again with the PR as the list reads it then, so it
// is checked like a click (the PR open, its head, what remains).
func resendAction(kind string, req RestartRequest, markReady bool, lead *LeadRef) *molten.NotificationAction {
	args := map[string]any{"dir": req.Dir, "number": req.Number, "task": kind}
	if markReady {
		args["markready"] = true
	}
	if lead != nil {
		args["leadname"], args["leadagent"], args["leadblockid"] = lead.FirstName, lead.Agent, lead.BlockId
	}
	return &molten.NotificationAction{Id: "resend", Label: "Resend", LabelText: uimsg.Make("notif.review.resend"), Kind: "gesture",
		Gesture: ResendGesture, Lasting: true, Args: args}
}

// appRequest is the request MoltenTerm types to a lead: its brief, and what lets the handoffs keep it honest while it
// waits (#2145): one request per task, PR and head, dropped without a word once the PR is closed, moved on or fixed,
// and told calmly, with Resend, when it expired and still applies.
func (r *Restarter) appRequest(ctx context.Context, found agenthandoff.LeadFound, goal string, text string, closing string) agenthandoff.AppRequest {
	req := agenthandoff.AppRequest{ToBlockId: found.BlockId, Goal: goal, Context: text, Closing: closing}
	task := taskOf(ctx)
	if task == nil {
		return req
	}
	if isOid(task.head) {
		req.Key = fmt.Sprintf("%s|%s#%d|%s", task.kind, strings.ToLower(task.req.Repo), task.req.Number, strings.ToLower(task.head))
	}
	req.Applies = func(ctx context.Context) bool { return r.taskApplies(ctx, task) }
	req.Resend = task.resend
	return req
}

// taskApplies: the PR is still open at the head the request was written for and some problem it names remains. GitHub
// not answering proves nothing: the request keeps applying.
func (r *Restarter) taskApplies(ctx context.Context, task *handoffTask) bool {
	now := r.readPrNow(ctx, task.req.PrKey, task.req.Dir)
	if !now.read {
		return true
	}
	if now.state != "" && now.state != "OPEN" {
		return false
	}
	if isOid(task.head) && now.head != "" && !strings.EqualFold(now.head, task.head) {
		return false
	}
	return task.remains == nil || task.remains(now)
}

// prNow is the PR as GitHub has it now.
type prNow struct {
	// read: GitHub answered; false leaves every other field empty.
	read      bool
	state     string
	head      string
	draft     bool
	conflicts bool
	// computing: GitHub has not computed the mergeability yet (right after a push or a merge).
	computing bool
	behind    bool
	changes   bool
	// checks: each check's state (success, failure, pending, neutral), by name.
	checks map[string]string
}

type ghGuardPr struct {
	State             string          `json:"state"`
	IsDraft           bool            `json:"isDraft"`
	HeadRefOid        string          `json:"headRefOid"`
	Mergeable         string          `json:"mergeable"`
	MergeStateStatus  string          `json:"mergeStateStatus"`
	ReviewDecision    string          `json:"reviewDecision"`
	StatusCheckRollup json.RawMessage `json:"statusCheckRollup"`
}

func (r *Restarter) readPrNow(ctx context.Context, k PrKey, dir string) prNow {
	if r.env.Gh == nil {
		return prNow{}
	}
	ctx, cancel := context.WithTimeout(ctx, guardTimeout)
	defer cancel()
	out, err := r.env.Gh(ctx, dir, "pr", "view", strconv.Itoa(k.Number), "--json", guardFields, "--repo", k.Repo)
	if err != nil {
		log.Printf("%s %s#%d: the PR could not be read before a hand-off, it goes as the card asked: %v\n", logPrefix, k.Repo, k.Number, err)
		return prNow{}
	}
	var pr ghGuardPr
	if json.Unmarshal(out, &pr) != nil || (pr.State == "" && pr.HeadRefOid == "") {
		return prNow{}
	}
	now := prNow{read: true, state: strings.ToUpper(pr.State), head: pr.HeadRefOid, draft: pr.IsDraft,
		behind: strings.EqualFold(pr.MergeStateStatus, "BEHIND"), changes: strings.EqualFold(pr.ReviewDecision, "CHANGES_REQUESTED")}
	switch mission.ReviewConflictOf(pr.Mergeable, pr.MergeStateStatus) {
	case mission.ReviewConflictConflicting:
		now.conflicts = true
	case mission.ReviewConflictComputing:
		now.computing = true
	}
	if ci, err := mission.ParseReviewChecks(pr.StatusCheckRollup); err == nil {
		now.checks = map[string]string{}
		for _, c := range ci.Checks {
			now.checks[c.Name] = c.State
		}
	}
	return now
}

// stillRed: the check the card named as failed still fails. A check GitHub does not list, or a local CI status still
// pending (the local CI may have decided it since), is not proven fine: it stays.
func (n prNow) stillRed(name string) bool {
	state, ok := n.checks[name]
	if !ok {
		return true
	}
	switch state {
	case mission.ReviewCheckSuccess, mission.ReviewCheckNeutral:
		return false
	case mission.ReviewCheckPending:
		return IsLocalCiCheck(name)
	}
	return true
}

// needsRebase: the branch conflicts with its base or is behind it.
func (n prNow) needsRebase() bool {
	return n.conflicts || n.behind
}

func (r *Restarter) staleResult(k PrKey, dir string, branch string, reason string, cardHead string, now prNow) RestartResult {
	res := RestartResult{Status: RestartStale, Reason: reason, Branch: branch, Head: now.head}
	switch reason {
	case RestartReasonPrClosed:
		res.Message = fmt.Sprintf("PR #%d is no longer open: nothing was sent.", k.Number)
	case RestartReasonHeadMoved:
		res.Message = fmt.Sprintf("PR #%d moved on (its head is now %s, the card had %s): nothing was sent.", k.Number, shortHead(now.head), shortHead(cardHead))
	default:
		res.Message = fmt.Sprintf("What was asked about PR #%d is gone on GitHub (its head is %s): nothing was sent.", k.Number, shortHead(now.head))
	}
	if r.env.PushSeen != nil {
		r.env.PushSeen(dir, branch, now.head)
	}
	return res
}

// guardPr reads the PR and refuses the hand-off of a card that does not know its head any more, or of a PR that is not
// open. A nil result lets the hand-off go on with the facts read (read false when GitHub did not answer).
func (r *Restarter) guardPr(ctx context.Context, k PrKey, dir string, branch string, cardHead string) (prNow, *RestartResult) {
	now := r.readPrNow(ctx, k, dir)
	if !now.read {
		return now, nil
	}
	if now.state != "" && now.state != "OPEN" {
		res := r.staleResult(k, dir, branch, RestartReasonPrClosed, cardHead, now)
		return now, &res
	}
	if isOid(cardHead) && now.head != "" && !strings.EqualFold(now.head, cardHead) {
		res := r.staleResult(k, dir, branch, RestartReasonHeadMoved, cardHead, now)
		return now, &res
	}
	return now, nil
}

// handedAlready: the same task, or one that includes it, was handed over for this head and is still handled.
func (r *Restarter) handedAlready(kind string, k PrKey, head string) (RestartResult, bool) {
	if !isOid(head) {
		return RestartResult{}, false
	}
	head = strings.ToLower(head)
	for _, covering := range handoffCovers[kind] {
		key := handedKey{k, covering, head}
		r.lock.Lock()
		task, ok := r.handed[key]
		r.lock.Unlock()
		if !ok {
			continue
		}
		if r.env.Now().Sub(task.at) >= handedWindow && !r.stillOnIt(task) {
			r.lock.Lock()
			delete(r.handed, key)
			r.lock.Unlock()
			continue
		}
		return r.alreadyResult(k, head, task), true
	}
	return RestartResult{}, false
}

func (r *Restarter) alreadyResult(k PrKey, head string, task handedTask) RestartResult {
	who := task.firstName
	if who == "" {
		who = task.agentName
	}
	text := who
	if text == "" {
		text = "An agent"
	}
	return RestartResult{Status: RestartBusy, Reason: RestartReasonAlreadyHanded, Head: head, HandedAt: task.at.UnixMilli(),
		BlockId: task.blockId, FirstName: task.firstName, AgentName: task.agentName,
		Message: fmt.Sprintf("%s already has this for PR #%d at %s: nothing more was sent.", text, k.Number, shortHead(head))}
}

// stillOnIt: the agent that took the hand-off works on it, or waits for the developer's answer.
func (r *Restarter) stillOnIt(task handedTask) bool {
	if task.blockId == "" {
		return false
	}
	if task.queued && r.env.HandoffQueued != nil && r.env.HandoffQueued(task.blockId) {
		return true
	}
	run, ok := r.agentRunOf(task.blockId)
	return ok && run.Running && (run.State == molten.AgentStateWorking || run.State == molten.AgentStateWaiting)
}

// noteHanded keeps a hand-off that reached an agent (typed, sent, queued for its prompt, or started with it).
func (r *Restarter) noteHanded(kind string, k PrKey, head string, res RestartResult) {
	switch res.Status {
	case RestartSent, RestartTyped, RestartQueued, RestartStarted:
	default:
		return
	}
	if !isOid(head) {
		return
	}
	now := r.env.Now()
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.handed == nil {
		r.handed = map[handedKey]handedTask{}
	}
	for key, task := range r.handed {
		if now.Sub(task.at) >= handedKeep {
			delete(r.handed, key)
		}
	}
	r.handed[handedKey{k, kind, strings.ToLower(head)}] = handedTask{at: now, blockId: res.BlockId, firstName: res.FirstName,
		agentName: res.AgentName, queued: res.Status == RestartQueued}
}

// pushSeen tells the Integration list that a followed agent pushed its branch.
func (r *Restarter) pushSeen(dir string, branch string, oid string) {
	if r.env.PushSeen != nil {
		r.env.PushSeen(dir, branch, oid)
	}
}
