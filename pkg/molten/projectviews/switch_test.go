// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package projectviews

import (
	"reflect"
	"testing"
)

// Desktop (p1) and website (p2): a Project tab shared by both, a Cadrage tile with one instance in each project, a
// Pilotage tile only Desktop has built, a Terminal pinned everywhere with an instance in Desktop only, and temporary
// views in each.
func notuliaTabs() []TabInfo {
	return []TabInfo{
		{Id: "project", ProjectTab: true},
		{Id: "cadrage1", Project: "p1", Slot: "sCadrage"},
		{Id: "cadrage2", Project: "p2", Slot: "sCadrage"},
		{Id: "pilotage1", Project: "p1", Slot: "sPilotage"},
		{Id: "terminal1", Project: "p1", Pin: "gTerm"},
		{Id: "fanny", Project: "p1"},
		{Id: "alice", Project: "p1"},
		{Id: "site", Project: "p2"},
		{Id: "agent-tab", Project: "p2", Hidden: true},
	}
}

func switchTo(active string, to string, mutate func(*SwitchInput)) SwitchPlan {
	in := SwitchInput{
		Tabs:       notuliaTabs(),
		Projects:   notulia,
		To:         to,
		Active:     active,
		Remembered: map[string]string{},
		GlobalPins: []string{"gTerm"},
	}
	if mutate != nil {
		mutate(&in)
	}
	return PlanSwitch(in)
}

func TestSwitchOnATileShowsTheTargetsInstanceOfTheSameSlot(t *testing.T) {
	plan := switchTo("cadrage2", "p1", nil)
	if plan.Show != "cadrage1" || plan.ShowMade != -1 || plan.NewView {
		t.Fatalf("plan %+v", plan)
	}
	back := switchTo("cadrage1", "p2", nil)
	if back.Show != "cadrage2" {
		t.Fatalf("and back: %+v", back)
	}
}

func TestSwitchMakesTheTilesTheTargetLacks(t *testing.T) {
	plan := switchTo("cadrage1", "p2", nil)
	want := []Instance{{Slot: "sPilotage", Source: "pilotage1"}}
	if !reflect.DeepEqual(plan.Make, want) {
		t.Fatalf("make %+v, want %+v", plan.Make, want)
	}
	if plan.Show != "cadrage2" {
		t.Fatalf("shows %q", plan.Show)
	}
}

func TestSwitchOnATileTheTargetNeverBuiltShowsTheNewInstance(t *testing.T) {
	plan := switchTo("pilotage1", "p2", nil)
	if plan.Show != "" || plan.ShowMade != 0 || plan.Make[0].Slot != "sPilotage" || plan.Make[0].Source != "pilotage1" {
		t.Fatalf("plan %+v", plan)
	}
}

func TestSwitchOnAPinNeverOpenedInTheTargetMakesItsInstance(t *testing.T) {
	plan := switchTo("terminal1", "p2", nil)
	if plan.Show != "" || plan.ShowMade < 0 || plan.Make[plan.ShowMade] != (Instance{Pin: "gTerm"}) {
		t.Fatalf("plan %+v", plan)
	}
	again := switchTo("terminal1", "p2", func(in *SwitchInput) {
		in.Tabs = append(in.Tabs, TabInfo{Id: "terminal2", Project: "p2", Pin: "gTerm"})
	})
	if again.Show != "terminal2" {
		t.Fatalf("the instance the target has: %+v", again)
	}
}

func TestSwitchOnAPinThatWasRemovedFallsThrough(t *testing.T) {
	plan := switchTo("terminal1", "p2", func(in *SwitchInput) { in.GlobalPins = nil })
	if plan.ShowMade >= 0 && plan.Make[plan.ShowMade].Pin != "" {
		t.Fatalf("no instance of a pin that is gone: %+v", plan)
	}
}

func TestSwitchFromATemporaryViewShowsTheRememberedOne(t *testing.T) {
	plan := switchTo("fanny", "p2", func(in *SwitchInput) { in.Remembered = map[string]string{"p2": "site"} })
	if plan.Show != "site" {
		t.Fatalf("plan %+v", plan)
	}
}

func TestSwitchIgnoresARememberedViewOfAnotherProjectOrHidden(t *testing.T) {
	for _, remembered := range []string{"fanny", "agent-tab", "gone"} {
		plan := switchTo("alice", "p2", func(in *SwitchInput) { in.Remembered = map[string]string{"p2": remembered} })
		if plan.Show != "cadrage2" {
			t.Errorf("remembered %q: %+v", remembered, plan)
		}
	}
}

func TestSwitchFallsBackToTheFirstTileThenTheFirstBlock(t *testing.T) {
	plan := switchTo("fanny", "p2", nil)
	if plan.Show != "cadrage2" {
		t.Fatalf("first tile: %+v", plan)
	}
	tabs := []TabInfo{
		{Id: "fanny", Project: "p1"},
		{Id: "pin2", Project: "p2", Pin: "gTerm"},
		{Id: "temp2", Project: "p2"},
	}
	block := PlanSwitch(SwitchInput{Tabs: tabs, Projects: notulia, To: "p2", Active: "fanny", GlobalPins: []string{"gTerm"}})
	if block.Show != "pin2" {
		t.Fatalf("first block: %+v", block)
	}
}

func TestSwitchBuildsTheFirstSlotBeforeAnyTemporaryView(t *testing.T) {
	tabs := []TabInfo{
		{Id: "cadrage1", Project: "p1", Slot: "s1"},
		{Id: "fanny", Project: "p1"},
		{Id: "temp2", Project: "p2"},
	}
	plan := PlanSwitch(SwitchInput{Tabs: tabs, Projects: notulia, To: "p2", Active: "fanny"})
	if plan.Show != "" || plan.ShowMade != 0 || plan.Make[0].Source != "cadrage1" {
		t.Fatalf("plan %+v", plan)
	}
}

func TestSwitchShowsATemporaryViewWhenTheProjectHasNoSlot(t *testing.T) {
	tabs := []TabInfo{{Id: "fanny", Project: "p1"}, {Id: "temp2", Project: "p2"}}
	plan := PlanSwitch(SwitchInput{Tabs: tabs, Projects: notulia, To: "p2", Active: "fanny"})
	if plan.Show != "temp2" || len(plan.Make) != 0 {
		t.Fatalf("plan %+v", plan)
	}
}

func TestSwitchToAProjectWithNoViewMakesANewOne(t *testing.T) {
	tabs := []TabInfo{{Id: "fanny", Project: "p1"}}
	plan := PlanSwitch(SwitchInput{Tabs: tabs, Projects: notulia, To: "p2", Active: "fanny"})
	if !plan.NewView || plan.Show != "" || plan.ShowMade != -1 {
		t.Fatalf("plan %+v", plan)
	}
}

func TestSwitchOnTheSharedProjectTabKeepsIt(t *testing.T) {
	plan := switchTo("project", "p2", func(in *SwitchInput) { in.Remembered = map[string]string{"p2": "site"} })
	if plan.Show != "project" {
		t.Fatalf("the Project tab follows the project in place: %+v", plan)
	}
	if len(plan.Make) != 1 || plan.Make[0].Slot != "sPilotage" {
		t.Fatalf("the tiles are still made for the target: %+v", plan.Make)
	}
}

func TestSwitchNeverShowsAHiddenTab(t *testing.T) {
	tabs := []TabInfo{{Id: "fanny", Project: "p1"}, {Id: "hidden2", Project: "p2", Hidden: true}}
	plan := PlanSwitch(SwitchInput{Tabs: tabs, Projects: notulia, To: "p2", Active: "fanny", Remembered: map[string]string{"p2": "hidden2"}})
	if !plan.NewView {
		t.Fatalf("a project with only hidden views gets a new one: %+v", plan)
	}
}

func TestRemoveMovesTheViewsAndTurnsDuplicatesIntoTemporaryViews(t *testing.T) {
	plan := PlanRemove(RemoveInput{Tabs: notuliaTabs(), Removed: "p2", NewCurrent: "p1"})
	wantMove := map[string]string{"cadrage2": "p1", "site": "p1", "agent-tab": "p1"}
	if !reflect.DeepEqual(plan.Move, wantMove) {
		t.Fatalf("moves %v, want %v", plan.Move, wantMove)
	}
	if !reflect.DeepEqual(plan.Temporary, []string{"cadrage2"}) {
		t.Fatalf("Cadrage was in both projects, its second instance is temporary: %v", plan.Temporary)
	}
}

func TestRemoveKeepsAPinnedViewThatHasNoTwin(t *testing.T) {
	tabs := []TabInfo{
		{Id: "a", Project: "p1", Slot: "s1"},
		{Id: "b", Project: "p2", Slot: "s2"},
		{Id: "c", Project: "p2", Pin: "g1"},
		{Id: "d", Project: "p1", Pin: "g1"},
		{Id: "e", Project: "p2", Pin: "g1"},
	}
	plan := PlanRemove(RemoveInput{Tabs: tabs, Removed: "p2", NewCurrent: "p1"})
	if !reflect.DeepEqual(plan.Temporary, []string{"c", "e"}) {
		t.Fatalf("temporary %v", plan.Temporary)
	}
	if plan.Move["b"] != "p1" {
		t.Fatalf("b moves with its slot: %v", plan.Move)
	}
}
