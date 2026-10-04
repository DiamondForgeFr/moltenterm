// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package onboarding records MoltenTerm's first run (FR-ONB-001, DS-ONB-001) in the client meta "molten:onboarding".
// wavesrv is its only writer: windows send updates through the route leaf "molten:onboarding" (route.go), so tabs
// never race on a read-modify-write of the client. This file holds the pure rules; store.go reads and writes them.
package onboarding

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// must match frontend/moltenterm-onboarding/onboarding-state.ts
const (
	MetaKey = "molten:onboarding"
	// block meta of the panel: the page it shows ("welcome", "step:<id>", "summary"), kept across restarts
	PageMetaKey = "molten:onboarding:page"
	RouteId     = "molten:onboarding"
	ViewType    = "molten-onboarding"
	// the notification center's named action that opens the first run (frontend/moltenterm-onboarding/onboarding-host.ts)
	OpenGesture = "onboarding:open"
	// one notification key: publishing again updates the open notification instead of stacking a second one
	NotificationKey = "onboarding:gettingstarted"

	UpdateCommand = "onboardingupdate"
	StateCommand  = "onboardingstate"
	PanelCommand  = "onboardingpanel"

	StateVersion = 1

	StepAgent   = "agent"
	StepMorph   = "morph"
	StepProject = "project"

	StatusTodo    = "todo"
	StatusDone    = "done"
	StatusSkipped = "skipped"

	ByFinish   = "finish"
	ByLeave    = "leave"
	ByClosed   = "closed"
	ByEnv      = "env"
	ByExisting = "existing"

	UpdateWelcome = "welcome"
	UpdateStep    = "step"
	UpdateData    = "data"
	UpdateLeave   = "leave"
	UpdateFinish  = "finish"

	LayoutNone     = ""
	LayoutFirstRun = "firstrun"
	LayoutStarter  = "starter"

	AnnounceNone      = ""
	AnnounceAvailable = "available"
	AnnounceLeft      = "left"
)

// Read once by wavesrv when it starts, then unset (store.go); test instances set it (UPSTREAM.md, "Toolchain").
const SkipVarName = "MOLTENTERM_SKIP_ONBOARDING"

// StepIds are the first run's steps, in order (#162, #163, #165).
var StepIds = []string{StepAgent, StepMorph, StepProject}

type State struct {
	V           int                       `json:"v"`
	Done        bool                      `json:"done"`
	By          string                    `json:"by,omitempty"`
	StartedTs   int64                     `json:"startedts,omitempty"`
	WelcomeTs   int64                     `json:"welcomets,omitempty"`
	DoneTs      int64                     `json:"donets,omitempty"`
	Steps       map[string]string         `json:"steps,omitempty"`
	Data        map[string]map[string]any `json:"data,omitempty"`
	LastVersion string                    `json:"lastversion,omitempty"`
}

type Update struct {
	Kind   string         `json:"kind"`
	Step   string         `json:"step,omitempty"`
	Status string         `json:"status,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}

// StartFacts is what wavesrv knows about the first run when it starts.
type StartFacts struct {
	Skip          bool
	HasState      bool
	State         State
	TosAgreed     bool
	HasPanel      bool
	FirstTabEmpty bool
}

// Outcome is what a start or an update changes: the state to write (when Write), Wave's terms record, the layout of
// the first tab and the notification to publish.
type Outcome struct {
	Write    bool
	State    State
	SetTos   bool
	Layout   string
	Announce string
}

// SkipRequested reads MOLTENTERM_SKIP_ONBOARDING: "1" or "true" (any case) skip the first run, anything else does not.
func SkipRequested(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	return v == "1" || v == "true"
}

// ReadState reads the first run's record from the client meta; ok is false when there is none or it cannot be read.
func ReadState(meta waveobj.MetaMapType) (State, bool) {
	raw, found := meta[MetaKey]
	if !found || raw == nil {
		return State{}, false
	}
	if _, isMap := raw.(map[string]any); !isMap {
		return State{}, false
	}
	var state State
	if err := utilfn.ReUnmarshal(&state, raw); err != nil {
		return State{}, false
	}
	return state, true
}

// MetaValue is the state as the client meta stores it: a plain JSON object, so the windows read the same shape.
func MetaValue(state State) map[string]any {
	var rtn map[string]any
	if err := utilfn.ReUnmarshal(&rtn, state); err != nil {
		return nil
	}
	return rtn
}

func cloneState(state State) State {
	rtn := state
	rtn.Steps = maps.Clone(state.Steps)
	if state.Data != nil {
		rtn.Data = make(map[string]map[string]any, len(state.Data))
		for k, v := range state.Data {
			rtn.Data[k] = maps.Clone(v)
		}
	}
	return rtn
}

// markDone records that the user left the first run; the version is the one the user saw it with, which #188
// compares and advances, so it is set only when the run ends or when none is recorded.
func markDone(state State, by string, nowMs int64, version string) State {
	if !state.Done {
		state.Done = true
		state.By = by
		state.DoneTs = nowMs
		state.LastVersion = version
		return state
	}
	if state.LastVersion == "" {
		state.LastVersion = version
	}
	return state
}

func newState(nowMs int64) State {
	return State{V: StateVersion, StartedTs: nowMs}
}

// DecideStart applies the start rules of DS-ONB-001, in order:
//  1. skip requested on a run not done: done by "env", terms recorded, Wave's starter layout on a fresh first tab;
//  2. no record and Wave's terms accepted (an install from before the first run): done by "existing", and one
//     notification tells that Getting started is available;
//  3. no record: the first run starts, docked next to a terminal when the first tab is empty (else the window docks it);
//  4. a run not done whose panel is gone (closed with its pane or its tab while MoltenTerm ran without wavesrv
//     seeing it): done by "closed";
//  5. otherwise nothing.
func DecideStart(facts StartFacts, nowMs int64, version string) Outcome {
	if facts.Skip && !(facts.HasState && facts.State.Done) {
		state := facts.State
		if !facts.HasState {
			state = newState(nowMs)
		}
		state = markDone(cloneState(state), ByEnv, nowMs, version)
		layout := LayoutNone
		if !facts.TosAgreed && facts.FirstTabEmpty {
			layout = LayoutStarter
		}
		return Outcome{Write: true, State: state, SetTos: !facts.TosAgreed, Layout: layout}
	}
	if !facts.HasState && facts.TosAgreed {
		state := markDone(newState(nowMs), ByExisting, nowMs, version)
		return Outcome{Write: true, State: state, Announce: AnnounceAvailable}
	}
	if !facts.HasState {
		layout := LayoutNone
		if facts.FirstTabEmpty {
			layout = LayoutFirstRun
		}
		return Outcome{Write: true, State: newState(nowMs), Layout: layout}
	}
	if !facts.State.Done && !facts.HasPanel {
		return closedOutcome(facts.State, facts.TosAgreed, nowMs, version)
	}
	return Outcome{}
}

func closedOutcome(state State, tosAgreed bool, nowMs int64, version string) Outcome {
	state = markDone(cloneState(state), ByClosed, nowMs, version)
	return Outcome{Write: true, State: state, SetTos: !tosAgreed, Announce: AnnounceLeft}
}

// DecideClosed is rule 4 while MoltenTerm runs: the last panel of a run not done was closed.
func DecideClosed(state State, hasState bool, tosAgreed bool, hasPanel bool, nowMs int64, version string) Outcome {
	if !hasState || state.Done || hasPanel {
		return Outcome{}
	}
	return closedOutcome(state, tosAgreed, nowMs, version)
}

func validStep(step string) bool {
	return slices.Contains(StepIds, step)
}

// ApplyUpdate applies a window's update. Every update is idempotent: sending it twice changes nothing more. Welcome,
// leave and finish record Wave's terms (the welcome page names the licence); leaving announces where Getting started
// went, finishing does not.
func ApplyUpdate(state State, hasState bool, tosAgreed bool, update Update, nowMs int64, version string) (Outcome, error) {
	if !hasState {
		state = newState(nowMs)
	}
	state = cloneState(state)
	if state.V == 0 {
		state.V = StateVersion
	}
	switch update.Kind {
	case UpdateWelcome:
		if state.WelcomeTs == 0 {
			state.WelcomeTs = nowMs
		}
		return Outcome{Write: true, State: state, SetTos: !tosAgreed}, nil
	case UpdateStep:
		if !validStep(update.Step) {
			return Outcome{}, fmt.Errorf("unknown first run step %q", update.Step)
		}
		switch update.Status {
		case StatusDone, StatusSkipped:
			if state.Steps == nil {
				state.Steps = make(map[string]string)
			}
			state.Steps[update.Step] = update.Status
		case StatusTodo:
			delete(state.Steps, update.Step)
		default:
			return Outcome{}, fmt.Errorf("unknown step status %q", update.Status)
		}
		return Outcome{Write: true, State: state}, nil
	case UpdateData:
		if !validStep(update.Step) {
			return Outcome{}, fmt.Errorf("unknown first run step %q", update.Step)
		}
		if state.Data == nil {
			state.Data = make(map[string]map[string]any)
		}
		stepData := state.Data[update.Step]
		if stepData == nil {
			stepData = make(map[string]any)
		}
		for k, v := range update.Data {
			if v == nil {
				delete(stepData, k)
				continue
			}
			stepData[k] = v
		}
		state.Data[update.Step] = stepData
		return Outcome{Write: true, State: state}, nil
	case UpdateLeave, UpdateFinish:
		by := ByFinish
		announce := AnnounceNone
		if update.Kind == UpdateLeave {
			by = ByLeave
			if !state.Done {
				announce = AnnounceLeft
			}
		}
		state = markDone(state, by, nowMs, version)
		return Outcome{Write: true, State: state, SetTos: !tosAgreed, Announce: announce}, nil
	}
	return Outcome{}, fmt.Errorf("unknown first run update %q", update.Kind)
}
