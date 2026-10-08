// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The site's sync copies the registry's live-notes.json from MOLTEN_DEP_SOURCE_DIR, prints what it was given, and
// fails when the source holds features/fail.json.
const depSyncScript = `#!/bin/sh
set -e
echo "source dir: $MOLTEN_DEP_SOURCE_DIR"
echo "source commit: $MOLTEN_DEP_SOURCE_COMMIT"
echo "source project: $MOLTEN_DEP_PROJECT"
echo "cwd: $(pwd)"
if [ -f "$MOLTEN_DEP_SOURCE_DIR/features/fail.json" ]; then echo "registry refused" >&2; exit 3; fi
mkdir -p src/data/features
cp "$MOLTEN_DEP_SOURCE_DIR/features/live-notes.json" src/data/features/live-notes.json
`

const depSyncSitePipeline = `{"schema": 1, "name": "notulia-website", "group": "Notulia", "dependson": [
  {"project": "Notulia", "paths": ["features/*.json"], "branch": "develop", "sync": "sh scripts/sync.sh", "output": ["src/data/features/*.json"]}
]}`

type depSyncFixture struct {
	*depFixture
	groups *Groups
	runs   *Runs
	trees  string
}

func makeDepSyncFixture(t *testing.T) *depSyncFixture {
	saved := readLoginPath
	readLoginPath = func() string { return os.Getenv("PATH") }
	t.Cleanup(func() { readLoginPath = saved })
	f := makeDepFixture(t)
	depCommit(t, f.clock, f.site, "chore: sync script", map[string]string{".molten/project.json": depSyncSitePipeline, "scripts/sync.sh": depSyncScript})
	data := t.TempDir()
	runs := MakeRuns(filepath.Join(data, "runs"), MakeTrustStore(filepath.Join(data, "trust.json")), nil)
	links := []molten.GroupLink{{WorkspaceId: "w-app", WorkspaceName: "App", Dir: f.app}, {WorkspaceId: "w-site", WorkspaceName: "Site", Dir: f.site}}
	groups := MakeGroups(nil, nil, runs, plainRunner, func(ctx context.Context) ([]molten.GroupLink, error) { return links, nil }, nil, nil)
	trees := filepath.Join(data, "worktrees")
	groups.UseSync(MakeDepAcks(filepath.Join(data, "deps")), trees)
	return &depSyncFixture{depFixture: f, groups: groups, runs: runs, trees: trees}
}

func (f *depSyncFixture) trust(t *testing.T) {
	t.Helper()
	res, err := f.groups.Sync(DepSyncRequest{Dir: f.site})
	if err != nil {
		t.Fatal(err)
	}
	if res.Untrusted == nil {
		return
	}
	if err := f.runs.GrantTrust(f.site, res.Untrusted.Hash); err != nil {
		t.Fatal(err)
	}
}

// sync starts a sync of the site and waits for its end.
func (f *depSyncFixture) sync(t *testing.T) RunRecord {
	t.Helper()
	res, err := f.groups.Sync(DepSyncRequest{Dir: f.site, Project: "notulia"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Run == nil {
		t.Fatalf("the sync did not start: %+v", res)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		rec, err := f.runs.readRecord(f.site, res.Run.Id)
		if err == nil && rec.State != RunStateRunning {
			if f.groups.claimSync(f.site, "probe") {
				f.groups.releaseSync(f.site, "probe")
			} else {
				t.Fatal("an ended sync must release the dependent")
			}
			return rec
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the sync did not end")
	return RunRecord{}
}

func (f *depSyncFixture) log(t *testing.T, rec RunRecord) string {
	t.Helper()
	chunk, err := f.runs.ReadLog(f.site, rec.Id, 0)
	if err != nil {
		t.Fatal(err)
	}
	return chunk.Text
}

func (f *depSyncFixture) dep(t *testing.T) DependencyState {
	t.Helper()
	states, err := f.groups.Deps(GroupsRequest{Dir: f.site})
	if err != nil || len(states) != 1 {
		t.Fatalf("%v %+v", err, states)
	}
	return states[0]
}

func (f *depSyncFixture) assertNoSourceTree(t *testing.T) {
	t.Helper()
	list := depGit(t, f.app, "@1800000000 +0000", "worktree", "list", "--porcelain")
	if strings.Count(list, "worktree ") != 1 {
		t.Fatalf("the sync's worktree must be gone from the source:\n%s", list)
	}
	entries, _ := os.ReadDir(filepath.Join(f.trees, projectKey(f.app)))
	if len(entries) != 0 {
		t.Fatalf("the worktree folder must be gone: %v", entries)
	}
}

func TestDepSyncLifecycle(t *testing.T) {
	f := makeDepSyncFixture(t)

	// Trust first (AC2): nothing runs before the user trusted the command.
	res, err := f.groups.Sync(DepSyncRequest{Dir: f.site})
	if err != nil || res.Untrusted == nil || res.Run != nil {
		t.Fatalf("an untrusted sync returns the commands: %+v %v", res, err)
	}
	found := false
	for _, c := range res.Untrusted.Commands {
		if c.Kind == RunKindSync && c.Run == "sh scripts/sync.sh" && c.Title == "Sync from Notulia" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the sync is among the commands to trust: %+v", res.Untrusted.Commands)
	}
	if runs := f.runs.List(f.site); len(runs) != 0 {
		t.Fatalf("nothing ran: %+v", runs)
	}
	f.trust(t)

	// The user's checkout of the app is on another branch and dirty: the sync must read develop's tip (AC3).
	developTip := depGit(t, f.app, f.clock.tick(), "rev-parse", "develop")
	depGit(t, f.app, f.clock.tick(), "checkout", "-q", "-b", "feature/wip")
	depWrite(t, f.app, "features/live-notes.json", `{"plan": "dirty"}`)
	// A worktree left by an interrupted sync is removed by the next one.
	leftover := filepath.Join(f.trees, projectKey(f.app), "deps-old")
	if err := os.MkdirAll(leftover, 0700); err != nil {
		t.Fatal(err)
	}

	if dep := f.dep(t); dep.State != DepStateStale || dep.LastSync != nil {
		t.Fatalf("never synced: %+v", dep)
	}
	first := f.sync(t)
	text := f.log(t, first)
	if first.State != RunStateSuccess || first.Exit == nil || *first.Exit != 0 || first.Outcome != DepSyncOutcomeChanged {
		t.Fatalf("the first sync changes the output: %+v\n%s", first, text)
	}
	if !reflect.DeepEqual(first.Changed, []string{"src/data/features/live-notes.json"}) || first.Commit != developTip || first.Source != "Notulia" || first.Branch != "develop" {
		t.Fatalf("its record: %+v", first)
	}
	data, _ := os.ReadFile(filepath.Join(f.site, "src/data/features/live-notes.json"))
	if string(data) != `{"plan": "free"}` {
		t.Fatalf("the uncommitted change of the app's checkout leaked: %s", data)
	}
	for _, want := range []string{"source dir: " + filepath.Join(f.trees, projectKey(f.app), "deps-"+first.Id), "source commit: " + developTip,
		"source project: Notulia", "cwd: " + realPath(f.site), "synced, not committed"} {
		if !strings.Contains(text, want) {
			t.Fatalf("the log lacks %q:\n%s", want, text)
		}
	}
	f.assertNoSourceTree(t)
	if _, err := os.Stat(leftover); err == nil {
		t.Fatal("the leftover worktree must be removed")
	}
	if status := depGit(t, f.app, f.clock.tick(), "status", "--porcelain"); status != "M features/live-notes.json" {
		t.Fatalf("the app's checkout is left as it was: %q", status)
	}
	dep := f.dep(t)
	if dep.State != DepStateUncommitted || dep.LastSync == nil || dep.LastSync.RunId != first.Id || dep.LastSync.Outcome != DepSyncOutcomeChanged {
		t.Fatalf("synced, not committed: %+v", dep)
	}

	// The commit clears the flag (FR-MC-029).
	depCommit(t, f.clock, f.site, "chore: sync the registry", nil)
	if dep := f.dep(t); dep.State != DepStateInSync || dep.Acknowledged != 0 {
		t.Fatalf("the commit clears the flag: %+v", dep)
	}

	// A registry change that the sync does not carry: the sync changes nothing, and the flag clears without a commit.
	depGit(t, f.app, f.clock.tick(), "checkout", "-q", "--", ".")
	depGit(t, f.app, f.clock.tick(), "checkout", "-q", "develop")
	other := depCommit(t, f.clock, f.app, "feat(#1152): another feature", map[string]string{"features/other.json": `{}`})
	if dep := f.dep(t); dep.State != DepStateStale {
		t.Fatalf("stale after the registry change: %+v", dep)
	}
	siteHead := depGit(t, f.site, f.clock.tick(), "rev-parse", "HEAD")
	second := f.sync(t)
	if second.State != RunStateSuccess || second.Outcome != DepSyncOutcomeNoChange || len(second.Changed) != 0 {
		t.Fatalf("the sync changed nothing: %+v\n%s", second, f.log(t, second))
	}
	if status := depGit(t, f.site, f.clock.tick(), "status", "--porcelain"); status != "" {
		t.Fatalf("nothing written in the site: %q", status)
	}
	if head := depGit(t, f.site, f.clock.tick(), "rev-parse", "HEAD"); head != siteHead {
		t.Fatal("no commit is made")
	}
	dep = f.dep(t)
	if dep.State != DepStateInSync || dep.Acknowledged == 0 || dep.Source == nil || dep.Source.Sha != other || dep.LastSync.Outcome != DepSyncOutcomeNoChange {
		t.Fatalf("in sync, no change: %+v", dep)
	}
	f.assertNoSourceTree(t)

	// A later registry change makes it stale again: the acknowledgement held for that commit only.
	depCommit(t, f.clock, f.app, "feat(#1153): yet another", map[string]string{"features/other.json": `{"a": 1}`})
	if dep := f.dep(t); dep.State != DepStateStale || dep.Acknowledged != 0 {
		t.Fatalf("stale again: %+v", dep)
	}

	// A failing sync keeps the flag and its exit code (AC4).
	depCommit(t, f.clock, f.app, "feat(#1154): refuse", map[string]string{"features/fail.json": `{}`})
	failed := f.sync(t)
	if failed.State != RunStateFailure || failed.Exit == nil || *failed.Exit != 3 || failed.Outcome != "" {
		t.Fatalf("the failing sync: %+v", failed)
	}
	if text := f.log(t, failed); !strings.Contains(text, "registry refused") || !strings.Contains(text, "exit 3") {
		t.Fatalf("its log: %s", text)
	}
	dep = f.dep(t)
	if dep.State != DepStateStale || dep.LastSync == nil || dep.LastSync.State != RunStateFailure || dep.LastSync.Exit == nil || *dep.LastSync.Exit != 3 {
		t.Fatalf("still stale, with the failure: %+v", dep)
	}
	f.assertNoSourceTree(t)

	// Each sync is in the run history (AC5).
	if runs := f.runs.List(f.site); len(runs) != 3 {
		t.Fatalf("three syncs kept: %d", len(runs))
	}

	// One sync at a time per dependent.
	if !f.groups.claimSync(f.site, "first") {
		t.Fatal("claim")
	}
	if _, err := f.groups.Sync(DepSyncRequest{Dir: f.site}); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("a second sync is refused: %v", err)
	}
	// Only the sync holding the dependent releases it: a late release of an older one does not.
	f.groups.releaseSync(f.site, "older")
	if f.groups.claimSync(f.site, "third") {
		t.Fatal("a release by another sync must not free the dependent")
	}
	f.groups.releaseSync(f.site, "first")

	// A changed sync command asks again (AC2).
	depWrite(t, f.site, ".molten/project.json", strings.Replace(depSyncSitePipeline, "sh scripts/sync.sh", "sh scripts/sync.sh --all", 1))
	if res, err := f.groups.Sync(DepSyncRequest{Dir: f.site}); err != nil || res.Untrusted == nil {
		t.Fatalf("the changed command asks for trust: %+v %v", res, err)
	}
}

// A sync that ignores SIGTERM is killed once the time limit passed, and reads as a failure; a cancel ends one too.
func TestDepSyncStops(t *testing.T) {
	savedTimeout, savedGrace := depSyncTimeout, depSyncKillGrace
	depSyncTimeout, depSyncKillGrace = time.Second, 200*time.Millisecond
	t.Cleanup(func() { depSyncTimeout, depSyncKillGrace = savedTimeout, savedGrace })
	f := makeDepSyncFixture(t)
	depCommit(t, f.clock, f.site, "chore: a stubborn sync", map[string]string{"scripts/sync.sh": "trap '' TERM\nsleep 30\n"})
	f.trust(t)
	start := time.Now()
	timedOut := f.sync(t)
	if timedOut.State != RunStateFailure || time.Since(start) > 15*time.Second {
		t.Fatalf("the stubborn sync is stopped and fails: %+v after %s", timedOut, time.Since(start))
	}
	if text := f.log(t, timedOut); !strings.Contains(text, "was stopped") {
		t.Fatalf("its log: %s", text)
	}
	f.assertNoSourceTree(t)

	depSyncTimeout = time.Minute
	res, err := f.groups.Sync(DepSyncRequest{Dir: f.site})
	if err != nil || res.Run == nil {
		t.Fatalf("%+v %v", res, err)
	}
	time.Sleep(700 * time.Millisecond)
	if err := f.runs.Cancel(f.site, res.Run.Id); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		rec, _ := f.runs.readRecord(f.site, res.Run.Id)
		if rec.State != RunStateRunning {
			if rec.State != RunStateCancelled || !rec.Cancelled {
				t.Fatalf("cancelled: %+v", rec)
			}
			f.assertNoSourceTree(t)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the cancelled sync did not end")
}

func TestDepSyncRefusals(t *testing.T) {
	f := makeDepSyncFixture(t)
	f.trust(t)
	if _, err := f.groups.Sync(DepSyncRequest{Dir: f.site, Project: "Ghost"}); err == nil || !strings.Contains(err.Error(), "no dependency on Ghost") {
		t.Fatalf("unknown source: %v", err)
	}
	two := 2
	if _, err := f.groups.Sync(DepSyncRequest{Dir: f.site, Index: &two}); err == nil {
		t.Fatal("unknown index")
	}
	if _, err := f.groups.Sync(DepSyncRequest{Dir: "relative"}); err == nil {
		t.Fatal("a relative folder is refused")
	}
	// Without a sync declared (AC6).
	depWrite(t, f.site, ".molten/project.json", strings.Replace(depSyncSitePipeline, `"sync": "sh scripts/sync.sh", `, "", 1))
	f.trust(t)
	if _, err := f.groups.Sync(DepSyncRequest{Dir: f.site}); err == nil || !strings.Contains(err.Error(), "no dependency declares a sync") {
		t.Fatalf("no sync declared: %v", err)
	}
	// Not available without its setup.
	plain := MakeGroups(nil, nil, f.runs, plainRunner, nil, nil, nil)
	if _, err := plain.Sync(DepSyncRequest{Dir: f.site}); err == nil {
		t.Fatal("Sync needs UseSync")
	}
}

func TestPickSyncDeclaration(t *testing.T) {
	declared := []molten.PipelineDependency{
		{Project: "Notulia", Sync: "a"},
		{Project: "Docs"},
		{Project: "Brand", Sync: "b"},
	}
	none := func(int) bool { return false }
	cases := []struct {
		req     DepSyncRequest
		flagged func(int) bool
		want    int
		err     string
	}{
		{DepSyncRequest{Project: " notulia "}, none, 0, ""},
		{DepSyncRequest{Project: "Docs"}, none, -1, "no sync command is declared for the dependency on Docs"},
		{DepSyncRequest{}, none, -1, "several dependencies declare a sync"},
		{DepSyncRequest{}, func(i int) bool { return i == 2 }, 2, ""},
		{DepSyncRequest{Index: intPtr(2)}, none, 2, ""},
		{DepSyncRequest{Index: intPtr(1)}, none, -1, "no sync command is declared"},
		{DepSyncRequest{Index: intPtr(0), Project: "Brand"}, none, -1, "not on Brand"},
	}
	for _, c := range cases {
		got, err := pickSyncDeclaration(declared, c.req, c.flagged)
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Fatalf("%+v: want %q, got %d %v", c.req, c.err, got, err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Fatalf("%+v: want %d, got %d %v", c.req, c.want, got, err)
		}
	}
	if got, err := pickSyncDeclaration(declared[:1], DepSyncRequest{}, none); err != nil || got != 0 {
		t.Fatalf("the only one: %d %v", got, err)
	}
}

func intPtr(i int) *int {
	return &i
}

func TestDepAckKey(t *testing.T) {
	dep := siteDependency()
	same := dep
	same.Project = " notulia "
	same.Sync = "another command"
	if depAckKey(dep) != depAckKey(same) {
		t.Fatal("the key ignores the case of the project and the command")
	}
	moved := dep
	moved.Paths = []string{"registry/*.json"}
	if depAckKey(dep) == depAckKey(moved) {
		t.Fatal("other paths, another key")
	}
}
