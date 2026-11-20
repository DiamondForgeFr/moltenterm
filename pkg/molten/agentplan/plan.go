// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package agentplan is the plan an agent publishes with `molten agent plan` (#2430): a short list of steps, one of
// them current, that the agent companion shows as "Plan of <name>" when the agent keeps no native task list. The rules
// are pure: the clock is passed in, so they are tested without a terminal or a companion.
package agentplan

import (
	"fmt"
	"strings"
)

// must match frontend/moltenterm-shell/companion/companion-model.ts
const (
	StatusPending    = "pending"
	StatusInProgress = "in_progress"
	StatusCompleted  = "completed"
)

// The operations `molten agent plan` sends (must match cmd/wsh/cmd/wshcmd-molten-agentplan.go).
const (
	OpSet   = "set"
	OpStart = "start"
	OpDone  = "done"
	OpAdd   = "add"
	OpClear = "clear"
	OpShow  = "show"
)

const (
	MaxSteps    = 100
	MaxStepText = 500
)

type Step struct {
	Text   string `json:"text"`
	Status string `json:"status"`
	// StartedAt: when the step became the current one (unix ms), 0 when it is not current.
	StartedAt int64 `json:"startedat,omitempty"`
	// DoneAt: when the step was marked done (unix ms), 0 when it is not done.
	DoneAt int64 `json:"doneat,omitempty"`
}

type Plan struct {
	Steps []Step `json:"steps,omitempty"`
	// UpdatedAt: when the plan last changed (unix ms).
	UpdatedAt int64 `json:"updatedat,omitempty"`
}

func (p Plan) Empty() bool {
	return len(p.Steps) == 0
}

// Counts returns how many steps are done, and how many there are.
func (p Plan) Counts() (done int, total int) {
	for _, s := range p.Steps {
		if s.Status == StatusCompleted {
			done++
		}
	}
	return done, len(p.Steps)
}

// Current returns the 1-based number of the current step (the first one in progress), 0 when none is.
func (p Plan) Current() int {
	for i, s := range p.Steps {
		if s.Status == StatusInProgress {
			return i + 1
		}
	}
	return 0
}

// Set replaces the plan with the given steps, all to do.
func (p Plan) Set(texts []string, now int64) (Plan, error) {
	steps := make([]Step, 0, len(texts))
	for _, text := range texts {
		clean, err := cleanText(text)
		if err != nil {
			return p, err
		}
		steps = append(steps, Step{Text: clean, Status: StatusPending})
	}
	if len(steps) == 0 {
		return p, fmt.Errorf("give at least one step")
	}
	if len(steps) > MaxSteps {
		return p, fmt.Errorf("a plan holds at most %d steps", MaxSteps)
	}
	return Plan{Steps: steps, UpdatedAt: now}, nil
}

// Start makes step n (1-based) the current one. The step that was current goes back to do.
func (p Plan) Start(n int, now int64) (Plan, error) {
	if err := p.checkIndex(n); err != nil {
		return p, err
	}
	next := p.clone()
	for i := range next.Steps {
		if i != n-1 && next.Steps[i].Status == StatusInProgress {
			next.Steps[i].Status = StatusPending
			next.Steps[i].StartedAt = 0
		}
	}
	step := &next.Steps[n-1]
	if step.Status != StatusInProgress {
		step.StartedAt = now
	}
	step.Status = StatusInProgress
	step.DoneAt = 0
	next.UpdatedAt = now
	return next, nil
}

// Done marks step n (1-based) done. Marking a done step again keeps the time it was first done.
func (p Plan) Done(n int, now int64) (Plan, error) {
	if err := p.checkIndex(n); err != nil {
		return p, err
	}
	next := p.clone()
	step := &next.Steps[n-1]
	if step.Status != StatusCompleted {
		step.DoneAt = now
	}
	step.Status = StatusCompleted
	step.StartedAt = 0
	next.UpdatedAt = now
	return next, nil
}

// Add appends a step to do.
func (p Plan) Add(text string, now int64) (Plan, error) {
	clean, err := cleanText(text)
	if err != nil {
		return p, err
	}
	if len(p.Steps) >= MaxSteps {
		return p, fmt.Errorf("a plan holds at most %d steps", MaxSteps)
	}
	next := p.clone()
	next.Steps = append(next.Steps, Step{Text: clean, Status: StatusPending})
	next.UpdatedAt = now
	return next, nil
}

// Clear empties the plan.
func (p Plan) Clear(now int64) Plan {
	return Plan{UpdatedAt: now}
}

func (p Plan) checkIndex(n int) error {
	if n < 1 || n > len(p.Steps) {
		return fmt.Errorf("no step %d: the plan has %d", n, len(p.Steps))
	}
	return nil
}

func (p Plan) clone() Plan {
	return Plan{Steps: append([]Step(nil), p.Steps...), UpdatedAt: p.UpdatedAt}
}

// cleanText puts a step on one line and cuts it to MaxStepText runes.
func cleanText(text string) (string, error) {
	line := strings.Join(strings.Fields(text), " ")
	if line == "" {
		return "", fmt.Errorf("a step needs a text")
	}
	runes := []rune(line)
	if len(runes) > MaxStepText {
		runes = runes[:MaxStepText]
	}
	return string(runes), nil
}
