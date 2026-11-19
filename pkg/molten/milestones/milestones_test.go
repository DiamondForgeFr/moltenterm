// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// The clock of these tests is a value they move: nothing here waits on wall time, whatever the load of the machine.
type clock struct {
	lock sync.Mutex
	now  time.Time
}

func (c *clock) Now() time.Time {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.now
}

func (c *clock) Add(d time.Duration) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.now = c.now.Add(d)
}

var epoch = time.Date(2026, time.November, 19, 9, 0, 0, 0, time.UTC)

const repoUrl = "https://github.com/example/shop"

// fakeForge answers gh's API calls from fixtures the test changes between reads (#2392, TC-SHELL-018-3), and counts them.
type fakeForge struct {
	lock       sync.Mutex
	milestones []forgeMilestone
	issues     map[int][]forgeIssue
	err        error
	calls      int
}

func (f *fakeForge) gh(_ context.Context, _ string, args ...string) ([]byte, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	if len(args) != 2 || args[0] != "api" {
		return nil, fmt.Errorf("unexpected gh call %v", args)
	}
	if strings.HasPrefix(args[1], "repos/{owner}/{repo}/milestones?state=open") {
		return json.Marshal(f.milestones)
	}
	var number int
	if _, err := fmt.Sscanf(args[1], "repos/{owner}/{repo}/issues?milestone=%d&state=open", &number); err == nil {
		return json.Marshal(f.issues[number])
	}
	return nil, fmt.Errorf("unexpected gh call %v", args)
}

func (f *fakeForge) set(change func(f *fakeForge)) {
	f.lock.Lock()
	defer f.lock.Unlock()
	change(f)
}

func (f *fakeForge) count() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.calls
}

func milestone(number int, title string, open int, closed int, due string, updated string) forgeMilestone {
	return forgeMilestone{
		Number: number, Title: title, HtmlUrl: fmt.Sprintf("%s/milestone/%d", repoUrl, number),
		OpenIssues: open, ClosedIssues: closed, DueOn: due, UpdatedAt: updated,
	}
}

func issue(number int, title string, updated string) forgeIssue {
	return forgeIssue{
		Number: number, Title: title, HtmlUrl: fmt.Sprintf("%s/issues/%d", repoUrl, number), UpdatedAt: updated,
		Body: "The checkout page shows the total twice.\n\nSteps:\n1. Open the cart",
	}
}

func shopForge() *fakeForge {
	return &fakeForge{
		milestones: []forgeMilestone{
			milestone(3, "1.1.0", 4, 0, "", "2026-11-19T08:00:00Z"),
			milestone(2, "1.0.0", 3, 12, "2026-11-22T00:00:00Z", "2026-11-10T08:00:00Z"),
		},
		issues: map[int][]forgeIssue{
			2: {
				issue(41, "Checkout total shown twice", "2026-11-18T10:00:00Z"),
				{Number: 40, Title: "A pull request", HtmlUrl: repoUrl + "/pull/40", PullRequest: json.RawMessage(`{"url":"x"}`)},
				issue(38, "Receipt e-mail in the buyer's language", "2026-11-17T10:00:00Z"),
				issue(35, "Faster product search", "2026-11-12T10:00:00Z"),
			},
		},
	}
}

type recorder struct {
	lock    sync.Mutex
	signals []Signal
	uses    []string
	saved   []StoreFile
}

func (r *recorder) publish(sig Signal) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.signals = append(r.signals, sig)
}

func (r *recorder) signalCount() int {
	r.lock.Lock()
	defer r.lock.Unlock()
	return len(r.signals)
}

func (r *recorder) recordUse(agent string, _ time.Time, d time.Duration) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.uses = append(r.uses, fmt.Sprintf("%s %s", agent, d))
}

func (r *recorder) save(file StoreFile) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.saved = append(r.saved, file)
}

func (r *recorder) lastSaved() StoreFile {
	r.lock.Lock()
	defer r.lock.Unlock()
	if len(r.saved) == 0 {
		return StoreFile{}
	}
	return r.saved[len(r.saved)-1]
}

type fixture struct {
	clock *clock
	forge *fakeForge
	rec   *recorder
	svc   *Service
	dir   string
}

func makeFixture(t *testing.T, forge *fakeForge, env Env) *fixture {
	t.Helper()
	f := &fixture{clock: &clock{now: epoch}, forge: forge, rec: &recorder{}, dir: t.TempDir()}
	env.Now = f.clock.Now
	env.Gh = forge.gh
	env.Publish = f.rec.publish
	if env.Save == nil {
		env.Save = f.rec.save
	}
	if env.RecordUse == nil {
		env.RecordUse = f.rec.recordUse
	}
	f.svc = MakeService(env)
	t.Cleanup(f.svc.waitIdle)
	return f
}

// get asks for the view and lets the read or batch it started end, as a companion that asks again on the signal.
func (f *fixture) get(lang string, want ...int) View {
	f.svc.Get(GetRequest{Dir: f.dir, Lang: lang, Want: want})
	f.svc.waitIdle()
	return f.svc.Get(GetRequest{Dir: f.dir, Lang: lang, Want: want})
}

func ticketNumbers(m *Milestone) []int {
	var rtn []int
	for _, t := range m.Tickets {
		rtn = append(rtn, t.Number)
	}
	return rtn
}

// The active milestone (#2392): the nearest due date, the earliest, an overdue one included; without a due date the most
// recent activity; a milestone with work left before one without.
func TestPickActive(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		list []forgeMilestone
		want int
	}{
		{"nearest due date", []forgeMilestone{
			milestone(1, "later", 2, 0, "2026-12-20T00:00:00Z", "2026-11-19T00:00:00Z"),
			milestone(2, "sooner", 2, 0, "2026-11-25T00:00:00Z", "2026-11-01T00:00:00Z"),
		}, 2},
		{"an overdue one is still the one to finish", []forgeMilestone{
			milestone(1, "next", 2, 0, "2026-11-25T00:00:00Z", "2026-11-19T00:00:00Z"),
			milestone(2, "late", 2, 0, "2026-11-10T00:00:00Z", "2026-11-01T00:00:00Z"),
		}, 2},
		{"a dated one before an undated one", []forgeMilestone{
			milestone(1, "undated", 2, 0, "", "2026-11-19T00:00:00Z"),
			milestone(2, "dated", 2, 0, "2026-12-25T00:00:00Z", "2026-10-01T00:00:00Z"),
		}, 2},
		{"most recent activity without a due date", []forgeMilestone{
			milestone(1, "quiet", 2, 0, "", "2026-10-01T00:00:00Z"),
			milestone(2, "busy", 2, 0, "", "2026-11-18T00:00:00Z"),
		}, 2},
		{"work left first", []forgeMilestone{
			milestone(1, "done but open", 0, 9, "2026-11-20T00:00:00Z", "2026-11-19T00:00:00Z"),
			milestone(2, "work left", 1, 2, "2026-12-01T00:00:00Z", "2026-11-01T00:00:00Z"),
		}, 2},
	}
	for _, c := range cases {
		if got := pickActive(c.list); got == nil || got.Number != c.want {
			t.Errorf("%s: picked %+v, want #%d", c.name, got, c.want)
		}
	}
	if pickActive(nil) != nil {
		t.Error("no open milestone picks none")
	}
}

// TC-SHELL-018-3: the active milestone, its progress, due date and remaining tickets, then a change on the forge shows
// at the next read, without a restart, and the companions are told.
func TestMilestoneFollowsTheForge(t *testing.T) {
	t.Parallel()
	f := makeFixture(t, shopForge(), Env{})
	if first := f.svc.Get(GetRequest{Dir: f.dir}); first.State != StateLoading || first.Milestone != nil {
		t.Fatalf("before the first read: %+v", first)
	}
	view := f.get("")
	m := view.Milestone
	if view.State != StateOk || m == nil {
		t.Fatalf("view: %+v", view)
	}
	if m.Title != "1.0.0" || m.Open != 3 || m.Closed != 12 || m.Url != repoUrl+"/milestone/2" {
		t.Errorf("milestone: %+v", m)
	}
	if m.Due != time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("due: %d", m.Due)
	}
	if got := ticketNumbers(m); fmt.Sprint(got) != "[41 38 35]" || m.Remaining != 3 {
		t.Errorf("tickets %v, remaining %d: the pull request is left out", got, m.Remaining)
	}
	if m.Tickets[0].Updated != time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC).UnixMilli() {
		t.Errorf("updated: %d", m.Tickets[0].Updated)
	}
	if f.rec.signalCount() != 1 {
		t.Errorf("signals after the first read: %d, want 1", f.rec.signalCount())
	}
	calls := f.forge.count()

	f.clock.Add(30 * time.Second)
	f.get("")
	if f.forge.count() != calls {
		t.Errorf("the forge was read again within the minute: %d calls, want %d", f.forge.count(), calls)
	}

	f.forge.set(func(ff *fakeForge) {
		ff.milestones[1].Title = "1.0.0 — launch"
		ff.milestones[1].OpenIssues, ff.milestones[1].ClosedIssues = 2, 13
		ff.issues[2] = append(ff.issues[2][:2], ff.issues[2][3])
	})
	f.clock.Add(31 * time.Second)
	view = f.get("")
	if view.Milestone.Title != "1.0.0 — launch" || view.Milestone.Closed != 13 || fmt.Sprint(ticketNumbers(view.Milestone)) != "[41 35]" {
		t.Errorf("after the change on the forge: %+v", view.Milestone)
	}
	if f.rec.signalCount() != 2 {
		t.Errorf("signals: %d, want 2 (the change is told)", f.rec.signalCount())
	}

	f.clock.Add(61 * time.Second)
	f.get("")
	if f.rec.signalCount() != 2 {
		t.Errorf("a read that changed nothing told the companions: %d signals", f.rec.signalCount())
	}
}

func TestNoOpenMilestone(t *testing.T) {
	t.Parallel()
	f := makeFixture(t, &fakeForge{milestones: []forgeMilestone{}}, Env{})
	if view := f.get(""); view.State != StateNone || view.Milestone != nil {
		t.Errorf("view: %+v", view)
	}
}

// A folder off any forge shows the agent's own tasks alone, and is not asked again for five minutes.
func TestNoForge(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{err: errors.New("gh api: none of the git remotes configured for this repository point to a known GitHub host")}
	f := makeFixture(t, forge, Env{})
	if view := f.get(""); view.State != StateNoForge || view.Milestone != nil {
		t.Fatalf("view: %+v", view)
	}
	f.clock.Add(2 * time.Minute)
	f.get("")
	if forge.count() != 1 {
		t.Errorf("gh calls: %d, want 1 within five minutes", forge.count())
	}
	f.clock.Add(4 * time.Minute)
	f.get("")
	if forge.count() != 2 {
		t.Errorf("gh calls: %d, want 2 after five minutes", forge.count())
	}
}

// A failed read keeps the last good one: a forge outage does not empty the block.
func TestAFailedReadKeepsTheLastOne(t *testing.T) {
	t.Parallel()
	f := makeFixture(t, shopForge(), Env{})
	f.get("")
	f.forge.set(func(ff *fakeForge) { ff.err = errors.New("gh api: HTTP 503: service unavailable") })
	f.clock.Add(2 * time.Minute)
	view := f.get("")
	if view.State != StateOk || view.Milestone == nil || view.Milestone.Title != "1.0.0" {
		t.Errorf("view after a failed read: %+v", view)
	}
	if f.rec.signalCount() != 1 {
		t.Errorf("a failed read told the companions: %d signals", f.rec.signalCount())
	}
}

func TestOnlyAnExistingAbsoluteFolderIsRead(t *testing.T) {
	t.Parallel()
	forge := shopForge()
	svc := MakeService(Env{Gh: forge.gh, ValidDir: func(string) bool { return false }})
	for _, dir := range []string{"", "relative/folder", "/tmp/x\x00y", "/does/not/exist"} {
		if view := svc.Get(GetRequest{Dir: dir}); view.State != StateNoForge {
			t.Errorf("%q: %+v", dir, view)
		}
	}
	svc.waitIdle()
	if forge.count() != 0 {
		t.Errorf("gh ran %d times", forge.count())
	}
}
