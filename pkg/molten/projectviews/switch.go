// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package projectviews

import "slices"

// TabInfo is what the switch and the removal read of a view.
type TabInfo struct {
	Id string
	// The project that owns the view; "" when every project shares it (the Project tab).
	Project string
	// The slot a tile shares with its instances in the other projects; "" for any other view.
	Slot string
	// The pin everywhere this view is the workspace's instance of; "" for any other view.
	Pin        string
	ProjectTab bool
	Hidden     bool
	// An instance made for a project that never showed it: it has no panel yet.
	Placeholder bool
}

// Instance is a view a project is missing: a tile's, built from the configuration of a tab that holds the slot, or a
// pin everywhere's, built from the pin.
type Instance struct {
	Slot   string
	Pin    string
	Source string
}

type SwitchInput struct {
	// The workspace's tabs in order.
	Tabs     []TabInfo
	Projects []Project
	To       string
	// The tab shown now.
	Active string
	// {projectId: tabId}: the view last shown in each project.
	Remembered map[string]string
	// The pins everywhere that still exist.
	GlobalPins []string
}

// SwitchPlan says what a project switch shows. Make lists the instances the target project lacks, in order; ShowMade
// is the index in Make of the one to show, -1 when an existing tab is shown or NewView is true.
type SwitchPlan struct {
	Show     string
	Make     []Instance
	ShowMade int
	NewView  bool
}

// PlanSwitch decides the view a project switch lands on, in this order: the tab shown when every project shares it;
// the same slot or pin's instance in the target (made when missing); the target's remembered view; its first tile; its
// first top-row block; the first slot of the workspace, made for the target; any view it shows; else a new view.
// Every tile the target lacks is made for it, so the sidebar lists the workspace's tiles in every project.
func PlanSwitch(in SwitchInput) SwitchPlan {
	plan := SwitchPlan{ShowMade: -1}
	shownIn := func(t TabInfo) bool {
		return !t.Hidden && (t.Project == "" || t.Project == in.To)
	}
	var active TabInfo
	for _, t := range in.Tabs {
		if t.Id == in.Active {
			active = t
		}
	}
	slotSource := map[string]string{}
	var slots []string
	hasSlot := map[string]bool{}
	for _, t := range in.Tabs {
		if t.Slot == "" || t.Hidden {
			continue
		}
		if _, ok := slotSource[t.Slot]; !ok {
			slotSource[t.Slot] = t.Id
			slots = append(slots, t.Slot)
		}
		if t.Project == in.To {
			hasSlot[t.Slot] = true
		}
	}
	madeSlot := map[string]int{}
	for _, slot := range slots {
		if hasSlot[slot] {
			continue
		}
		madeSlot[slot] = len(plan.Make)
		plan.Make = append(plan.Make, Instance{Slot: slot, Source: slotSource[slot]})
	}
	firstIn := func(match func(TabInfo) bool) string {
		for _, t := range in.Tabs {
			if t.Project == in.To && shownIn(t) && match(t) {
				return t.Id
			}
		}
		return ""
	}
	if active.Id != "" && active.Project == "" && !active.Hidden {
		plan.Show = active.Id
		return plan
	}
	if active.Slot != "" {
		if id := firstIn(func(t TabInfo) bool { return t.Slot == active.Slot }); id != "" {
			plan.Show = id
			return plan
		}
		if at, ok := madeSlot[active.Slot]; ok {
			plan.ShowMade = at
			return plan
		}
	}
	if active.Pin != "" && slices.Contains(in.GlobalPins, active.Pin) {
		if id := firstIn(func(t TabInfo) bool { return t.Pin == active.Pin }); id != "" {
			plan.Show = id
			return plan
		}
		plan.ShowMade = len(plan.Make)
		plan.Make = append(plan.Make, Instance{Pin: active.Pin})
		return plan
	}
	if id := in.Remembered[in.To]; id != "" {
		for _, t := range in.Tabs {
			if t.Id == id && shownIn(t) {
				plan.Show = id
				return plan
			}
		}
	}
	if id := firstIn(func(t TabInfo) bool { return t.Slot != "" }); id != "" {
		plan.Show = id
		return plan
	}
	if id := firstIn(func(t TabInfo) bool { return t.Pin != "" }); id != "" {
		plan.Show = id
		return plan
	}
	if len(slots) > 0 {
		plan.ShowMade = madeSlot[slots[0]]
		return plan
	}
	if id := firstIn(func(TabInfo) bool { return true }); id != "" {
		plan.Show = id
		return plan
	}
	for _, t := range in.Tabs {
		if shownIn(t) {
			plan.Show = t.Id
			return plan
		}
	}
	plan.NewView = true
	return plan
}

type RemoveInput struct {
	Tabs []TabInfo
	// The project taken out of the workspace, and the one that takes over its views.
	Removed    string
	NewCurrent string
}

// RemovePlan says what removing a project does to its views: they move to the project that takes over, and none
// closes. A tile or a top-row block whose slot or pin the new owner already has an instance of becomes a temporary
// view, so no project shows the same pinned view twice. An instance never shown has no panel: it is the one that goes
// (Drop) when the other is a real one, so the project keeps the instance the developer worked in.
type RemovePlan struct {
	Move      map[string]string
	Temporary []string
	Drop      []string
}

func PlanRemove(in RemoveInput) RemovePlan {
	plan := RemovePlan{Move: map[string]string{}}
	slotHeld, pinHeld := map[string]TabInfo{}, map[string]TabInfo{}
	for _, t := range in.Tabs {
		if t.Project != in.NewCurrent {
			continue
		}
		if t.Slot != "" {
			slotHeld[t.Slot] = t
		}
		if t.Pin != "" {
			pinHeld[t.Pin] = t
		}
	}
	// settle says what happens to a moved instance of a pinned view the new owner may hold already.
	settle := func(held map[string]TabInfo, key string, moved TabInfo) {
		own, has := held[key]
		switch {
		case !has:
			held[key] = moved
		case own.Placeholder && !moved.Placeholder:
			plan.Drop = append(plan.Drop, own.Id)
			held[key] = moved
		case moved.Placeholder:
			plan.Drop = append(plan.Drop, moved.Id)
		default:
			plan.Temporary = append(plan.Temporary, moved.Id)
		}
	}
	for _, t := range in.Tabs {
		if t.Project != in.Removed {
			continue
		}
		plan.Move[t.Id] = in.NewCurrent
		switch {
		case t.Slot != "":
			settle(slotHeld, t.Slot, t)
		case t.Pin != "":
			settle(pinHeld, t.Pin, t)
		}
	}
	return plan
}
