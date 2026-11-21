// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func epic(number int, title string, typeName string) forgeIssue {
	i := issue(number, title)
	i.Type = &struct {
		Name string `json:"name"`
	}{Name: typeName}
	return i
}

// epicForge: milestone 1.1.0 holds 10 open issues (2 of them epics) and 5 closed (1 epic), and a milestone "Later" whose
// only open issue is an epic.
func epicForge() *fakeForge {
	return &fakeForge{
		milestones: []forgeMilestone{
			milestone(7, "1.1.0", 10, 5, ""),
			milestone(9, "Later", 1, 0, ""),
		},
		issues: map[int][]forgeIssue{
			7: {
				epic(1411, "Companion v3", "sf-epic"),
				issue(2201, "Count the tickets"),
				epic(1424, "Spaces v2", "sf-epic"),
				epic(2202, "A story", "sf-story"),
			},
			9: {epic(1734, "Some day", "sf-epic")},
		},
		issueTypes: []string{"sf-epic", "sf-story", "sf-task"},
		epics: map[int]map[string]epicCount{
			7: {"sf-epic": {open: 2, closed: 1}},
			9: {"sf-epic": {open: 1}},
		},
	}
}

// TC-SHELL-018-11 (#2454): an epic is no work. It is in no milestone's tickets, and its milestone's counts leave it out.
func TestEpicsAreLeftOutOfTheTicketsAndTheCounts(t *testing.T) {
	t.Parallel()
	f := makeFixture(t, epicForge(), Env{})
	view := f.get("")
	m := view.byTitle("1.1.0")
	if fmt.Sprint(ticketNumbers(m)) != "[2201 2202]" {
		t.Errorf("tickets: %v, want the stories only", ticketNumbers(m))
	}
	if m.Open != 8 || m.Closed != 4 || m.Remaining != 8 {
		t.Errorf("counts: open %d closed %d remaining %d, want 8, 4, 8", m.Open, m.Closed, m.Remaining)
	}
	later := view.byTitle("Later")
	if later.Open != 0 || len(later.Tickets) != 0 || !later.Loaded {
		t.Errorf("a milestone of epics only has no work: %+v", later)
	}
}

// Issue types the forge does not answer leave the counts as they were, less the epics seen among the tickets read; a
// failed count does the same.
func TestEpicsWithoutCountsFallBackOnTheTicketsRead(t *testing.T) {
	t.Parallel()
	for name, change := range map[string]func(f *fakeForge){
		"no issue types": func(f *fakeForge) { f.issueTypes = nil },
		"count failed":   func(f *fakeForge) { f.epicErr = errors.New("gh: HTTP 502") },
	} {
		forge := epicForge()
		change(forge)
		f := makeFixture(t, forge, Env{})
		m := f.get("").byTitle("1.1.0")
		if fmt.Sprint(ticketNumbers(m)) != "[2201 2202]" || m.Open != 8 || m.Closed != 5 || m.Remaining != 8 {
			t.Errorf("%s: tickets %v, open %d closed %d remaining %d", name, ticketNumbers(m), m.Open, m.Closed, m.Remaining)
		}
	}
}

// A repository whose types have no epic counts nothing more: one call for the types, none for counts.
func TestARepositoryWithoutAnEpicTypeCountsAsBefore(t *testing.T) {
	t.Parallel()
	forge := epicForge()
	forge.issueTypes = []string{"Bug", "Feature", "Epicure"}
	f := makeFixture(t, forge, Env{})
	m := f.get("").byTitle("1.1.0")
	if m.Open != 10 || m.Closed != 5 {
		t.Errorf("counts: open %d closed %d, want the forge's 10 and 5", m.Open, m.Closed)
	}
	for _, call := range forge.callList() {
		if strings.Contains(call, "filterBy") {
			t.Errorf("epics were counted with no epic type: %s", call)
		}
	}
}

func TestIsEpicType(t *testing.T) {
	t.Parallel()
	for name, want := range map[string]bool{
		"Epic": true, "sf-epic": true, "team_epic": true, "Team epic": true,
		"sf-story": false, "Epicure": false, "": false, "epics": false,
	} {
		if got := isEpicType(name); got != want {
			t.Errorf("isEpicType(%q) = %v, want %v", name, got, want)
		}
	}
}
