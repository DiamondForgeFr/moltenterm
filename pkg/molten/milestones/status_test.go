// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func statusOf(m *Milestone) map[int]string {
	rtn := map[int]string{}
	for _, t := range m.Tickets {
		rtn[t.Number] = t.Status
	}
	return rtn
}

// A ticket In progress or later is taken even when no agent works on it (#2418): the companions need its board status,
// which the REST issues do not carry. One GraphQL call reads it for every ticket shown.
func TestTicketsCarryTheirBoardStatus(t *testing.T) {
	t.Parallel()
	forge := shopForge()
	forge.statuses = map[int]string{41: "In progress", 38: "Backlog"}
	f := makeFixture(t, forge, Env{})
	view := f.get("")
	if got := statusOf(view.first()); fmt.Sprint(got) != "map[35: 38:Backlog 41:In progress]" {
		t.Errorf("statuses: %v", got)
	}
	calls := 0
	for _, call := range forge.callList() {
		if strings.Contains(call, "projectItems") {
			calls++
		}
	}
	if calls != 1 {
		t.Errorf("the board was read %d times in one read, want once", calls)
	}
	signals := f.rec.signalCount()
	forge.set(func(ff *fakeForge) { ff.statuses[35] = "AI testing" })
	f.clock.Add(61 * time.Second)
	view = f.get("")
	if statusOf(view.first())[35] != "AI testing" || f.rec.signalCount() != signals+1 {
		t.Errorf("a move on the board shows at the next read and tells the companions: %v, %d signals (was %d)", statusOf(view.first()), f.rec.signalCount(), signals)
	}
}

// A token without the project scope, a repository on no board, or any failure leaves the statuses empty and the view as
// it was: the milestones and their tickets still show.
func TestAFailedStatusReadLeavesTheTicketsAlone(t *testing.T) {
	t.Parallel()
	forge := shopForge()
	forge.statusErr = errors.New("gh api: your token has not been granted the required scopes: read:project")
	f := makeFixture(t, forge, Env{})
	view := f.get("")
	if view.State != StateOk || fmt.Sprint(ticketNumbers(view.first())) != "[41 38 35]" {
		t.Fatalf("view: %+v", view)
	}
	for number, status := range statusOf(view.first()) {
		if status != "" {
			t.Errorf("ticket %d has the status %q", number, status)
		}
	}
	if f.rec.signalCount() != 1 {
		t.Errorf("signals: %d, want 1", f.rec.signalCount())
	}
}

func TestOnlyPlainStatusNamesAreKept(t *testing.T) {
	t.Parallel()
	out := []byte(`{"data":{"repository":{
		"t1":{"projectItems":{"nodes":[{"status":null},{"status":{"name":"In progress"}}]}},
		"t2":{"projectItems":{"nodes":[{"status":{"name":"<script>alert(1)</script>"}}]}},
		"t3":{"projectItems":{"nodes":[]}},
		"t4":null,
		"t5":{"projectItems":{"nodes":[{"status":{"name":"Human Testing"}},{"status":{"name":"Done"}}]}}}}}`)
	got := parseStatuses(out, []int{1, 2, 3, 4, 5, 6})
	if fmt.Sprint(got) != "map[1:In progress 5:Human Testing]" {
		t.Errorf("statuses: %v", got)
	}
	if parseStatuses([]byte("not json"), []int{1}) != nil {
		t.Error("an unreadable answer gives statuses")
	}
}

func TestNoTicketsMeansNoBoardRead(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{milestones: []forgeMilestone{milestone(13, "v1.3.0", 0, 36, "2026-11-27T00:00:00Z")}}
	f := makeFixture(t, forge, Env{})
	f.get("")
	for _, call := range forge.callList() {
		if strings.Contains(call, "projectItems") {
			t.Errorf("the board was read for no ticket: %s", call)
		}
	}
	if got := statusQuery([]int{41, 38}); !strings.Contains(got, `t41: issue(number: 41)`) || !strings.Contains(got, `t38: issue(number: 38)`) {
		t.Errorf("query: %s", got)
	}
}
