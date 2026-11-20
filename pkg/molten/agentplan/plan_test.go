// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentplan

import (
	"strings"
	"testing"
)

func must(t *testing.T) func(Plan, error) Plan {
	return func(p Plan, err error) Plan {
		t.Helper()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		return p
	}
}

func TestSetMakesEveryStepToDo(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"Read the spec", "Write the tests"}, 100))
	if len(p.Steps) != 2 || p.UpdatedAt != 100 {
		t.Fatalf("plan = %+v", p)
	}
	for _, s := range p.Steps {
		if s.Status != StatusPending {
			t.Fatalf("step %q status = %q, want pending", s.Text, s.Status)
		}
	}
	if p.Current() != 0 {
		t.Fatalf("current = %d, want none", p.Current())
	}
}

func TestSetKeepsStepsOnOneLineAndCutsThem(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"  first\n\tline  "}, 1))
	if p.Steps[0].Text != "first line" {
		t.Fatalf("text = %q", p.Steps[0].Text)
	}
	long := strings.Repeat("é", MaxStepText+10)
	p = must(t)(Plan{}.Set([]string{long}, 1))
	if len([]rune(p.Steps[0].Text)) != MaxStepText {
		t.Fatalf("cut length = %d, want %d", len([]rune(p.Steps[0].Text)), MaxStepText)
	}
}

func TestSetRefusesEmptyAndTooLongPlans(t *testing.T) {
	t.Parallel()
	if _, err := (Plan{}).Set(nil, 1); err == nil {
		t.Fatal("an empty set was accepted")
	}
	if _, err := (Plan{}).Set([]string{"   "}, 1); err == nil {
		t.Fatal("a blank step was accepted")
	}
	many := make([]string, MaxSteps+1)
	for i := range many {
		many[i] = "step"
	}
	if _, err := (Plan{}).Set(many, 1); err == nil {
		t.Fatal("a plan over the limit was accepted")
	}
}

func TestStartMovesTheCurrentStepAndDemotesThePrevious(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a", "b", "c"}, 1))
	p = must(t)(p.Start(1, 10))
	p = must(t)(p.Start(2, 20))
	if p.Current() != 2 {
		t.Fatalf("current = %d, want 2", p.Current())
	}
	if p.Steps[0].Status != StatusPending || p.Steps[0].StartedAt != 0 {
		t.Fatalf("previous step = %+v, want to do again", p.Steps[0])
	}
	if p.Steps[1].StartedAt != 20 {
		t.Fatalf("started at = %d, want 20", p.Steps[1].StartedAt)
	}
}

func TestStartKeepsTheStartTimeOfTheCurrentStep(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a"}, 1))
	p = must(t)(p.Start(1, 10))
	p = must(t)(p.Start(1, 50))
	if p.Steps[0].StartedAt != 10 {
		t.Fatalf("started at = %d, want 10", p.Steps[0].StartedAt)
	}
}

func TestDoneKeepsTheFirstDoneTime(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a", "b"}, 1))
	p = must(t)(p.Start(1, 5))
	p = must(t)(p.Done(1, 30))
	if p.Steps[0].Status != StatusCompleted || p.Steps[0].DoneAt != 30 || p.Steps[0].StartedAt != 0 {
		t.Fatalf("done step = %+v", p.Steps[0])
	}
	p = must(t)(p.Done(1, 99))
	if p.Steps[0].DoneAt != 30 {
		t.Fatalf("done again moved the time to %d", p.Steps[0].DoneAt)
	}
	done, total := p.Counts()
	if done != 1 || total != 2 {
		t.Fatalf("counts = %d/%d, want 1/2", done, total)
	}
}

func TestStepNumbersOutOfRangeAreRefused(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a"}, 1))
	for _, n := range []int{0, -1, 2} {
		if _, err := p.Start(n, 2); err == nil {
			t.Errorf("start %d was accepted", n)
		}
		if _, err := p.Done(n, 2); err == nil {
			t.Errorf("done %d was accepted", n)
		}
	}
}

func TestAddAppendsAToDoStep(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a"}, 1))
	p = must(t)(p.Add("  b  ", 7))
	if len(p.Steps) != 2 || p.Steps[1].Text != "b" || p.Steps[1].Status != StatusPending || p.UpdatedAt != 7 {
		t.Fatalf("plan = %+v", p)
	}
	if _, err := p.Add(" ", 8); err == nil {
		t.Fatal("a blank added step was accepted")
	}
}

func TestClearEmptiesThePlan(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a"}, 1)).Clear(9)
	if !p.Empty() || p.UpdatedAt != 9 {
		t.Fatalf("cleared plan = %+v", p)
	}
}

func TestOperationsDoNotChangeTheOriginal(t *testing.T) {
	t.Parallel()
	p := must(t)(Plan{}.Set([]string{"a", "b"}, 1))
	before := append([]Step(nil), p.Steps...)
	if _, err := p.Start(2, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Done(1, 6); err != nil {
		t.Fatal(err)
	}
	for i := range before {
		if p.Steps[i] != before[i] {
			t.Fatalf("step %d changed: %+v", i, p.Steps[i])
		}
	}
}
