// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"context"
	"fmt"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Env is what the keeper needs from wavesrv, injected so tests run without it.
type Env struct {
	Now    func() time.Time
	Policy func() string
	Work   func(ctx context.Context) Work
	// Workspace: the workspace's name, and whether it still exists.
	Workspace func(ctx context.Context, wsId string) (string, bool)
	// LocateNames: the workspace and tab of a terminal block, for the list.
	LocateNames  func(ctx context.Context, blockId string) (wsId string, wsName string, tabName string)
	Notify       func(input molten.NotificationInput)
	Publish      func(state State)
	ProcessAlive func(pid int32) bool
	ProcessName  func(pid int32) string
}

type coffeeRec struct {
	since   int64
	name    string
	working bool
	// graceStart: when the workspace's last work stopped (zero while it works).
	graceStart time.Time
}

// Keeper holds the state. Every change is published whole, so a window that missed an event catches up on the next.
type Keeper struct {
	lock    sync.Mutex
	env     Env
	coffees map[string]*coffeeRec
	policy  string
	// The Until work ends policy's own reason.
	policyHolding    bool
	policyWorking    bool
	policyGraceStart time.Time
	attempts         []Attempt
	overrides        map[string]*Override
	// asked: the ask-once notification went out in this run.
	asked     bool
	version   int64
	published State
	nextId    int64
}

func MakeKeeper(env Env) *Keeper {
	return &Keeper{env: env, coffees: map[string]*coffeeRec{}, overrides: map[string]*Override{}}
}

// computerName is what the messages call the computer: the coffee is about a Mac first (DS-SHELL-062).
func computerName() string {
	if runtime.GOOS == "darwin" {
		return "the Mac"
	}
	return "the computer"
}

func (k *Keeper) policyNow() string {
	if k.env.Policy == nil {
		return PolicyAsk
	}
	return CleanPolicy(k.env.Policy())
}

// SetCoffee turns a workspace's coffee on or off. A coffee turned on while nothing runs in the workspace starts in its
// grace; the evaluation that follows at once tells whether work runs.
func (k *Keeper) SetCoffee(ctx context.Context, wsId string, on bool) (State, error) {
	if wsId == "" {
		return k.State(), fmt.Errorf("no workspace given")
	}
	if on {
		name, exists := "", true
		if k.env.Workspace != nil {
			name, exists = k.env.Workspace(ctx, wsId)
		}
		if !exists {
			return k.State(), fmt.Errorf("workspace %s not found", wsId)
		}
		k.addCoffee(wsId, name)
	} else {
		k.removeCoffee(wsId)
	}
	k.Evaluate(ctx)
	return k.State(), nil
}

func (k *Keeper) addCoffee(wsId string, name string) {
	k.lock.Lock()
	defer k.lock.Unlock()
	if k.coffees[wsId] != nil {
		return
	}
	now := k.env.Now()
	k.coffees[wsId] = &coffeeRec{since: now.UnixMilli(), name: name, graceStart: now}
}

func (k *Keeper) removeCoffee(wsId string) {
	k.lock.Lock()
	defer k.lock.Unlock()
	delete(k.coffees, wsId)
}

// Shim decides a shim's block attempt and records it. The session's override wins over the global policy; with no
// policy set, the first attempt of the run raises the ask-once notification and the tool runs meanwhile.
func (k *Keeper) Shim(ctx context.Context, req ShimRequest) (ShimAnswer, error) {
	if !IsShimTool(req.Tool) {
		return ShimAnswer{Policy: PolicyAllow}, fmt.Errorf("unknown tool %q", req.Tool)
	}
	policy := k.policyNow()
	var wsId, wsName, tabName, parentName string
	if k.env.LocateNames != nil && req.BlockId != "" {
		wsId, wsName, tabName = k.env.LocateNames(ctx, req.BlockId)
	}
	if k.env.ProcessName != nil && req.ParentPid > 0 {
		parentName = k.env.ProcessName(req.ParentPid)
	}
	answer, ask := k.recordAttempt(req, policy, wsId, wsName, tabName, parentName)
	if ask && k.env.Notify != nil {
		k.env.Notify(askNotification(req.Tool, parentName, wsId, tabName))
	}
	k.publishIfChanged()
	return answer, nil
}

func (k *Keeper) recordAttempt(req ShimRequest, policy string, wsId string, wsName string, tabName string, parentName string) (ShimAnswer, bool) {
	k.lock.Lock()
	defer k.lock.Unlock()
	effective := policy
	override := k.overrides[req.BlockId]
	if override != nil {
		effective = override.Policy
	}
	answer := ShimAnswer{Policy: ShimPolicy(effective)}
	outcome := OutcomeAllowed
	if answer.Policy == PolicyLetSleep {
		outcome = OutcomeNeutralised
	}
	k.nextId++
	args := req.Args
	if len(args) > 16 {
		args = args[:16]
	}
	k.attempts = append(k.attempts, Attempt{
		Id: strconv.FormatInt(k.nextId, 10), BlockId: req.BlockId, WorkspaceId: wsId, WorkspaceName: wsName,
		TabName: tabName, Tool: req.Tool, Args: args, Pid: req.Pid, ParentPid: req.ParentPid, ParentName: parentName,
		Since: k.env.Now().UnixMilli(), Outcome: outcome,
	})
	if len(k.attempts) > MaxAttempts {
		k.attempts = k.attempts[len(k.attempts)-MaxAttempts:]
	}
	if override != nil {
		override.WorkspaceId, override.WorkspaceName, override.TabName = wsId, wsName, tabName
	}
	ask := policy == PolicyAsk && override == nil && !k.asked
	if ask {
		k.asked = true
	}
	return answer, ask
}

func askNotification(tool string, parentName string, wsId string, tabName string) molten.NotificationInput {
	who := "A program"
	if parentName != "" {
		who = parentName
	}
	where := ""
	if tabName != "" {
		where = " in " + tabName
	}
	message := fmt.Sprintf("%s%s ran %s to keep %s awake. Choose once what MoltenTerm does with such requests: let "+
		"them through, keep %s awake itself until the work ends (2 minutes after the last agent, command or Mission "+
		"Control run), or let it sleep.", who, where, tool, computerName(), computerName())
	action := func(id string, label string, policy string) molten.NotificationAction {
		return molten.NotificationAction{Id: id, Label: label, Kind: "gesture", Gesture: PolicyGesture, Args: map[string]any{"policy": policy}}
	}
	return molten.NotificationInput{
		Key:         AskNotificationKey,
		Source:      NotificationSource,
		Title:       "A terminal wants to keep " + computerName() + " awake",
		Message:     message,
		Kind:        "warning",
		WorkspaceId: wsId,
		Actions: []molten.NotificationAction{
			action("allow", "Allow", PolicyAllow),
			action("untilworkends", "Until work ends", PolicyUntilWorkEnds),
			action("letsleep", "Let it sleep", PolicyLetSleep),
		},
	}
}

// SetOverride sets or removes a session's own policy.
func (k *Keeper) SetOverride(ctx context.Context, req OverrideRequest) (State, error) {
	if req.BlockId == "" {
		return k.State(), fmt.Errorf("no terminal given")
	}
	if req.Policy != "" && !ValidOverride(req.Policy) {
		return k.State(), fmt.Errorf("a session's policy is %q or %q", PolicyAllow, PolicyLetSleep)
	}
	var wsId, wsName, tabName string
	if req.Policy != "" && k.env.LocateNames != nil {
		wsId, wsName, tabName = k.env.LocateNames(ctx, req.BlockId)
	}
	k.applyOverride(req, wsId, wsName, tabName)
	k.publishIfChanged()
	return k.State(), nil
}

func (k *Keeper) applyOverride(req OverrideRequest, wsId string, wsName string, tabName string) {
	k.lock.Lock()
	defer k.lock.Unlock()
	if req.Policy == "" {
		delete(k.overrides, req.BlockId)
		return
	}
	k.overrides[req.BlockId] = &Override{BlockId: req.BlockId, WorkspaceId: wsId, WorkspaceName: wsName, TabName: tabName, Policy: req.Policy}
}

// ForgetBlock ends what belongs to a closed terminal: its override and its attempts.
func (k *Keeper) ForgetBlock(blockId string) {
	k.forgetBlockLocked(blockId)
	k.publishIfChanged()
}

func (k *Keeper) forgetBlockLocked(blockId string) {
	k.lock.Lock()
	defer k.lock.Unlock()
	delete(k.overrides, blockId)
	kept := k.attempts[:0]
	for _, a := range k.attempts {
		if a.BlockId != blockId {
			kept = append(kept, a)
		}
	}
	k.attempts = kept
}

// NeedsWork tells whether an evaluation must look at what runs: a coffee is on, or the policy is Until work ends.
func (k *Keeper) NeedsWork() bool {
	policy := k.policyNow()
	k.lock.Lock()
	defer k.lock.Unlock()
	return policy == PolicyUntilWorkEnds || len(k.coffees) > 0 || k.policyHolding
}

type coffeeCheck struct {
	name   string
	exists bool
}

// Evaluate applies the rules now: each coffee and the policy's reason follow the work, end after their grace with one
// notification each, and a coffee whose workspace was deleted ends without one. Attempts whose process exited go.
func (k *Keeper) Evaluate(ctx context.Context) {
	policy := k.policyNow()
	ids, pids := k.snapshotIds()
	var work Work
	if (policy == PolicyUntilWorkEnds || len(ids) > 0) && k.env.Work != nil {
		work = k.env.Work(ctx)
	}
	checks := map[string]coffeeCheck{}
	for _, id := range ids {
		check := coffeeCheck{exists: true}
		if k.env.Workspace != nil {
			check.name, check.exists = k.env.Workspace(ctx, id)
		}
		checks[id] = check
	}
	dead := map[int32]bool{}
	if k.env.ProcessAlive != nil {
		for _, pid := range pids {
			if !k.env.ProcessAlive(pid) {
				dead[pid] = true
			}
		}
	}
	notices := k.apply(policy, work, checks, dead)
	if k.env.Notify != nil {
		for _, n := range notices {
			k.env.Notify(n)
		}
	}
	k.publishIfChanged()
}

func (k *Keeper) snapshotIds() ([]string, []int32) {
	k.lock.Lock()
	defer k.lock.Unlock()
	ids := make([]string, 0, len(k.coffees))
	for id := range k.coffees {
		ids = append(ids, id)
	}
	pids := make([]int32, 0, len(k.attempts))
	for _, a := range k.attempts {
		pids = append(pids, a.Pid)
	}
	return ids, pids
}

func (k *Keeper) apply(policy string, work Work, checks map[string]coffeeCheck, dead map[int32]bool) []molten.NotificationInput {
	k.lock.Lock()
	defer k.lock.Unlock()
	now := k.env.Now()
	var notices []molten.NotificationInput
	for id, check := range checks {
		rec := k.coffees[id]
		if rec == nil {
			continue
		}
		if !check.exists {
			delete(k.coffees, id)
			continue
		}
		if check.name != "" {
			rec.name = check.name
		}
		if work.Workspaces[id] {
			rec.working = true
			rec.graceStart = time.Time{}
			continue
		}
		if rec.working || rec.graceStart.IsZero() {
			rec.working = false
			rec.graceStart = now
		}
		if now.Sub(rec.graceStart) >= GracePeriod {
			delete(k.coffees, id)
			notices = append(notices, coffeeEndNotice(id, rec.name))
		}
	}
	k.policy = policy
	if policy != PolicyUntilWorkEnds {
		k.policyHolding, k.policyWorking, k.policyGraceStart = false, false, time.Time{}
	} else if work.Local {
		k.policyHolding, k.policyWorking, k.policyGraceStart = true, true, time.Time{}
	} else if k.policyHolding {
		if k.policyWorking || k.policyGraceStart.IsZero() {
			k.policyWorking = false
			k.policyGraceStart = now
		}
		if now.Sub(k.policyGraceStart) >= GracePeriod {
			k.policyHolding, k.policyGraceStart = false, time.Time{}
			notices = append(notices, policyEndNotice())
		}
	}
	if len(dead) > 0 {
		kept := k.attempts[:0]
		for _, a := range k.attempts {
			if !dead[a.Pid] {
				kept = append(kept, a)
			}
		}
		k.attempts = kept
	}
	return notices
}

func coffeeEndNotice(wsId string, name string) molten.NotificationInput {
	if name == "" {
		name = "A workspace"
	}
	return molten.NotificationInput{
		Source:      NotificationSource,
		Title:       fmt.Sprintf("%s: work finished, %s may sleep again", name, computerName()),
		Message:     "Its coffee ended 2 minutes after the last work in the workspace stopped.",
		Kind:        noticeKindInfo,
		WorkspaceId: wsId,
	}
}

func policyEndNotice() molten.NotificationInput {
	return molten.NotificationInput{
		Source:  NotificationSource,
		Title:   fmt.Sprintf("Work finished: %s may sleep again", computerName()),
		Message: "Until work ends kept it awake while work ran; MoltenTerm released its block 2 minutes after the last work stopped.",
		Kind:    noticeKindInfo,
	}
}

// State is the current state, as published.
func (k *Keeper) State() State {
	k.lock.Lock()
	defer k.lock.Unlock()
	state := k.buildLocked()
	state.Version = k.version
	return state
}

func (k *Keeper) buildLocked() State {
	state := State{
		Policy:        k.policy,
		PolicyHolding: k.policyHolding,
		PolicyWorking: k.policyHolding && k.policyWorking,
		Coffees:       []Coffee{},
		Attempts:      append([]Attempt{}, k.attempts...),
		Overrides:     []Override{},
	}
	if k.policyHolding && !k.policyWorking && !k.policyGraceStart.IsZero() {
		state.PolicyEndsAt = k.policyGraceStart.Add(GracePeriod).UnixMilli()
	}
	for id, rec := range k.coffees {
		c := Coffee{WorkspaceId: id, WorkspaceName: rec.name, Since: rec.since, Working: rec.working}
		if !rec.working && !rec.graceStart.IsZero() {
			c.EndsAt = rec.graceStart.Add(GracePeriod).UnixMilli()
		}
		state.Coffees = append(state.Coffees, c)
	}
	sort.Slice(state.Coffees, func(i, j int) bool {
		if state.Coffees[i].Since != state.Coffees[j].Since {
			return state.Coffees[i].Since < state.Coffees[j].Since
		}
		return state.Coffees[i].WorkspaceId < state.Coffees[j].WorkspaceId
	})
	for _, o := range k.overrides {
		state.Overrides = append(state.Overrides, *o)
	}
	sort.Slice(state.Overrides, func(i, j int) bool { return state.Overrides[i].BlockId < state.Overrides[j].BlockId })
	state.Hold = state.PolicyHolding || len(state.Coffees) > 0
	return state
}

// publishIfChanged publishes the state when it differs from the last one published, with a new version.
func (k *Keeper) publishIfChanged() {
	state, changed := k.takeChange()
	if !changed || k.env.Publish == nil {
		return
	}
	k.env.Publish(state)
}

func (k *Keeper) takeChange() (State, bool) {
	k.lock.Lock()
	defer k.lock.Unlock()
	state := k.buildLocked()
	last := k.published
	last.Version = 0
	if k.version > 0 && reflect.DeepEqual(state, last) {
		return State{}, false
	}
	k.version++
	k.published = state
	state.Version = k.version
	return state, true
}
