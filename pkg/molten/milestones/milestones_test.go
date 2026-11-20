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
	log        []string
}

func (f *fakeForge) callList() []string {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]string(nil), f.log...)
}

func (f *fakeForge) gh(_ context.Context, _ string, args ...string) ([]byte, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.calls++
	f.log = append(f.log, strings.Join(args[1:], " "))
	if f.err != nil {
		return nil, f.err
	}
	if len(args) == 8 && args[1] == "graphql" && strings.Contains(args[3], "open: issues(states: OPEN)") &&
		args[5] == "owner={owner}" && args[7] == "name={repo}" {
		var answer milestonesAnswer
		answer.Data.Repository = &struct {
			Milestones struct {
				Nodes []forgeMilestone `json:"nodes"`
			} `json:"milestones"`
		}{}
		answer.Data.Repository.Milestones.Nodes = f.milestones
		return json.Marshal(answer)
	}
	if len(args) != 2 || args[0] != "api" {
		return nil, fmt.Errorf("unexpected gh call %v", args)
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

// milestone is an open milestone as GitHub's GraphQL lists it: open and closed count its issues, not its pull requests.
func milestone(number int, title string, open int, closed int, due string) forgeMilestone {
	return forgeMilestone{
		Number: number, Title: title, Url: fmt.Sprintf("%s/milestone/%d", repoUrl, number),
		Open: issueCount{TotalCount: open}, Closed: issueCount{TotalCount: closed}, DueOn: due,
	}
}

// first is the first tab of the view: the milestone the companion opens on.
func (v View) first() *Milestone {
	if len(v.Milestones) == 0 {
		return &Milestone{}
	}
	return &v.Milestones[0]
}

func (v View) titles() []string {
	rtn := []string{}
	for _, m := range v.Milestones {
		rtn = append(rtn, m.Title)
	}
	return rtn
}

func (v View) byTitle(title string) *Milestone {
	for i := range v.Milestones {
		if v.Milestones[i].Title == title {
			return &v.Milestones[i]
		}
	}
	return &Milestone{}
}

func issue(number int, title string) forgeIssue {
	return forgeIssue{
		Number: number, Title: title, HtmlUrl: fmt.Sprintf("%s/issues/%d", repoUrl, number),
		Body: "The checkout page shows the total twice.\n\nSteps:\n1. Open the cart",
	}
}

func shopForge() *fakeForge {
	return &fakeForge{
		milestones: []forgeMilestone{
			milestone(3, "1.1.0", 4, 0, ""),
			milestone(2, "1.0.0", 3, 12, "2026-11-22T00:00:00Z"),
		},
		issues: map[int][]forgeIssue{
			2: {
				issue(41, "Checkout total shown twice"),
				{Number: 40, Title: "A pull request", HtmlUrl: repoUrl + "/pull/40", PullRequest: json.RawMessage(`{"url":"x"}`)},
				issue(38, "Receipt e-mail in the buyer's language"),
				issue(35, "Faster product search"),
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

// get asks for the view as a companion on screen, and lets the read or batch it started end, as a companion that asks
// again on the signal.
func (f *fixture) get(lang string, want ...int) View {
	f.svc.Get(GetRequest{Dir: f.dir, Lang: lang, Want: want, Shown: true})
	f.svc.waitIdle()
	return f.svc.Get(GetRequest{Dir: f.dir, Lang: lang, Want: want, Shown: true})
}

func ticketNumbers(m *Milestone) []int {
	var rtn []int
	for _, t := range m.Tickets {
		rtn = append(rtn, t.Number)
	}
	return rtn
}

func orderedTitles(list []forgeMilestone) []string {
	rtn := []string{}
	for _, m := range orderMilestones(list) {
		rtn = append(rtn, m.Title)
	}
	return rtn
}

// The tabs' order (#2416): by version, the oldest first, whatever the due dates; a title that is not a version after
// them, a dated one before an undated one, then by title.
func TestTabOrder(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		list []forgeMilestone
		want []string
	}{
		{"the oldest version first, whatever the forge's order", []forgeMilestone{
			milestone(2, "v1.4.0", 41, 1, "2026-12-18T00:00:00Z"),
			milestone(1, "v1.3.0", 0, 36, "2026-11-27T00:00:00Z"),
		}, []string{"v1.3.0", "v1.4.0"}},
		{"versions compare by number, not as text", []forgeMilestone{
			milestone(1, "1.10.0", 1, 0, ""),
			milestone(2, "1.2.0", 1, 0, ""),
			milestone(3, "1.9.3", 1, 0, ""),
		}, []string{"1.2.0", "1.9.3", "1.10.0"}},
		{"the due date does not move a version", []forgeMilestone{
			milestone(1, "1.1.0", 2, 0, "2026-11-25T00:00:00Z"),
			milestone(2, "1.0.0", 2, 0, "2026-12-30T00:00:00Z"),
			milestone(3, "1.0.5", 2, 0, ""),
		}, []string{"1.0.0", "1.0.5", "1.1.0"}},
		{"a milestone with no due date stays where its version puts it", []forgeMilestone{
			milestone(1, "2.0.0", 1, 0, "2026-12-01T00:00:00Z"),
			milestone(2, "1.5.0", 1, 0, ""),
		}, []string{"1.5.0", "2.0.0"}},
		{"a pre-release comes before its release, in semver order", []forgeMilestone{
			milestone(1, "1.0.0", 1, 0, ""),
			milestone(2, "1.0.0-rc.10", 1, 0, ""),
			milestone(3, "1.0.0-rc.2", 1, 0, ""),
			milestone(4, "1.0.0-beta", 1, 0, ""),
		}, []string{"1.0.0-beta", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0"}},
		{"a short version and a title that starts with its version are versions", []forgeMilestone{
			milestone(1, "1.0.0 — launch", 1, 0, ""),
			milestone(2, "v0.9", 1, 0, ""),
			milestone(3, "2", 1, 0, ""),
		}, []string{"v0.9", "1.0.0 — launch", "2"}},
		{"a title that is not a version comes after the versions: dated first, then by title", []forgeMilestone{
			milestone(1, "Later", 9, 0, ""),
			milestone(2, "Ideas", 9, 0, ""),
			milestone(3, "Backlog", 9, 0, "2026-12-31T00:00:00Z"),
			milestone(4, "1.0.0", 1, 0, "2027-06-01T00:00:00Z"),
			milestone(5, "Spring", 9, 0, "2026-12-01T00:00:00Z"),
		}, []string{"1.0.0", "Spring", "Backlog", "Ideas", "Later"}},
		{"a title that only looks like a version is none", []forgeMilestone{
			milestone(1, "Q4", 1, 0, ""),
			milestone(2, "1.0.0x", 1, 0, ""),
			milestone(3, "1.2.3.4", 1, 0, ""),
			milestone(4, "1.0.0", 1, 0, ""),
		}, []string{"1.0.0", "1.0.0x", "1.2.3.4", "Q4"}},
		{"one version twice: the earlier due date, then the lower number", []forgeMilestone{
			milestone(5, "1.0.0", 1, 0, ""),
			milestone(4, "1.0.0", 1, 0, "2026-12-01T00:00:00Z"),
			milestone(3, "1.0.0", 1, 0, ""),
		}, []string{"1.0.0", "1.0.0", "1.0.0"}},
	}
	for _, c := range cases {
		if got := orderedTitles(c.list); fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	twice := orderMilestones([]forgeMilestone{
		milestone(5, "1.0.0", 1, 0, ""),
		milestone(4, "1.0.0", 1, 0, "2026-12-01T00:00:00Z"),
		milestone(3, "1.0.0", 1, 0, ""),
	})
	if got := []int{twice[0].Number, twice[1].Number, twice[2].Number}; fmt.Sprint(got) != "[4 3 5]" {
		t.Errorf("one version twice: %v, want [4 3 5]", got)
	}
	if got := orderMilestones([]forgeMilestone{milestone(0, "1.0.0", 1, 0, "")}); len(got) != 0 {
		t.Errorf("a milestone with no number: %v", got)
	}
}

// The case that hid a finished milestone (#2416): v1.3.0 waits for its release with 0 open issues and 36 closed, v1.4.0
// has 41 open and 1 closed. The first rule of the former pick put a milestone with open issues left before one without,
// so v1.4.0 showed and v1.3.0 was nowhere. Both tabs show now, v1.3.0 first, with its count and no ticket to read.
func TestAFinishedMilestoneKeepsItsTab(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{
		milestones: []forgeMilestone{
			milestone(14, "v1.4.0", 41, 1, "2026-12-18T00:00:00Z"),
			milestone(13, "v1.3.0", 0, 36, "2026-11-27T00:00:00Z"),
		},
		issues: map[int][]forgeIssue{14: {issue(2301, "Suggest the product"), issue(2302, "Open the logs")}},
	}
	f := makeFixture(t, forge, Env{})
	view := f.get("")
	if view.State != StateOk || fmt.Sprint(view.titles()) != "[v1.3.0 v1.4.0]" {
		t.Fatalf("view: %+v", view)
	}
	ready, next := view.byTitle("v1.3.0"), view.byTitle("v1.4.0")
	if ready.Open != 0 || ready.Closed != 36 || ready.Remaining != 0 || len(ready.Tickets) != 0 || !ready.Loaded {
		t.Errorf("the finished milestone: %+v", ready)
	}
	if ready.Due != time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC).UnixMilli() || ready.Url != repoUrl+"/milestone/13" {
		t.Errorf("the finished milestone's due date and link: %+v", ready)
	}
	if next.Open != 41 || next.Closed != 1 || fmt.Sprint(ticketNumbers(next)) != "[2301 2302]" || next.Remaining != 41 || !next.Loaded {
		t.Errorf("the next milestone: %+v", next)
	}
	for _, call := range forge.callList() {
		if strings.Contains(call, "milestone=13") {
			t.Errorf("the tickets of a milestone with none open were read: %s", call)
		}
	}
}

// The release closes v1.3.0: at the next read its tab goes, with the companions told, and v1.4.0 stands first.
func TestAClosedMilestoneLeavesAtTheNextRead(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{
		milestones: []forgeMilestone{
			milestone(13, "v1.3.0", 0, 36, "2026-11-27T00:00:00Z"),
			milestone(14, "v1.4.0", 41, 1, "2026-12-18T00:00:00Z"),
		},
		issues: map[int][]forgeIssue{14: {issue(2301, "Suggest the product")}},
	}
	f := makeFixture(t, forge, Env{})
	if view := f.get(""); fmt.Sprint(view.titles()) != "[v1.3.0 v1.4.0]" {
		t.Fatalf("before the release: %v", view.titles())
	}
	signals := f.rec.signalCount()
	forge.set(func(ff *fakeForge) { ff.milestones = ff.milestones[1:] })
	f.clock.Add(61 * time.Second)
	view := f.get("")
	if fmt.Sprint(view.titles()) != "[v1.4.0]" || f.rec.signalCount() != signals+1 {
		t.Errorf("after the release: %v, %d signals (was %d)", view.titles(), f.rec.signalCount(), signals)
	}
	forge.set(func(ff *fakeForge) { ff.milestones = nil })
	f.clock.Add(61 * time.Second)
	if view := f.get(""); view.State != StateNone || len(view.Milestones) != 0 {
		t.Errorf("with no open milestone left: %+v", view)
	}
}

// More open milestones than the tabs: the tickets of the first four come with every read; one further down is read when a
// window selects it, at once, and then every read keeps it.
func TestAMilestonePastTheTabsIsReadWhenSelected(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{issues: map[int][]forgeIssue{}}
	for i := 1; i <= 6; i++ {
		forge.milestones = append(forge.milestones, milestone(i, fmt.Sprintf("1.%d.0", i), 3, 1, ""))
		forge.issues[i] = []forgeIssue{issue(100*i, fmt.Sprintf("Ticket of milestone %d", i))}
	}
	f := makeFixture(t, forge, Env{})
	view := f.get("")
	loaded := []bool{}
	for _, m := range view.Milestones {
		loaded = append(loaded, m.Loaded)
	}
	if fmt.Sprint(loaded) != "[true true true true false false]" {
		t.Fatalf("tickets read: %v", loaded)
	}
	if got := view.byTitle("1.5.0"); len(got.Tickets) != 0 || got.Remaining != 3 || got.Open != 3 {
		t.Errorf("a milestone not read keeps its counts: %+v", got)
	}
	calls := forge.count()
	f.svc.Get(GetRequest{Dir: f.dir, Shown: true, Milestone: 5})
	f.svc.waitIdle()
	view = f.svc.Get(GetRequest{Dir: f.dir, Shown: true, Milestone: 5})
	if got := view.byTitle("1.5.0"); !got.Loaded || fmt.Sprint(ticketNumbers(got)) != "[500]" {
		t.Errorf("the selected tab: %+v", got)
	}
	// One read: the milestones, the tickets of the first four, and the selected one's.
	if forge.count() != calls+6 {
		t.Errorf("gh calls: %d, want %d", forge.count(), calls+6)
	}
	if view.byTitle("1.6.0").Loaded {
		t.Error("a milestone nobody selected was read")
	}
	f.clock.Add(61 * time.Second)
	if view = f.get(""); !view.byTitle("1.5.0").Loaded {
		t.Error("the next read dropped the selected milestone's tickets")
	}
	f.svc.Get(GetRequest{Dir: f.dir, Shown: true, Milestone: 999})
	f.svc.Get(GetRequest{Dir: f.dir, Shown: true, Milestone: 1})
	f.svc.waitIdle()
	if forge.count() != calls+12 {
		t.Errorf("a number that is no milestone, or a tab already read, started a read: %d calls, want %d", forge.count(), calls+12)
	}
}

// A window that does not show, or whose read just failed, never starts the read of a selected tab.
func TestASelectedTabIsNotReadByAHiddenOrFailedCompanion(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{issues: map[int][]forgeIssue{}}
	for i := 1; i <= 5; i++ {
		forge.milestones = append(forge.milestones, milestone(i, fmt.Sprintf("1.%d.0", i), 3, 0, ""))
	}
	f := makeFixture(t, forge, Env{})
	f.get("")
	calls := forge.count()
	f.svc.Get(GetRequest{Dir: f.dir, Milestone: 5})
	f.svc.waitIdle()
	if forge.count() != calls {
		t.Errorf("a hidden companion read the forge: %d calls, want %d", forge.count(), calls)
	}
	forge.set(func(ff *fakeForge) { ff.err = errors.New("gh api: HTTP 503: service unavailable") })
	f.clock.Add(2 * time.Minute)
	f.get("")
	failed := forge.count()
	for i := 0; i < 3; i++ {
		f.svc.Get(GetRequest{Dir: f.dir, Shown: true, Milestone: 5})
		f.svc.waitIdle()
	}
	if forge.count() != failed {
		t.Errorf("a failed read was started again at each ask: %d calls, want %d", forge.count(), failed)
	}
}

// TC-SHELL-018-3: the active milestone, its progress, due date and remaining tickets, then a change on the forge shows
// at the next read, without a restart, and the companions are told.
func TestMilestoneFollowsTheForge(t *testing.T) {
	t.Parallel()
	f := makeFixture(t, shopForge(), Env{})
	if first := f.svc.Get(GetRequest{Dir: f.dir, Shown: true}); first.State != StateLoading || len(first.Milestones) != 0 {
		t.Fatalf("before the first read: %+v", first)
	}
	view := f.get("")
	m := view.first()
	if view.State != StateOk || len(view.Milestones) != 2 {
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
		ff.milestones[1].Open.TotalCount, ff.milestones[1].Closed.TotalCount = 2, 13
		ff.issues[2] = append(ff.issues[2][:2], ff.issues[2][3])
	})
	f.clock.Add(31 * time.Second)
	view = f.get("")
	if view.first().Title != "1.0.0 — launch" || view.first().Closed != 13 || fmt.Sprint(ticketNumbers(view.first())) != "[41 35]" {
		t.Errorf("after the change on the forge: %+v", view.first())
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
	if view := f.get(""); view.State != StateNone || len(view.Milestones) != 0 {
		t.Errorf("view: %+v", view)
	}
}

// A folder off any forge shows the agent's own tasks alone, and is not asked again for five minutes.
func TestNoForge(t *testing.T) {
	t.Parallel()
	forge := &fakeForge{err: errors.New("gh api: none of the git remotes configured for this repository point to a known GitHub host")}
	f := makeFixture(t, forge, Env{})
	if view := f.get(""); view.State != StateNoForge || len(view.Milestones) != 0 {
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
	if view.State != StateOk || view.first().Title != "1.0.0" || len(view.Milestones) != 2 {
		t.Errorf("view after a failed read: %+v", view)
	}
	if f.rec.signalCount() != 1 {
		t.Errorf("a failed read told the companions: %d signals", f.rec.signalCount())
	}
}

// A companion that is not on screen gets what was read last and starts nothing: no read of the forge, however old the
// last one is (#2392).
func TestAHiddenCompanionStartsNoRead(t *testing.T) {
	t.Parallel()
	f := makeFixture(t, shopForge(), Env{})
	if view := f.svc.Get(GetRequest{Dir: f.dir}); view.State != StateLoading {
		t.Errorf("hidden, before any read: %+v", view)
	}
	f.svc.waitIdle()
	if f.forge.count() != 0 {
		t.Fatalf("a hidden companion read the forge: %d calls", f.forge.count())
	}
	f.get("")
	calls := f.forge.count()
	f.clock.Add(10 * time.Minute)
	view := f.svc.Get(GetRequest{Dir: f.dir})
	f.svc.waitIdle()
	if f.forge.count() != calls || view.first().Title != "1.0.0" {
		t.Errorf("hidden after a read: %d calls (want %d), view %+v", f.forge.count(), calls, view.Milestones)
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
