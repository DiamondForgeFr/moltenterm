// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// Clean up on a leftover whose worktree a live process holds (#1143, FR-REV-022 AC16, FR-REV-013 AC10). MoltenTerm
// never unlocks or removes that worktree: it asks its owner. wavesrv reads the lock again (never trusting the window),
// names the owner (mission.LiveLockOwner) and sends it MoltenTerm's own fixed request through the handoffs
// (agenthandoff.SendFromApp: typed when its prompt is idle, any agentic CLI). The developer's click is the approval.
// The request is then followed: the worktree gone, it is done; the owner waiting for an answer, ending its turn with the
// worktree still there, or writing a "needs you:" outcome line, it needs the developer, who is taken to the owner's
// terminal. Every request is logged. The requests live in memory, for the app session.

const (
	LeftoverAskCommand  = "moltenleftoverask"
	LeftoverAsksCommand = "moltenleftoverasks"
	// LeftoverAskEvent: a project's requests changed (scope: the project's folder).
	LeftoverAskEvent = "molten:leftover:ask"

	LeftoverAskAsked    = "asked"
	LeftoverAskNeedsYou = "needsyou"
	LeftoverAskDone     = "done"
	// LeftoverAskUnreachable: no MoltenTerm terminal runs the owner; nothing is sent, nothing is kept.
	LeftoverAskUnreachable = "unreachable"
	// LeftoverAskFree: the lock is no longer a live process's (it ended or was lifted): the usual cleanup applies.
	LeftoverAskFree = "free"

	// Why the owner needs the developer: waiting for an answer, its turn ended with the worktree there, or its line.
	LeftoverWhyQuestion = "question"
	LeftoverWhyStopped  = "stopped"
	LeftoverWhyOutcome  = "outcome"

	leftoverFollowEvery = 2 * time.Second
	// An idle owner whose prompt the queue may not have typed yet is read again after this.
	leftoverSettle = 4 * time.Second
	// A request nobody resolves is dropped after this.
	leftoverAskLife    = 24 * time.Hour
	leftoverDoneLinger = 2 * time.Minute
	leftoverAskTimeout = 30 * time.Second
)

// LeftoverAskRequest: the developer's Clean up on a leftover card whose worktree a live process holds.
type LeftoverAskRequest struct {
	Dir      string `json:"dir"`
	Repo     string `json:"repo,omitempty"`
	Number   int    `json:"number"`
	Url      string `json:"url,omitempty"`
	Worktree string `json:"worktree"`
	// Closed: the PR was closed without merging, its content being on Base.
	Closed bool   `json:"closed,omitempty"`
	Base   string `json:"base,omitempty"`
	// Local: the worktree's branch is one of the leftovers to delete.
	Local bool `json:"local,omitempty"`
}

// LeftoverAsk is one request and where it stands. Reason: the owner's outcome line (its "needs you:" prefix cut).
type LeftoverAsk struct {
	Dir      string                `json:"dir"`
	Number   int                   `json:"number"`
	Worktree string                `json:"worktree"`
	Branch   string                `json:"branch,omitempty"`
	Owner    mission.LeftoverOwner `json:"owner"`
	State    string                `json:"state"`
	Why      string                `json:"why,omitempty"`
	Reason   string                `json:"reason,omitempty"`
	Delivery string                `json:"delivery,omitempty"`
	AskedAt  int64                 `json:"askedat"`
	EndedAt  int64                 `json:"endedat,omitempty"`
}

type LeftoverAsksRequest struct {
	Dir string `json:"dir"`
}

type LeftoverAsksAnswer struct {
	Dir  string        `json:"dir"`
	Asks []LeftoverAsk `json:"asks"`
}

// LeftoverAskEnv is what the requests reach; the tests give fakes.
type LeftoverAskEnv struct {
	Owner    func(ctx context.Context, dir string, path string) (mission.LeftoverOwner, mission.LinkedTree, error)
	Tree     func(ctx context.Context, dir string, path string) (mission.LinkedTree, bool, error)
	Send     func(ctx context.Context, req agenthandoff.AppRequest) (agenthandoff.AppSent, error)
	AgentRun func(blockId string) (molten.AgentRunInfo, bool)
	Publish  func(answer LeftoverAsksAnswer)
	Now      func() time.Time
	// FollowEvery: how often a request is read again; 0 (the tests): nothing runs on its own, Step does.
	FollowEvery time.Duration
	Logf        func(format string, args ...any)
}

type leftoverAsk struct {
	LeftoverAsk
	outcomePath string
	// armed: the request reached the owner's prompt (delivered, or the queue's idle prompt was seen since);
	// working: the owner worked since; idleAt: when it was last seen idle.
	armed   bool
	working bool
	idleAt  time.Time
}

type LeftoverAsks struct {
	env  LeftoverAskEnv
	lock sync.Mutex
	asks map[string]*leftoverAsk
}

func MakeLeftoverAsks(env LeftoverAskEnv) *LeftoverAsks {
	if env.Now == nil {
		env.Now = time.Now
	}
	if env.Logf == nil {
		env.Logf = log.Printf
	}
	return &LeftoverAsks{env: env, asks: map[string]*leftoverAsk{}}
}

func leftoverAskKey(dir string, worktree string) string {
	return filepath.Clean(dir) + "\x00" + filepath.Clean(worktree)
}

// leftoverRequestText is MoltenTerm's fixed request: nothing in it comes from a page, a file or the window but the
// facts wavesrv checked (the worktree and its branch from git, the PR's number, state and base).
func leftoverRequestText(req LeftoverAskRequest, tree mission.LinkedTree, owner mission.LeftoverOwner) (string, string) {
	pr := fmt.Sprintf("pull request #%d (merged)", req.Number)
	if req.Closed {
		pr = fmt.Sprintf("pull request #%d (closed without merging; its content is already on %s)", req.Number, req.Base)
	}
	var goal strings.Builder
	fmt.Fprintf(&goal, "The developer asked MoltenTerm to clean up what %s left: the worktree %s", pr, tree.Path)
	if tree.Branch != "" {
		fmt.Fprintf(&goal, " on the branch %s", tree.Branch)
	}
	fmt.Fprintf(&goal, ". Its git lock names your process (pid %d), so MoltenTerm will not remove it: only you may, after "+
		"your own check.\n\n", owner.Pid)
	goal.WriteString("1. Check that removing it loses nothing: no uncommitted change, no commit that is not on the base, " +
		"no work of yours or of a sub-agent still running in it.\n")
	fmt.Fprintf(&goal, "2. If nothing would be lost, remove it from the project folder %s: `git worktree unlock %s`, then "+
		"`git worktree remove %s`", req.Dir, tree.Path, tree.Path)
	if req.Local && tree.Branch != "" {
		fmt.Fprintf(&goal, ", then `git branch -d %s`", tree.Branch)
	}
	goal.WriteString(".\n3. If something would be lost, or you still need it, leave everything as it is and say why.\n")
	goal.WriteString("\nDo not force anything (no --force, no -D) and touch no other worktree or branch.")
	context := fmt.Sprintf("Project: %s.", req.Dir)
	if req.Url != "" {
		context += fmt.Sprintf(" Pull request: %s.", req.Url)
	}
	context += " MoltenTerm sees the worktree go and tells the developer; if you stop for them, they come to your terminal."
	return goal.String(), context
}

// Ask asks the owner of the leftover's worktree to check and remove it, once per worktree while a request stands.
func (a *LeftoverAsks) Ask(ctx context.Context, req LeftoverAskRequest) (LeftoverAsk, error) {
	if err := checkDir(req.Dir); err != nil {
		return LeftoverAsk{}, err
	}
	if req.Number <= 0 || req.Worktree == "" || !filepath.IsAbs(req.Worktree) {
		return LeftoverAsk{}, fmt.Errorf("number and worktree must name the leftover")
	}
	if req.Closed && !reviewsession.ValidRef(req.Base) {
		return LeftoverAsk{}, fmt.Errorf("base must name the closed PR's base")
	}
	key := leftoverAskKey(req.Dir, req.Worktree)
	if have := a.current(key); have != nil && (have.State == LeftoverAskAsked || have.State == LeftoverAskNeedsYou) {
		return *have, nil
	}
	owner, tree, err := a.env.Owner(ctx, req.Dir, req.Worktree)
	switch {
	case err == mission.ErrLockNotLive || err == mission.ErrTreeNotLinked:
		return LeftoverAsk{Dir: req.Dir, Number: req.Number, Worktree: req.Worktree, State: LeftoverAskFree}, nil
	case err != nil:
		return LeftoverAsk{}, err
	}
	ask := &leftoverAsk{LeftoverAsk: LeftoverAsk{Dir: req.Dir, Number: req.Number, Worktree: tree.Path, Branch: tree.Branch,
		Owner: owner, AskedAt: a.env.Now().UnixMilli()}}
	if !owner.Reachable() {
		ask.State = LeftoverAskUnreachable
		a.env.Logf("%s leftover %s#%d: %s is held by %s (pid %d) in %s, which MoltenTerm cannot ask\n", logPrefix, req.Dir,
			req.Number, tree.Path, orUnknown(owner.Process), owner.Pid, orUnknown(owner.Folder))
		return ask.LeftoverAsk, nil
	}
	goal, context := leftoverRequestText(req, tree, owner)
	sent, err := a.env.Send(ctx, agenthandoff.AppRequest{ToBlockId: owner.BlockId, Goal: goal, Context: context})
	if err != nil {
		a.env.Logf("%s leftover %s#%d: asking %s to remove %s failed: %v\n", logPrefix, req.Dir, req.Number,
			ownerName(owner), tree.Path, err)
		return LeftoverAsk{}, err
	}
	ask.State, ask.Delivery, ask.outcomePath = LeftoverAskAsked, sent.Status, sent.OutcomePath
	ask.armed = sent.Status == agenthandoff.StatusDelivered
	a.env.Logf("%s leftover %s#%d: asked %s (pid %d) to check and remove %s (%s); brief %s\n", logPrefix, req.Dir,
		req.Number, ownerName(owner), owner.Pid, tree.Path, sent.Status, sent.BriefPath)
	rtn := a.keep(key, ask)
	a.follow(key)
	return rtn, nil
}

func orUnknown(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

func ownerName(o mission.LeftoverOwner) string {
	if name := molten.AgentCallName(o.FirstName, o.Agent); name != "" {
		return name
	}
	return "the agent"
}

func (a *LeftoverAsks) current(key string) *LeftoverAsk {
	a.lock.Lock()
	defer a.lock.Unlock()
	if ask := a.asks[key]; ask != nil {
		copied := ask.LeftoverAsk
		return &copied
	}
	return nil
}

func (a *LeftoverAsks) keep(key string, ask *leftoverAsk) LeftoverAsk {
	a.lock.Lock()
	a.asks[key] = ask
	rtn := ask.LeftoverAsk
	a.lock.Unlock()
	a.publish(ask.Dir)
	return rtn
}

// List gives the project's requests, oldest first.
func (a *LeftoverAsks) List(dir string) LeftoverAsksAnswer {
	a.lock.Lock()
	defer a.lock.Unlock()
	rtn := LeftoverAsksAnswer{Dir: dir, Asks: []LeftoverAsk{}}
	for _, ask := range a.asks {
		if filepath.Clean(ask.Dir) == filepath.Clean(dir) {
			rtn.Asks = append(rtn.Asks, ask.LeftoverAsk)
		}
	}
	sort.Slice(rtn.Asks, func(i, j int) bool { return rtn.Asks[i].AskedAt < rtn.Asks[j].AskedAt })
	return rtn
}

func (a *LeftoverAsks) publish(dir string) {
	if a.env.Publish != nil {
		a.env.Publish(a.List(dir))
	}
}

func (a *LeftoverAsks) follow(key string) {
	if a.env.FollowEvery <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(a.env.FollowEvery)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), leftoverAskTimeout)
			more := a.Step(ctx, key)
			cancel()
			if !more {
				return
			}
		}
	}()
}

// snapshot copies the request under the lock, for a step to read it without holding the lock over git.
func (a *LeftoverAsks) snapshot(key string) (leftoverAsk, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	ask := a.asks[key]
	if ask == nil {
		return leftoverAsk{}, false
	}
	return *ask, true
}

// Step reads the request once; false when its follow ends.
func (a *LeftoverAsks) Step(ctx context.Context, key string) bool {
	ask, ok := a.snapshot(key)
	if !ok {
		return false
	}
	now := a.env.Now()
	if ask.State == LeftoverAskDone {
		if now.Sub(time.UnixMilli(ask.EndedAt)) > leftoverDoneLinger {
			a.drop(key, ask.Dir)
			return false
		}
		return true
	}
	if now.Sub(time.UnixMilli(ask.AskedAt)) > leftoverAskLife {
		a.drop(key, ask.Dir)
		return false
	}
	tree, found, err := a.env.Tree(ctx, ask.Dir, ask.Worktree)
	if err != nil {
		return true
	}
	next := ask
	if !found {
		next.State, next.Why, next.EndedAt = LeftoverAskDone, "", now.UnixMilli()
		a.env.Logf("%s leftover %s#%d: %s removed %s\n", logPrefix, ask.Dir, ask.Number, ownerName(ask.Owner), ask.Worktree)
		a.update(key, next)
		return true
	}
	run, running := a.env.AgentRun(ask.Owner.BlockId)
	running = running && run.Running
	if !running {
		// The owner's session ended: its lock ended with it, and the usual cleanup applies again.
		a.env.Logf("%s leftover %s#%d: %s ended, %s is still there\n", logPrefix, ask.Dir, ask.Number, ownerName(ask.Owner),
			ask.Worktree)
		a.drop(key, ask.Dir)
		return false
	}
	next.Branch = tree.Branch
	next = judge(next, run, readOutcome(ask.outcomePath), now)
	a.update(key, next)
	return true
}

// judge is where a live request stands from the owner's state and its outcome line.
func judge(ask leftoverAsk, run molten.AgentRunInfo, outcome string, now time.Time) leftoverAsk {
	busy := run.State == molten.AgentStateWorking || run.State == molten.AgentStateWaiting
	if !busy && !ask.armed {
		// The queue types a request at the owner's idle prompt: from here on its next turn is the request's.
		ask.armed = true
		ask.idleAt = now
		return ask
	}
	if run.State == molten.AgentStateWorking {
		if ask.armed {
			ask.working = true
		}
		ask.idleAt = time.Time{}
		ask.State, ask.Why, ask.Reason = LeftoverAskAsked, "", ""
		return ask
	}
	if run.State == molten.AgentStateWaiting && ask.armed {
		ask.State, ask.Why, ask.Reason = LeftoverAskNeedsYou, LeftoverWhyQuestion, ""
		if reason, ok := outcomeNeedsYou(outcome); ok {
			ask.Reason = reason
		}
		return ask
	}
	if !ask.armed {
		return ask
	}
	if outcome != "" {
		reason, ok := outcomeNeedsYou(outcome)
		if !ok {
			reason = outcome
		}
		ask.State, ask.Why, ask.Reason = LeftoverAskNeedsYou, LeftoverWhyOutcome, reason
		return ask
	}
	if ask.idleAt.IsZero() {
		ask.idleAt = now
	}
	if ask.working && now.Sub(ask.idleAt) >= leftoverSettle {
		ask.State, ask.Why, ask.Reason = LeftoverAskNeedsYou, LeftoverWhyStopped, ""
	}
	return ask
}

// update keeps a step's outcome and publishes it when what the window shows changed.
func (a *LeftoverAsks) update(key string, next leftoverAsk) {
	a.lock.Lock()
	have := a.asks[key]
	if have == nil {
		a.lock.Unlock()
		return
	}
	changed := have.LeftoverAsk != next.LeftoverAsk
	*have = next
	a.lock.Unlock()
	if changed {
		if next.State == LeftoverAskNeedsYou {
			a.env.Logf("%s leftover %s#%d: %s needs the developer (%s): %s\n", logPrefix, next.Dir, next.Number,
				ownerName(next.Owner), next.Why, next.Reason)
		}
		a.publish(next.Dir)
	}
}

func (a *LeftoverAsks) drop(key string, dir string) {
	a.lock.Lock()
	delete(a.asks, key)
	a.lock.Unlock()
	a.publish(dir)
}
