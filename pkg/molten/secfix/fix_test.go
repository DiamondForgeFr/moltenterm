// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func boolPtr(b bool) *bool { return &b }

// The developer's consent is the setting and its confirmation together (FR-REV-036 AC10): the setting alone, as an agent
// writing settings.json by hand leaves it, is no consent, and a forged value of the confirmation is none either.
func TestConsentOf(t *testing.T) {
	t.Parallel()
	confirmed := map[string]any{ConsentKey: float64(1_700_000_000_000)}
	for name, test := range map[string]struct {
		setting *bool
		meta    map[string]any
		want    string
	}{
		"never asked":                     {nil, nil, ConsentUnasked},
		"never asked, a stray key":        {nil, confirmed, ConsentUnasked},
		"said no":                         {boolPtr(false), confirmed, ConsentOff},
		"said yes":                        {boolPtr(true), confirmed, ConsentOn},
		"the setting written by hand":     {boolPtr(true), nil, ConsentOff},
		"a forged true":                   {boolPtr(true), map[string]any{ConsentKey: true}, ConsentOff},
		"a forged string":                 {boolPtr(true), map[string]any{ConsentKey: "yes"}, ConsentOff},
		"a confirmation that was taken":   {boolPtr(true), map[string]any{ConsentKey: nil}, ConsentOff},
		"a confirmation of zero":          {boolPtr(true), map[string]any{ConsentKey: float64(0)}, ConsentOff},
		"the confirmation of another key": {boolPtr(true), map[string]any{"molten:brokkautoapprove": float64(5)}, ConsentOff},
	} {
		if got := ConsentOf(test.setting, test.meta); got != test.want {
			t.Errorf("%s: ConsentOf = %q, want %q", name, got, test.want)
		}
	}
}

func fixOf(state string, ids ...string) Fix {
	return Fix{Fingerprint: Fingerprint(ids), Ids: NormalizeIds(ids), State: state, StartedAt: 1000, UpdatedAt: 1000}
}

func TestPlanOf(t *testing.T) {
	t.Parallel()
	const now = int64(10_000_000_000)
	merged := fixOf(FixMerged, "GO-2026-1")
	merged.MergedAt = now - 60_000
	longAgo := fixOf(FixMerged, "GO-2026-1")
	longAgo.MergedAt = now - mergedCovers - 1
	mergedWithExtra := merged
	mergedWithExtra.Extra = []string{"CVE-2026-2"}
	workingWithExtra := fixOf(FixWorking, "GO-2026-1")
	workingWithExtra.Extra = []string{"CVE-2026-2"}
	for name, test := range map[string]struct {
		fixes []Fix
		ids   []string
		want  string
	}{
		"no fix":                                      {nil, []string{"GO-2026-1"}, PlanLaunch},
		"a fix in flight for the same set":            {[]Fix{fixOf(FixWorking, "GO-2026-1")}, []string{"go-2026-1"}, PlanCovered},
		"a fix waiting for a place":                   {[]Fix{fixOf(FixWaiting, "GO-2026-1")}, []string{"GO-2026-1"}, PlanCovered},
		"a fix whose pull request is ready":           {[]Fix{fixOf(FixReady, "GO-2026-1", "GHSA-aaaa-bbbb-cccc")}, []string{"GO-2026-1"}, PlanCovered},
		"another advisory while one is in flight":     {[]Fix{fixOf(FixWorking, "GO-2026-1")}, []string{"GO-2026-1", "GHSA-aaaa-bbbb-cccc"}, PlanAddendum},
		"a different advisory while one is in flight": {[]Fix{fixOf(FixNeedsYou, "GO-2026-1")}, []string{"CVE-2026-2"}, PlanAddendum},
		"the developer stopped it":                    {[]Fix{fixOf(FixStopped, "GO-2026-1")}, []string{"GO-2026-1"}, PlanHeld},
		"it failed":                                   {[]Fix{fixOf(FixFailed, "GO-2026-1")}, []string{"GO-2026-1"}, PlanHeld},
		"stopped, but the set grew":                   {[]Fix{fixOf(FixStopped, "GO-2026-1")}, []string{"GO-2026-1", "CVE-2026-2"}, PlanLaunch},
		"merged a moment ago":                         {[]Fix{merged}, []string{"GO-2026-1"}, PlanCovered},
		"merged long ago, the scan still red":         {[]Fix{longAgo}, []string{"GO-2026-1"}, PlanLaunch},
		"merged, and a new advisory":                  {[]Fix{merged}, []string{"CVE-2026-2"}, PlanLaunch},
		"no advisory at all":                          {[]Fix{fixOf(FixWorking, "GO-2026-1")}, nil, PlanAddendum},
		"in flight, the advisory that joined its set": {[]Fix{workingWithExtra}, []string{"CVE-2026-2"}, PlanCovered},
		"merged, the advisory that only joined":       {[]Fix{mergedWithExtra}, []string{"CVE-2026-2"}, PlanLaunch},
	} {
		got, _ := PlanOf(test.fixes, test.ids, now)
		if got != test.want {
			t.Errorf("%s: PlanOf = %q, want %q", name, got, test.want)
		}
	}
}

func TestFixOfBlockPrefersTheFixInFlight(t *testing.T) {
	t.Parallel()
	block := Block{Fingerprint: Fingerprint([]string{"GO-2026-1"}), Advisories: []Advisory{{Id: "GO-2026-1"}}}
	stopped := fixOf(FixStopped, "GO-2026-1")
	stopped.UpdatedAt = 9000
	working := fixOf(FixWorking, "GO-2026-1", "CVE-2026-2")
	got, ok := FixOfBlock([]Fix{stopped, working}, block)
	if !ok || got.State != FixWorking {
		t.Fatalf("FixOfBlock = %+v, %v; want the fix in flight, which took the block's advisory in", got, ok)
	}
	if _, ok := FixOfBlock([]Fix{working}, Block{Fingerprint: "other", Advisories: []Advisory{{Id: "CVE-2026-9"}}}); ok {
		t.Fatal("a fix that does not cover the block's advisories stands for it")
	}
}

func makeFixStore(t *testing.T) *FixStore {
	t.Helper()
	return MakeFixStore(filepath.Join(t.TempDir(), "fixes.json"))
}

// The same set of advisories on three pull requests, read by concurrent refreshes, is one fix: the store's lock decides
// who begins, and the others find it covered (FR-REV-036 AC9, AC11).
func TestBeginMakesOneFixUnderConcurrentRefreshes(t *testing.T) {
	t.Parallel()
	store := makeFixStore(t)
	dir := t.TempDir()
	var launched atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			plan, _, err := store.Begin(dir, Fix{Ids: []string{"GHSA-aaaa-bbbb-cccc", "GO-2026-1"}}, false)
			if err != nil {
				t.Error(err)
				return
			}
			if plan == PlanLaunch {
				launched.Add(1)
			}
		}()
	}
	wg.Wait()
	if launched.Load() != 1 {
		t.Fatalf("%d refreshes began a fix, want 1", launched.Load())
	}
	if fixes := store.List(dir); len(fixes) != 1 || fixes[0].State != FixWaiting {
		t.Fatalf("fixes = %+v, want the one claim, waiting", fixes)
	}
}

func TestBeginHoldsAStoppedSetUnlessTheDeveloperAsks(t *testing.T) {
	t.Parallel()
	store := makeFixStore(t)
	dir := t.TempDir()
	if plan, _, err := store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, false); err != nil || plan != PlanLaunch {
		t.Fatalf("first Begin = %q, %v", plan, err)
	}
	fp := Fingerprint([]string{"GO-2026-1"})
	if _, _, err := store.Update(dir, fp, func(f *Fix) bool { f.State = FixStopped; return true }); err != nil {
		t.Fatal(err)
	}
	if plan, held, _ := store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, false); plan != PlanHeld || held.State != FixStopped {
		t.Fatalf("Begin after a stop = %q, %+v; want the set held", plan, held)
	}
	plan, fix, err := store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, true)
	if err != nil || plan != PlanLaunch || fix.State != FixWaiting {
		t.Fatalf("Begin by hand = %q, %+v, %v; want a new launch", plan, fix, err)
	}
	if fixes := store.List(dir); len(fixes) != 1 {
		t.Fatalf("the new fix does not replace the stopped one: %+v", fixes)
	}
}

// A fix that ended is not changed by an update: a Stop that lands while a launch or a follow works, on a picture of the fix
// it read before, stays. Only Begin starts the set again; Amend keeps what a fix holds beside its state.
func TestUpdateNeverChangesAFixThatEnded(t *testing.T) {
	t.Parallel()
	for _, ended := range []string{FixStopped, FixFailed, FixMerged} {
		store := makeFixStore(t)
		dir := t.TempDir()
		if plan, _, err := store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, false); err != nil || plan != PlanLaunch {
			t.Fatalf("begin: %q %v", plan, err)
		}
		fp := Fingerprint([]string{"GO-2026-1"})
		if _, _, err := store.Update(dir, fp, func(f *Fix) bool { f.State = ended; return true }); err != nil {
			t.Fatalf("the first end is made: %v", err)
		}
		called := false
		got, found, err := store.Update(dir, fp, func(f *Fix) bool { called = true; f.State = FixWorking; f.BlockId = "b"; return true })
		if !errors.Is(err, ErrEnded) || !found || called || got.State != ended {
			t.Fatalf("%s: an update of a fix that ended is refused: %+v %v %v called %v", ended, got, found, err, called)
		}
		if _, _, err := store.Update(dir, fp, func(f *Fix) bool { f.State = FixStopped; return true }); !errors.Is(err, ErrEnded) {
			t.Fatalf("%s: the first end stands, a second one is refused: %v", ended, err)
		}
		if fix, _ := store.Get(dir, fp); fix.State != ended || fix.BlockId != "" {
			t.Fatalf("%s: the stored fix is as it ended: %+v", ended, fix)
		}
		kept, found, err := store.Amend(dir, fp, func(f *Fix) bool { f.Ticket, f.State, f.Reason = 77, FixWorking, "x"; return true })
		if err != nil || !found || kept.Ticket != 77 || kept.State != ended || kept.Reason != "" {
			t.Fatalf("%s: a ticket is kept, the state is not touched: %+v %v", ended, kept, err)
		}
		if plan, _, err := store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, true); err != nil || plan != PlanLaunch {
			t.Fatalf("%s: the developer's click starts the set again: %q %v", ended, plan, err)
		}
	}
}

func TestFixStoreSurvivesARestartAndPrunes(t *testing.T) {
	t.Parallel()
	file := filepath.Join(t.TempDir(), "fixes.json")
	store := MakeFixStore(file)
	dir := t.TempDir()
	now := time.Unix(1_700_000_000, 0)
	store.UseClock(func() time.Time { return now })
	total := maxKeptFixes + 6
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("CVE-2026-%04d", i+1)
		now = now.Add(time.Minute)
		if plan, _, err := store.Begin(dir, Fix{Ids: []string{id}}, false); err != nil || plan != PlanLaunch {
			t.Fatalf("Begin %s = %q, %v", id, plan, err)
		}
		// Each one ends but the last, which stays in flight.
		if i < total-1 {
			store.Update(dir, Fingerprint([]string{id}), func(f *Fix) bool { f.State = FixMerged; f.MergedAt = 1; return true })
		}
	}
	again := MakeFixStore(file).List(dir)
	if len(again) != maxKeptFixes {
		t.Fatalf("%d fixes kept after a restart, want %d", len(again), maxKeptFixes)
	}
	active := 0
	for _, fix := range again {
		if fix.Active() {
			active++
		}
	}
	if active != 1 {
		t.Fatalf("%d fixes in flight kept, want the one that never ended", active)
	}
}

func TestFixStoreTellsWhoChanged(t *testing.T) {
	t.Parallel()
	store := makeFixStore(t)
	dir := t.TempDir()
	told := make(chan string, 4)
	store.OnChange(func(dir string) { told <- dir })
	store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, false)
	select {
	case got := <-told:
		if got != filepath.Clean(dir) {
			t.Fatalf("told %q, want %q", got, dir)
		}
	case <-time.After(time.Minute):
		t.Fatal("the change was not told")
	}
}

func TestOfPrFindsTheFixOfAPullRequest(t *testing.T) {
	t.Parallel()
	store := makeFixStore(t)
	dir := t.TempDir()
	store.Begin(dir, Fix{Ids: []string{"GO-2026-1"}}, false)
	fp := Fingerprint([]string{"GO-2026-1"})
	store.Update(dir, fp, func(f *Fix) bool { f.Pr = 150; return true })
	if fix, ok := store.OfPr(dir, 150); !ok || fix.Fingerprint != fp {
		t.Fatalf("OfPr = %+v, %v", fix, ok)
	}
	for _, number := range []int{0, -1, 151} {
		if _, ok := store.OfPr(dir, number); ok {
			t.Errorf("pull request %d has no fix", number)
		}
	}
}

func TestBeginRefusesAFixWithoutAdvisories(t *testing.T) {
	t.Parallel()
	if _, _, err := makeFixStore(t).Begin(t.TempDir(), Fix{Ids: []string{"not an id!"}}, false); err == nil {
		t.Fatal("a fix with no advisory was claimed")
	}
	var nilStore *FixStore
	if _, _, err := nilStore.Begin("/p", Fix{Ids: []string{"GO-2026-1"}}, false); err == nil {
		t.Fatal("a missing store claimed a fix")
	}
	if nilStore.List("/p") == nil || len(nilStore.List("/p")) != 0 {
		t.Fatal("a missing store lists something")
	}
}

func TestTicketTextIsCleanedAndBounded(t *testing.T) {
	t.Parallel()
	advisories := []Advisory{
		{Id: "GHSA-aaaa-bbbb-cccc", Package: "left-pad", Version: "1.0.0", Fixed: "1.0.1", Severity: "high", Summary: "bad | `cell`\n<script>x</script>"},
		{Id: "GO-2026-1", Package: "golang.org/x/crypto", Version: "0.58.0"},
	}
	body := TicketBody(advisories, "Dependency security / Scan dependencies", "develop", true, []int{12, 14})
	for _, want := range []string{"| GHSA-aaaa-bbbb-cccc | left-pad | 1.0.0 | 1.0.1 | high |", "| GO-2026-1 | golang.org/x/crypto | 0.58.0 | - | - | - |",
		"The same scan fails on `develop`", "Blocked pull requests: #12, #14", "never merges the fix"} {
		if !strings.Contains(body, want) {
			t.Errorf("the ticket body lacks %q:\n%s", want, body)
		}
	}
	for _, bad := range []string{"`cell`", "<script>", "\nx", "| bad |"} {
		if strings.Contains(body, bad) {
			t.Errorf("the ticket body holds %q:\n%s", bad, body)
		}
	}
	if got := TicketTitle([]string{"GO-2026-1", "GO-2026-2", "GO-2026-3", "GO-2026-4", "GO-2026-5"}); got != "Dependency advisories: GO-2026-1, GO-2026-2, GO-2026-3 and 2 more" {
		t.Fatalf("title = %q", got)
	}
	if got := Slug([]string{"GHSA-AAAA-bbbb-cccc", "GO-2026-1", "CVE-2026-3"}); got != "ghsa-aaaa-bbbb-cccc-go-2026-1-and-1-more" {
		t.Fatalf("slug = %q", got)
	}
	if got := Slug(nil); got != "dependency-advisories" {
		t.Fatalf("slug of nothing = %q", got)
	}
}
