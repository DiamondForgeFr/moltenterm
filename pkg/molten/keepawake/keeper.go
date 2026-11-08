// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package keepawake

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Env is what the keeper needs from wavesrv, injected so tests run without it.
type Env struct {
	Now func() time.Time
	// Config: the power:* settings; nil reads as DefaultConfig.
	Config func() Config
	Work   func(ctx context.Context) Work
	// Workspace: the workspace's name, and whether it still exists.
	Workspace func(ctx context.Context, wsId string) (string, bool)
	// LocateNames: the workspace and tab of a terminal block, for the list.
	LocateNames  func(ctx context.Context, blockId string) (wsId string, wsName string, tabName string)
	Notify       func(input molten.NotificationInput)
	Publish      func(state State)
	ProcessAlive func(pid int32) bool
	ProcessName  func(pid int32) string
	// Terminate asks a process to end (SIGTERM where signals exist).
	Terminate func(pid int32) error
	// Async runs work that must not hold a shim's answer; nil runs it at once (tests).
	Async func(fn func())
	// Sessions: the agent sessions of these workspaces, and whether their prompts are answered (FR-SHELL-063).
	Sessions func(ctx context.Context, wsIds []string) []AutoApproveSession
	// LogApproval appends a coffee approval's decision to the log file.
	LogApproval func(a Approval)
}

const (
	// An answer this close to the shim's deadline may arrive late: the shim then runs the real tool.
	shimAnswerMargin = 50 * time.Millisecond
	completeTimeout  = 3 * time.Second
	maxAttemptArgs   = 16
	maxAttemptArgLen = 200
)

type coffeeRec struct {
	since   int64
	name    string
	working bool
	// graceStart: when the workspace's last work stopped, or when the coffee was turned on with nothing running (zero
	// while it works). The coffee never ends by it; the approvals' window does (CoffeeCovers).
	graceStart time.Time
	reasons    []string
}

// Keeper holds the state. Every change is published whole, so a window that missed an event catches up on the next.
type Keeper struct {
	lock    sync.Mutex
	env     Env
	coffees map[string]*coffeeRec
	// cfg: the configuration of the last evaluation or shim request.
	cfg Config
	// Automatic's own reason.
	autoHolding    bool
	autoWorking    bool
	autoGraceStart time.Time
	autoReasons    []string
	attempts       []Attempt
	overrides      map[string]*Override
	// asked: the ask-once notification went out in this run.
	asked     bool
	version   int64
	published State
	nextId    int64
	// The coffee approvals (approve.go): decisions, oldest first, and the sessions the coffees cover.
	approvals   []Approval
	autoApprove []AutoApproveSession
}

func MakeKeeper(env Env) *Keeper {
	return &Keeper{env: env, coffees: map[string]*coffeeRec{}, overrides: map[string]*Override{}}
}

// computerName is what the messages call the computer: never the machine brand or the OS (#628).
func computerName() string {
	return "this computer"
}

func (k *Keeper) configNow() Config {
	if k.env.Config == nil {
		return DefaultConfig()
	}
	cfg := k.env.Config()
	cfg.Requests = CleanRequests(cfg.Requests)
	if cfg.Grace <= 0 {
		cfg.Grace = DefaultGrace
	}
	return cfg
}

// SetCoffee turns a workspace's coffee (its Manual switch) on or off. A coffee turned on while nothing runs in the
// workspace starts in its grace, which only matters to the approvals; the evaluation that follows at once tells whether
// work runs.
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

// Shim decides a shim's block attempt and records it. The session's override wins over the terminal requests setting;
// with it unset, the first attempt of the run raises the ask-once notification and the tool runs meanwhile.
//
// The answer comes from memory only (the setting, the session's override): the shim's caller waits for it
// (NFR-SHELL-009, under 50 ms). Where the session is, the parent's name, the notification and the publish follow off
// that path. An answer that would reach the shim after its deadline is recorded as allowed: the shim has run the real
// tool by then.
func (k *Keeper) Shim(ctx context.Context, req ShimRequest) (ShimAnswer, error) {
	if !IsShimTool(req.Tool) {
		return ShimAnswer{Policy: PolicyAllow}, fmt.Errorf("unknown tool %q", req.Tool)
	}
	cfg := k.configNow()
	late := req.Deadline > 0 && k.env.Now().UnixMilli() > req.Deadline-shimAnswerMargin.Milliseconds()
	answer, id, ask := k.recordAttempt(req, cfg, late)
	k.async(func() { k.completeAttempt(id, req, ask) })
	return answer, nil
}

func (k *Keeper) async(fn func()) {
	if k.env.Async == nil {
		fn()
		return
	}
	k.env.Async(fn)
}

// completeAttempt names the attempt's session and parent, raises the ask-once notification and publishes.
func (k *Keeper) completeAttempt(id string, req ShimRequest, ask bool) {
	ctx, cancel := context.WithTimeout(context.Background(), completeTimeout)
	defer cancel()
	var wsId, wsName, tabName, parentName string
	if k.env.LocateNames != nil && req.BlockId != "" {
		wsId, wsName, tabName = k.env.LocateNames(ctx, req.BlockId)
	}
	if k.env.ProcessName != nil && req.ParentPid > 0 {
		parentName = k.env.ProcessName(req.ParentPid)
	}
	k.nameAttempt(id, req.BlockId, wsId, wsName, tabName, parentName)
	if ask && k.env.Notify != nil {
		k.env.Notify(askNotification(req.Tool, parentName, wsId, tabName))
	}
	k.publishIfChanged()
}

func (k *Keeper) nameAttempt(id string, blockId string, wsId string, wsName string, tabName string, parentName string) {
	k.lock.Lock()
	defer k.lock.Unlock()
	for i := range k.attempts {
		if k.attempts[i].Id == id {
			a := &k.attempts[i]
			a.WorkspaceId, a.WorkspaceName, a.TabName, a.ParentName = wsId, wsName, tabName, parentName
		}
	}
	if override := k.overrides[blockId]; override != nil {
		override.WorkspaceId, override.WorkspaceName, override.TabName = wsId, wsName, tabName
	}
}

// clipArgs keeps what the list needs of a command line: a few arguments, each short.
func clipArgs(args []string) []string {
	if len(args) > maxAttemptArgs {
		args = args[:maxAttemptArgs]
	}
	rtn := make([]string, len(args))
	for i, arg := range args {
		if len(arg) > maxAttemptArgLen {
			arg = arg[:maxAttemptArgLen] + "…"
		}
		rtn[i] = arg
	}
	return rtn
}

func (k *Keeper) recordAttempt(req ShimRequest, cfg Config, late bool) (ShimAnswer, string, bool) {
	k.lock.Lock()
	defer k.lock.Unlock()
	effective := ShimPolicy(cfg.Requests)
	override := k.overrides[req.BlockId]
	if override != nil {
		effective = override.Policy
	}
	answer := ShimAnswer{Policy: effective}
	if late {
		answer.Policy = PolicyAllow
	}
	outcome := OutcomeAllowed
	if answer.Policy == PolicyLetSleep {
		outcome = OutcomeNeutralised
	}
	k.nextId++
	id := strconv.FormatInt(k.nextId, 10)
	now := k.env.Now()
	endsAt, stoppable := attemptLimits(req.Tool, req.Args, now)
	k.attempts = append(k.attempts, Attempt{
		Id: id, BlockId: req.BlockId, Tool: req.Tool, Args: clipArgs(req.Args), Pid: req.Pid, ParentPid: req.ParentPid,
		Since: now.UnixMilli(), Outcome: outcome, EndsAt: endsAt, Stoppable: stoppable,
	})
	if len(k.attempts) > MaxAttempts {
		k.attempts = k.attempts[len(k.attempts)-MaxAttempts:]
	}
	k.cfg = cfg
	ask := cfg.Requests == RequestsAsk && override == nil && !k.asked
	if ask {
		k.asked = true
	}
	return answer, id, ask
}

func askNotification(tool string, parentName string, wsId string, tabName string) molten.NotificationInput {
	who := "A program"
	if parentName != "" {
		who = parentName
	}
	where := ""
	if tabName != "" {
		where = " in " + wconfig.ViewNameText(tabName)
	}
	message := fmt.Sprintf("%s%s ran %s. Choose once what MoltenTerm does with such requests: let them through, keep "+
		"%s awake itself until the work ends, or let it sleep.", who, where, tool, computerName())
	var messageText *uimsg.Text
	switch {
	case parentName != "" && tabName != "":
		messageText = uimsg.Make("keepawake.notice.askparenttab", "who", parentName, "tab", tabName, "tool", tool)
	case parentName != "":
		messageText = uimsg.Make("keepawake.notice.askparent", "who", parentName, "tool", tool)
	case tabName != "":
		messageText = uimsg.Make("keepawake.notice.asktab", "tab", tabName, "tool", tool)
	default:
		messageText = uimsg.Make("keepawake.notice.ask", "tool", tool)
	}
	action := func(id string, label string, labelText *uimsg.Text, policy string) molten.NotificationAction {
		return molten.NotificationAction{Id: id, Label: label, LabelText: labelText, Kind: "gesture", Gesture: PolicyGesture, Args: map[string]any{"policy": policy}}
	}
	return molten.NotificationInput{
		Key:         AskNotificationKey,
		Source:      NotificationSource,
		Title:       "A terminal wants to keep " + computerName() + " awake",
		TitleText:   uimsg.Make("keepawake.notice.asktitle"),
		Message:     message,
		MessageText: messageText,
		Kind:        "warning",
		WorkspaceId: wsId,
		Actions: []molten.NotificationAction{
			action("allow", "Allow", uimsg.Make("keepawake.notice.allow"), PolicyAllow),
			action("untilworkends", "Until work ends", uimsg.Make("keepawake.notice.untilworkends"), PolicyUntilWorkEnds),
			action("letsleep", "Let it sleep", uimsg.Make("keepawake.notice.letsleep"), PolicyLetSleep),
		},
	}
}

// attemptLimits reads what the menu tells of an attempt (#1780): when it ends by itself, and whether ending its process
// stops only the keep-awake. Only a bare caffeinate qualifies: a wrapped command or systemd-inhibit (which always wraps
// one) is the user's work.
func attemptLimits(tool string, args []string, now time.Time) (int64, bool) {
	if tool != ToolCaffeinate {
		return 0, false
	}
	call := ParseCaffeinate(args)
	if call.Invalid || len(call.Command) > 0 {
		return 0, false
	}
	if call.Timeout > 0 {
		return now.Add(call.Timeout).UnixMilli(), true
	}
	return 0, true
}

// StopBlock ends the keep-awake processes a terminal let through, the menu's Stop on its row (#1780). Only stoppable
// attempts are ended, and only while the pid still runs the tool that reported: a pid the system reused for another
// program is left alone.
func (k *Keeper) StopBlock(ctx context.Context, req StopRequest) (State, error) {
	if req.BlockId == "" {
		return k.State(), fmt.Errorf("no terminal given")
	}
	if k.env.Terminate == nil {
		return k.State(), fmt.Errorf("cannot end processes here")
	}
	targets := k.stoppableAttempts(req.BlockId)
	if len(targets) == 0 {
		return k.State(), fmt.Errorf("nothing to stop in this terminal")
	}
	var stopped []string
	var firstErr error
	for _, a := range targets {
		if k.env.ProcessName != nil && k.env.ProcessName(a.Pid) != a.Tool {
			stopped = append(stopped, a.Id)
			continue
		}
		if err := k.env.Terminate(a.Pid); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		stopped = append(stopped, a.Id)
	}
	k.dropAttempts(stopped)
	k.publishIfChanged()
	if firstErr != nil {
		return k.State(), fmt.Errorf("stopping the keep-awake: %w", firstErr)
	}
	return k.State(), nil
}

func (k *Keeper) stoppableAttempts(blockId string) []Attempt {
	k.lock.Lock()
	defer k.lock.Unlock()
	var rtn []Attempt
	for _, a := range k.attempts {
		if a.BlockId == blockId && a.Outcome == OutcomeAllowed && a.Stoppable {
			rtn = append(rtn, a)
		}
	}
	return rtn
}

func (k *Keeper) dropAttempts(ids []string) {
	if len(ids) == 0 {
		return
	}
	drop := make(map[string]bool, len(ids))
	for _, id := range ids {
		drop[id] = true
	}
	k.lock.Lock()
	defer k.lock.Unlock()
	kept := k.attempts[:0]
	for _, a := range k.attempts {
		if !drop[a.Id] {
			kept = append(kept, a)
		}
	}
	k.attempts = kept
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

// Active tells whether an evaluation has anything to do besides noticing a new configuration: a coffee is on, Automatic
// is on or still holds, or an attempt's process may end. Otherwise what runs in the terminals is not read.
func (k *Keeper) Active() bool {
	cfg := k.configNow()
	k.lock.Lock()
	defer k.lock.Unlock()
	return cfg.Automatic || len(k.coffees) > 0 || k.autoHolding || len(k.attempts) > 0 || k.cfg != cfg
}

type coffeeCheck struct {
	name   string
	exists bool
}

// Evaluate applies the rules now: each coffee follows the work (it never ends by itself), Automatic's reason follows it
// and ends after the grace delay with one notification, and a coffee whose workspace was deleted ends without one.
// Attempts whose process exited go.
func (k *Keeper) Evaluate(ctx context.Context) {
	cfg := k.configNow()
	ids, pids := k.snapshotIds()
	var work Work
	if (cfg.Automatic || len(ids) > 0) && k.env.Work != nil {
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
	notices := k.apply(cfg, work, checks, dead)
	if k.env.Notify != nil {
		for _, n := range notices {
			k.env.Notify(n)
		}
	}
	k.refreshSessions(ctx, ids)
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

func (k *Keeper) apply(cfg Config, work Work, checks map[string]coffeeCheck, dead map[int32]bool) []molten.NotificationInput {
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
			rec.reasons = work.Reasons[id]
			continue
		}
		rec.reasons = nil
		if rec.working || rec.graceStart.IsZero() {
			rec.working = false
			rec.graceStart = now
		}
	}
	k.cfg = cfg
	k.autoReasons = nil
	if !cfg.Automatic {
		k.autoHolding, k.autoWorking, k.autoGraceStart = false, false, time.Time{}
	} else if work.Local {
		k.autoHolding, k.autoWorking, k.autoGraceStart = true, true, time.Time{}
		k.autoReasons = work.LocalReasons
	} else if k.autoHolding {
		if k.autoWorking || k.autoGraceStart.IsZero() {
			k.autoWorking = false
			k.autoGraceStart = now
		}
		if now.Sub(k.autoGraceStart) >= cfg.Grace {
			k.autoHolding, k.autoGraceStart = false, time.Time{}
			notices = append(notices, automaticEndNotice(cfg.Grace))
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

func automaticEndNotice(grace time.Duration) molten.NotificationInput {
	minutes := int(grace / time.Minute)
	return molten.NotificationInput{
		Source:    NotificationSource,
		Title:     fmt.Sprintf("Work finished: %s may sleep again", computerName()),
		TitleText: uimsg.Make("keepawake.notice.policyendtitle"),
		Message: fmt.Sprintf("Automatic kept it awake while work ran; MoltenTerm released its block %d minutes after the last work stopped.",
			minutes),
		MessageText: uimsg.Make("keepawake.notice.policyend", "minutes", strconv.Itoa(minutes)),
		Kind:        noticeKindInfo,
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
	grace := k.cfg.Grace
	if grace <= 0 {
		grace = DefaultGrace
	}
	state := State{
		Automatic:        k.cfg.Automatic,
		Requests:         k.cfg.Requests,
		AutomaticHolding: k.autoHolding,
		AutomaticWorking: k.autoHolding && k.autoWorking,
		Coffees:          []Coffee{},
		Attempts:         append([]Attempt{}, k.attempts...),
		Overrides:        []Override{},
	}
	if k.autoHolding && !k.autoWorking && !k.autoGraceStart.IsZero() {
		state.AutomaticEndsAt = k.autoGraceStart.Add(grace).UnixMilli()
	}
	if state.AutomaticWorking {
		state.AutomaticReasons = append([]string(nil), k.autoReasons...)
		state.AutomaticReasonsText = reasonsText(state.AutomaticReasons)
	}
	for id, rec := range k.coffees {
		c := Coffee{WorkspaceId: id, WorkspaceName: rec.name, Since: rec.since, Working: rec.working}
		if rec.working {
			c.Reasons = append([]string(nil), rec.reasons...)
			c.ReasonsText = reasonsText(c.Reasons)
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
	k.approvalsState(&state)
	state.Hold = state.AutomaticHolding || len(state.Coffees) > 0
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
