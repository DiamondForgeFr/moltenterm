// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package learning

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const workflow = molten.LearningWorkflowPipelineSetup

// clockedStore is a store whose clock a test moves: the rules count sightings, never wait for time.
func clockedStore(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	s := MakeStore(filepath.Join(t.TempDir(), "learning"))
	clock := time.UnixMilli(1_700_000_000_000)
	s.now = func() time.Time {
		clock = clock.Add(time.Minute)
		return clock
	}
	return s, &clock
}

func correction(key string, value string, proposed string) molten.LearningRequest {
	return molten.LearningRequest{Kind: molten.LearningKindCorrection, Key: key, Value: value, Proposed: proposed, Run: "project-a"}
}

func mustRecord(t *testing.T, s *Store, req molten.LearningRequest) molten.LearningItem {
	t.Helper()
	got, err := s.Record(workflow, req, molten.LearningByView)
	if err != nil {
		t.Fatalf("record %+v: %v", req, err)
	}
	if got.Item == nil {
		t.Fatalf("record %+v stored nothing", req)
	}
	return *got.Item
}

func TestRecordCountsTheSameValueAndReplacesAnother(t *testing.T) {
	s, _ := clockedStore(t)
	first := mustRecord(t, s, correction("merge", "squash", "merge"))
	if first.Seen != 1 || first.Confidence != molten.LearningConfidenceLow || first.Id != "correction:merge" {
		t.Fatalf("first record: %+v", first)
	}
	if first.Source.By != molten.LearningByView || first.Source.Run != "project-a" || first.First != first.Source.At {
		t.Fatalf("first source: %+v", first)
	}
	second := mustRecord(t, s, correction("merge", "squash", "merge"))
	if second.Seen != 2 || second.Confidence != molten.LearningConfidenceMedium || second.First != first.First || second.Source.At <= first.Source.At {
		t.Fatalf("second record: %+v", second)
	}
	third := mustRecord(t, s, correction("merge", "squash", "merge"))
	if third.Seen != 3 || third.Confidence != molten.LearningConfidenceHigh {
		t.Fatalf("third record: %+v", third)
	}
	replaced := mustRecord(t, s, correction("merge", "rebase", "merge"))
	if replaced.Seen != 1 || replaced.Value != "rebase" || replaced.Confidence != molten.LearningConfidenceLow {
		t.Fatalf("another value starts again: %+v", replaced)
	}
	items, err := s.List(workflow)
	if err != nil || len(items) != 1 {
		t.Fatalf("one item for one key, got %+v (%v)", items, err)
	}
}

func TestEveryKindIsKeptApart(t *testing.T) {
	s, _ := clockedStore(t)
	for _, kind := range []string{molten.LearningKindAnswer, molten.LearningKindPreference, molten.LearningKindCorrection} {
		mustRecord(t, s, molten.LearningRequest{Kind: kind, Key: "same", Value: kind})
	}
	mustRecord(t, s, molten.LearningRequest{Kind: molten.LearningKindSkip, Key: "same"})
	items, _ := s.List(workflow)
	if len(items) != 4 {
		t.Fatalf("the same key under four kinds is four items, got %+v", items)
	}
}

func TestSkippedStepFoldsAfterTwoRunsAndDoneUnfoldsIt(t *testing.T) {
	s, _ := clockedStore(t)
	skip := molten.LearningRequest{Kind: molten.LearningKindSkip, Key: "template"}
	mustRecord(t, s, skip)
	d, err := s.Defaults(workflow)
	if err != nil || len(d.Folded) != 0 {
		t.Fatalf("one skip does not fold: %+v (%v)", d, err)
	}
	mustRecord(t, s, skip)
	d, _ = s.Defaults(workflow)
	if len(d.Folded) != 1 || d.Folded[0].Key != "template" || d.Folded[0].Seen != 2 {
		t.Fatalf("two skips fold: %+v", d)
	}
	if len(d.Prefill) != 0 {
		t.Fatalf("a skip is not a prefill: %+v", d.Prefill)
	}
	done, err := s.Record(workflow, molten.LearningRequest{Kind: molten.LearningKindDone, Key: "template"}, molten.LearningByView)
	if err != nil || !done.Cleared || done.Item != nil {
		t.Fatalf("done clears the skip: %+v (%v)", done, err)
	}
	d, _ = s.Defaults(workflow)
	if len(d.Folded) != 0 {
		t.Fatalf("a step that was done is not folded: %+v", d)
	}
	again, err := s.Record(workflow, molten.LearningRequest{Kind: molten.LearningKindDone, Key: "template"}, molten.LearningByView)
	if err != nil || again.Cleared {
		t.Fatalf("done on a step never skipped changes nothing: %+v (%v)", again, err)
	}
}

func TestDefaultsOfferValuesMostSeenFirst(t *testing.T) {
	s, _ := clockedStore(t)
	mustRecord(t, s, correction("rcformat", "dash", "dot"))
	mustRecord(t, s, correction("merge", "squash", "merge"))
	mustRecord(t, s, correction("merge", "squash", "merge"))
	mustRecord(t, s, molten.LearningRequest{Kind: molten.LearningKindAnswer, Key: "apptype", Value: "desktop"})
	d, err := s.Defaults(workflow)
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for _, item := range d.Prefill {
		keys = append(keys, item.Key)
	}
	if strings.Join(keys, ",") != "merge,apptype,rcformat" {
		t.Fatalf("most seen first, then the most recent: %v", keys)
	}
	if d.Prefill[0].Confidence != molten.LearningConfidenceMedium {
		t.Fatalf("confidence is stamped: %+v", d.Prefill[0])
	}
}

func TestItemsSurviveARestartAndStayPrivate(t *testing.T) {
	s, _ := clockedStore(t)
	mustRecord(t, s, correction("merge", "squash", "merge"))
	if _, err := s.Record(molten.LearningWorkflowMorphDesign, molten.LearningRequest{Kind: molten.LearningKindPreference, Key: "style", Value: "calm"}, molten.LearningByAgent); err != nil {
		t.Fatal(err)
	}
	reopened := MakeStore(s.Root())
	items, err := reopened.List(workflow)
	if err != nil || len(items) != 1 || items[0].Value != "squash" || items[0].Seen != 1 {
		t.Fatalf("after a restart: %+v (%v)", items, err)
	}
	for _, item := range items {
		if item.Key == "style" {
			t.Fatalf("a workflow reads its own items only: %+v", items)
		}
	}
	if info, err := os.Stat(filepath.Join(s.Root(), workflow+".json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the file is private: %v %v", info, err)
	}
	if info, err := os.Stat(s.Root()); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the folder is private: %v %v", info, err)
	}
	leftovers, _ := filepath.Glob(filepath.Join(s.Root(), tempPrefix+"*"))
	if len(leftovers) != 0 {
		t.Fatalf("a write leaves no temporary file: %v", leftovers)
	}
}

func TestACorruptFileIsSetAsideAndTheWorkflowStartsEmpty(t *testing.T) {
	s, _ := clockedStore(t)
	if err := os.MkdirAll(s.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.Root(), workflow+".json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := s.List(workflow)
	if err != nil || len(items) != 0 {
		t.Fatalf("a corrupt file reads as empty: %+v (%v)", items, err)
	}
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("the corrupt file is kept aside: %v", err)
	}
	mustRecord(t, s, correction("merge", "squash", "merge"))
	if items, _ := MakeStore(s.Root()).List(workflow); len(items) != 1 {
		t.Fatalf("the workflow learns again: %+v", items)
	}
}

func TestAnItemThatBreaksTheRulesIsDroppedOnReading(t *testing.T) {
	s, _ := clockedStore(t)
	if err := os.MkdirAll(s.Root(), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{"version":1,"items":[
	  {"id":"correction:merge","kind":"correction","key":"merge","value":"squash","seen":2,"first":1,"source":{"at":2,"by":"view"}},
	  {"id":"correction:Bad Key","kind":"correction","key":"Bad Key","value":"x","seen":1,"first":1,"source":{"at":2,"by":"view"}},
	  {"id":"skip:wrong","kind":"skip","key":"other","seen":1,"first":1,"source":{"at":2,"by":"view"}},
	  {"id":"correction:empty","kind":"correction","key":"empty","seen":1,"first":1,"source":{"at":2,"by":"view"}},
	  {"id":"correction:merge","kind":"correction","key":"merge","value":"twice","seen":1,"first":1,"source":{"at":2,"by":"view"}}
	]}`
	if err := os.WriteFile(filepath.Join(s.Root(), workflow+".json"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	items, _ := s.List(workflow)
	if len(items) != 1 || items[0].Value != "squash" || items[0].Seen != 2 {
		t.Fatalf("only the sound item stays: %+v", items)
	}
}

func TestRefusals(t *testing.T) {
	s, _ := clockedStore(t)
	long := strings.Repeat("x", molten.LearningMaxValue+1)
	cases := []struct {
		name string
		wf   string
		req  molten.LearningRequest
		want string
	}{
		{"unknown workflow", "nope", correction("merge", "squash", ""), "pipeline-setup, morph-design"},
		{"bad kind", workflow, molten.LearningRequest{Kind: "guess", Key: "merge", Value: "x"}, "unknown kind"},
		{"key with a space", workflow, correction("a b", "squash", ""), "bad key"},
		{"empty key", workflow, correction("", "squash", ""), "bad key"},
		{"upper case key", workflow, correction("Merge", "squash", ""), "bad key"},
		{"key too long", workflow, correction(strings.Repeat("k", molten.LearningMaxKey+1), "squash", ""), "bad key"},
		{"no value", workflow, correction("merge", "", ""), "needs a value"},
		{"value too long", workflow, correction("merge", long, ""), "longer than"},
		{"proposed too long", workflow, correction("merge", "squash", long), "longer than"},
		{"multi line value", workflow, correction("merge", "a\nb", ""), "one line"},
		{"padded value", workflow, correction("merge", " squash", ""), "start or end"},
		{"skip with a value", workflow, molten.LearningRequest{Kind: molten.LearningKindSkip, Key: "template", Value: "x"}, "has no value"},
		{"run too long", workflow, molten.LearningRequest{Kind: molten.LearningKindSkip, Key: "template", Run: strings.Repeat("r", molten.LearningMaxRun+1)}, "run label"},
		{"credential", workflow, correction("token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", ""), "credential"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := s.Record(c.wf, c.req, molten.LearningByAgent)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want an error with %q, got %v", c.want, err)
			}
		})
	}
	if _, err := os.Stat(s.Root()); !os.IsNotExist(err) {
		t.Fatalf("a refused record writes nothing: %v", err)
	}
}

func TestForgetEditAndReset(t *testing.T) {
	s, _ := clockedStore(t)
	other := molten.LearningWorkflowMorphDesign
	mustRecord(t, s, correction("merge", "squash", "merge"))
	mustRecord(t, s, correction("merge", "squash", "merge"))
	mustRecord(t, s, correction("tagprefix", "rel-", "v"))
	mustRecord(t, s, molten.LearningRequest{Kind: molten.LearningKindSkip, Key: "template"})
	if _, err := s.Record(other, molten.LearningRequest{Kind: molten.LearningKindPreference, Key: "style", Value: "calm"}, molten.LearningByAgent); err != nil {
		t.Fatal(err)
	}

	edited, err := s.Edit(workflow, "correction:merge", "rebase")
	if err != nil || edited.Value != "rebase" || !edited.Edited || edited.Seen != 2 || edited.Source.By != molten.LearningByUser {
		t.Fatalf("edit keeps the sightings and marks the item yours: %+v (%v)", edited, err)
	}
	if _, err := s.Edit(workflow, "skip:template", "x"); err == nil || !strings.Contains(err.Error(), "no value to edit") {
		t.Fatalf("a skip has no value to edit: %v", err)
	}
	if _, err := s.Edit(workflow, "correction:merge", "a\nb"); err == nil {
		t.Fatal("an edit follows the rules of a record")
	}
	if _, err := s.Edit(workflow, "correction:missing", "x"); err == nil {
		t.Fatal("editing nothing is an error")
	}
	confirmed := mustRecord(t, s, correction("merge", "rebase", "merge"))
	if confirmed.Seen != 3 || confirmed.Edited != true {
		t.Fatalf("recording the edited value again confirms it: %+v", confirmed)
	}
	replaced := mustRecord(t, s, correction("merge", "squash", "merge"))
	if replaced.Seen != 1 || replaced.Edited {
		t.Fatalf("another value replaces an edit: %+v", replaced)
	}

	if err := s.Forget(workflow, "correction:tagprefix"); err != nil {
		t.Fatal(err)
	}
	if err := s.Forget(workflow, "correction:tagprefix"); err == nil {
		t.Fatal("forgetting twice is an error")
	}
	items, _ := s.List(workflow)
	if len(items) != 2 {
		t.Fatalf("one item is forgotten: %+v", items)
	}

	n, err := s.Reset(workflow)
	if err != nil || n != 2 {
		t.Fatalf("reset forgets the workflow's items: %d (%v)", n, err)
	}
	if items, _ := s.List(workflow); len(items) != 0 {
		t.Fatalf("reset empties the workflow: %+v", items)
	}
	if items, _ := s.List(other); len(items) != 1 {
		t.Fatalf("reset leaves the other workflows alone: %+v", items)
	}
	if _, err := os.Stat(filepath.Join(s.Root(), workflow+".json")); !os.IsNotExist(err) {
		t.Fatalf("reset removes the file: %v", err)
	}
	if n, err := s.Reset(workflow); err != nil || n != 0 {
		t.Fatalf("resetting an empty workflow is fine: %d (%v)", n, err)
	}
	if items, _ := MakeStore(s.Root()).List(workflow); len(items) != 0 {
		t.Fatalf("a reset survives a restart: %+v", items)
	}
}

func TestAWorkflowHoldsAtMostTwoHundredItemsAndForgetsTheOldest(t *testing.T) {
	s, _ := clockedStore(t)
	for i := 0; i < molten.LearningMaxItems+5; i++ {
		mustRecord(t, s, molten.LearningRequest{Kind: molten.LearningKindPreference, Key: fmt.Sprintf("k%03d", i), Value: "v"})
	}
	items, _ := s.List(workflow)
	if len(items) != molten.LearningMaxItems {
		t.Fatalf("bounded at %d, got %d", molten.LearningMaxItems, len(items))
	}
	oldest := items[len(items)-1]
	newest := items[0]
	if oldest.Source.At >= newest.Source.At {
		t.Fatalf("the most recent first: %+v then %+v", newest, oldest)
	}
	reopened, _ := MakeStore(s.Root()).List(workflow)
	if len(reopened) != molten.LearningMaxItems {
		t.Fatalf("the bound holds on disk: %d", len(reopened))
	}
}

func TestChangesAreAnnouncedAfterTheStoreIsFree(t *testing.T) {
	s, _ := clockedStore(t)
	var lock sync.Mutex
	var got []string
	s.SetOnChange(func(w string) {
		// The listener reads the store: it must not be called under the store's lock.
		if _, err := s.List(w); err != nil {
			t.Errorf("listener read: %v", err)
		}
		lock.Lock()
		defer lock.Unlock()
		got = append(got, w)
	})
	mustRecord(t, s, correction("merge", "squash", "merge"))
	if _, err := s.Edit(workflow, "correction:merge", "rebase"); err != nil {
		t.Fatal(err)
	}
	if err := s.Forget(workflow, "correction:merge"); err != nil {
		t.Fatal(err)
	}
	mustRecord(t, s, correction("merge", "squash", "merge"))
	if _, err := s.Reset(workflow); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Record(workflow, correction("bad key", "x", ""), molten.LearningByView); err == nil {
		t.Fatal("expected a refusal")
	}
	lock.Lock()
	defer lock.Unlock()
	if len(got) != 5 {
		t.Fatalf("one announcement per change and none for a refusal: %v", got)
	}
}

func TestConcurrentRecordsAllCount(t *testing.T) {
	s, _ := clockedStore(t)
	var wg sync.WaitGroup
	const n = 20
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Record(workflow, correction("merge", "squash", "merge"), molten.LearningByAgent); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	items, _ := s.List(workflow)
	if len(items) != 1 || items[0].Seen != n {
		t.Fatalf("every record counts once: %+v", items)
	}
}

func TestConfidenceAndFoldRules(t *testing.T) {
	for seen, want := range map[int]string{1: "low", 2: "medium", 3: "high", 9: "high"} {
		if got := molten.LearningConfidenceOf(seen); got != want {
			t.Errorf("confidence of %d: %q, want %q", seen, got, want)
		}
	}
	items := []molten.LearningItem{
		{Id: "skip:a", Kind: molten.LearningKindSkip, Key: "a", Seen: molten.LearningFoldAfterSeen - 1},
		{Id: "skip:b", Kind: molten.LearningKindSkip, Key: "b", Seen: molten.LearningFoldAfterSeen},
		{Id: "answer:c", Kind: molten.LearningKindAnswer, Key: "c", Value: "x", Seen: 1},
	}
	d := molten.LearningDefaultsOf(workflow, items)
	if len(d.Folded) != 1 || d.Folded[0].Key != "b" || len(d.Prefill) != 1 || d.Prefill[0].Key != "c" {
		t.Fatalf("defaults: %+v", d)
	}
	empty := molten.LearningDefaultsOf(workflow, nil)
	if empty.Prefill == nil || empty.Folded == nil {
		t.Fatalf("empty lists are lists, not null: %+v", empty)
	}
}
