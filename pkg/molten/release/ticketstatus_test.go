// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The release ticket follows the release (#2563). The project's workflow is a fake workflow-cli.sh in the fixture
// project: it records every call, keeps the tickets' statuses in files, and refuses a move when a file says so. The real
// CLI never runs here, and no ticket of any repository is moved.

const releaseTicketNumber = 1078

func soloManifest(extra string) string {
	return `{"workflow":{"template":"SaaSFoundry Solo","tool":"github-projects","workingBranch":"develop","branchNaming":{"release":"rc-{version}"},` +
		`"commitFormat":{"pattern":"type(#N): description","requireTicket":true},` +
		`"statuses":[{"name":"Backlog"},{"name":"In Progress"},{"name":"AI Testing"},{"name":"In Review"},{"name":"Done"}]` + extra + `}}`
}

// The Team preset names its statuses another way, and has two more.
const teamManifest = `{"workflow":{"template":"SaaSFoundry Team","tool":"github-projects","workingBranch":"develop","branchNaming":{"release":"rc-{version}"},` +
	`"commitFormat":{"pattern":"type(#N): description","requireTicket":true},` +
	`"statuses":[{"name":"Backlog"},{"name":"Ready"},{"name":"In progress"},{"name":"AI testing"},{"name":"Human testing"},{"name":"In review"},{"name":"Done"}]}}`

// A workflow with no testing status at all.
const leanManifest = `{"workflow":{"template":"Lean","tool":"github-projects","workingBranch":"develop","branchNaming":{"release":"rc-{version}"},` +
	`"commitFormat":{"pattern":"type(#N): description","requireTicket":true},` +
	`"statuses":[{"name":"Backlog"},{"name":"In progress"},{"name":"In review"},{"name":"Done"}]}}`

const fakeWorkflowScript = `#!/bin/bash
D='@DIR@'
echo "$*" >> "$D/calls.log"
env | grep '^SF_WORKFLOW_BYPASS_' >> "$D/hatches.log"
case "$1" in
  status)
    if [ -f "$D/refuse/status-error" ]; then echo "gh: HTTP 401: bad credentials" >&2; exit 1; fi
    if [ -f "$D/refuse/status-garbled" ]; then echo "something else"; exit 0; fi
    printf '===\nTicket #%s is currently in status: %s\n===\n' "$2" "$(cat "$D/state/$2" 2>/dev/null || echo Backlog)"
    ;;
  update-status)
    key=$(printf '%s' "$3" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
    if [ -f "$D/refuse/$key" ]; then
      printf '\033[0;31m✗ Ticket #%s cannot move to %s.\033[0m\n' "$2" "$3" >&2
      cat "$D/refuse/$key" >&2
      exit 2
    fi
    printf '%s' "$3" > "$D/state/$2"
    printf 'Ticket #%s -> %s\n' "$2" "$3"
    ;;
  *)
    echo "fake workflow-cli: unexpected $*" >&2
    exit 64
    ;;
esac
`

type fakeWorkflow struct {
	t   *testing.T
	dir string
}

// installWorkflow puts the manifest and the fake workflow CLI in the fixture's project, where SaaSFoundry keeps them.
func installWorkflow(t *testing.T, f *fixture, manifest string) *fakeWorkflow {
	t.Helper()
	w := &fakeWorkflow{t: t, dir: t.TempDir()}
	for _, sub := range []string{"state", "refuse"} {
		if err := os.MkdirAll(filepath.Join(w.dir, sub), 0755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(f.checkout, ".claude", "skills", "sf-workflow", "workflow-cli.sh"), strings.ReplaceAll(fakeWorkflowScript, "@DIR@", w.dir))
	writeFile(t, filepath.Join(f.checkout, ".saasfoundry.json"), manifest)
	return w
}

func (w *fakeWorkflow) lines(name string) []string {
	data, err := os.ReadFile(filepath.Join(w.dir, name))
	if err != nil {
		return nil
	}
	var rtn []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			rtn = append(rtn, strings.TrimSpace(line))
		}
	}
	return rtn
}

func (w *fakeWorkflow) calls() []string   { return w.lines("calls.log") }
func (w *fakeWorkflow) hatches() []string { return w.lines("hatches.log") }

// moves are the calls that changed something.
func (w *fakeWorkflow) moves() []string {
	var rtn []string
	for _, call := range w.calls() {
		if strings.HasPrefix(call, "update-status ") {
			rtn = append(rtn, call)
		}
	}
	return rtn
}

// at is where the board has the ticket.
func (w *fakeWorkflow) at(ticket int) string {
	data, err := os.ReadFile(filepath.Join(w.dir, "state", strconv.Itoa(ticket)))
	if err != nil {
		return "Backlog"
	}
	return string(data)
}

func (w *fakeWorkflow) put(ticket int, status string) {
	w.t.Helper()
	if err := os.WriteFile(filepath.Join(w.dir, "state", strconv.Itoa(ticket)), []byte(status), 0644); err != nil {
		w.t.Fatal(err)
	}
}

// refuse makes the workflow's guards turn a move to the status down, with the message.
func (w *fakeWorkflow) refuse(status string, message string) {
	w.t.Helper()
	key := strings.ToLower(strings.ReplaceAll(status, " ", ""))
	if err := os.WriteFile(filepath.Join(w.dir, "refuse", key), []byte(message), 0644); err != nil {
		w.t.Fatal(err)
	}
}

func (w *fakeWorkflow) lift(status string) {
	w.t.Helper()
	key := strings.ToLower(strings.ReplaceAll(status, " ", ""))
	if err := os.Remove(filepath.Join(w.dir, "refuse", key)); err != nil {
		w.t.Fatal(err)
	}
}

func wantCalls(t *testing.T, f *fixture, w *fakeWorkflow, want ...string) {
	t.Helper()
	got := w.calls()
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the workflow's CLI was called\n%s\nwant\n%s\n--- output ---\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"), f.out.String())
	}
}

func wantOutput(t *testing.T, f *fixture, lines ...string) {
	t.Helper()
	for _, line := range lines {
		if !strings.Contains(f.out.String(), line) {
			t.Fatalf("the output lacks %q:\n%s", line, f.out.String())
		}
	}
}

// prFlowProject is a throwaway project that SaaSFoundry manages, released by the pull-request flow: its ticket is given,
// as --ticket does.
func prFlowProject(t *testing.T, manifest string) (*fixture, *fakePrGitHub, *fakeWorkflow, *Env) {
	t.Helper()
	f := makeFixture(t)
	w := installWorkflow(t, f, manifest)
	gh := &fakePrGitHub{t: t, f: f, checks: []string{"pass"}, state: "CLEAN"}
	e := f.env()
	e.Run = gh.run
	e.Ticket = releaseTicketNumber
	return f, gh, w, e
}

// A release candidate stays on its RC branch, the public release goes through its pull request and comes back to the
// trunk with a merge commit: the ticket is moved at each of the four moments, with the names the manifest declares.
func TestReleaseTicketFollowsTheReleaseOnSolo(t *testing.T) {
	t.Parallel()
	f, gh, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()

	mustRun(t, f, "prepare --pr the candidate", e.PreparePr(ctx, "v1.0.0-1"))
	if got := w.at(releaseTicketNumber); got != "In Progress" {
		t.Fatalf("a prepared release's ticket is in %q", got)
	}
	if _, err := os.Stat(filepath.Join(f.worktree(), "releases", "v1.0.0-1.md")); err != nil {
		t.Fatalf("the preparation did not write the notes: %v", err)
	}
	mustRun(t, f, "tag the candidate on its branch", e.TagRcBranch(ctx, "v1.0.0-1"))
	if got := w.at(releaseTicketNumber); got != "AI Testing" {
		t.Fatalf("the ticket of a pushed RC branch is in %q", got)
	}
	mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	if got := w.at(releaseTicketNumber); got != "In Review" {
		t.Fatalf("the ticket of an RC pull request open for review is in %q", got)
	}
	mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0", MergePrOptions{}))
	mustRun(t, f, "tag", e.Tag(ctx, "v1.0.0"))
	if got := w.at(releaseTicketNumber); got != "In Review" {
		t.Fatalf("merging and tagging move nothing, the ticket is in %q", got)
	}
	mustRun(t, f, "sync-back --merge", e.SyncBackMerge(ctx, "v1.0.0"))
	if got := w.at(releaseTicketNumber); got != "Done" {
		t.Fatalf("the ticket of a release back on the trunk is in %q", got)
	}
	f.out.Reset()
	mustRun(t, f, "sync-back --merge again", e.SyncBackMerge(ctx, "v1.0.0"))
	wantOutput(t, f, "develop already holds v1.0.0", "Release ticket #1078 is already in Done.")
	if gh.called("pr merge") != 2 {
		t.Fatalf("the ticket's moves changed what the release merges: %v", gh.calls)
	}

	wantCalls(t, f, w,
		"status 1078", "update-status 1078 In Progress",
		"status 1078", "update-status 1078 AI Testing",
		"status 1078",
		"status 1078",
		"status 1078", "update-status 1078 In Review",
		"status 1078", "update-status 1078 Done",
		"status 1078")
}

func TestReleaseTicketIsPrintedInTheReleaseOutput(t *testing.T) {
	t.Parallel()
	f, _, _, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	wantOutput(t, f, "Release ticket #1078 moved from Backlog to In Progress (the release is being prepared).")
	f.out.Reset()
	mustRun(t, f, "tag --rc-branch", e.TagRcBranch(ctx, "v1.0.0-1"))
	wantOutput(t, f, "Release ticket #1078 moved from In Progress to AI Testing (the RC branch is pushed).")
	mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
	f.out.Reset()
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	wantOutput(t, f,
		"Release ticket #1078 is already in AI Testing.",
		"Pull request opened: https://github.example/pr/9",
		"Release ticket #1078 moved from AI Testing to In Review (the RC pull request is open for review).")
}

// A preset with other names: the calls carry the names its manifest declares, a ticket past a status is not pulled back
// to it, and a status between two others (Ready, Human testing) is never a stop of the release.
func TestReleaseTicketUsesTheNamesOfThePreset(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, teamManifest)
	ctx := context.Background()
	w.put(releaseTicketNumber, "Ready")

	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	mustRun(t, f, "tag --rc-branch", e.TagRcBranch(ctx, "v1.0.0-1"))
	w.put(releaseTicketNumber, "human testing")
	mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	if got := w.at(releaseTicketNumber); got != "In review" {
		t.Fatalf("the ticket is in %q", got)
	}
	mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0", MergePrOptions{}))
	mustRun(t, f, "tag", e.Tag(ctx, "v1.0.0"))
	mustRun(t, f, "sync-back --merge", e.SyncBackMerge(ctx, "v1.0.0"))

	if got := strings.Join(w.moves(), "\n"); got != strings.Join([]string{
		"update-status 1078 In progress",
		"update-status 1078 AI testing",
		"update-status 1078 In review",
		"update-status 1078 Done",
	}, "\n") {
		t.Fatalf("moves:\n%s", got)
	}
	wantOutput(t, f, "Release ticket #1078 is already in human testing, past AI testing: not moved back.")
}

// A moment the preset has no status for is skipped, and the release goes on.
func TestReleaseTicketSkipsAMomentThePresetHasNoStatusFor(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, leanManifest)
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	mustRun(t, f, "tag --rc-branch", e.TagRcBranch(ctx, "v1.0.0-1"))
	wantOutput(t, f, "Release ticket #1078 stays where it is when the RC branch is pushed: its workflow declares no AI testing status.")
	if f.originRef(t, "v1.0.0-1^{commit}") != f.originRef(t, "rc-1.0.0") {
		t.Fatalf("the candidate was not tagged on its RC branch")
	}
	mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	if got := strings.Join(w.moves(), "\n"); got != "update-status 1078 In progress\nupdate-status 1078 In review" {
		t.Fatalf("moves:\n%s", got)
	}
}

// A guard's refusal stops the step with the guard's own message, in the log and as the step's error; the step run again
// once the cause is fixed finishes the ticket's move and nothing else.
func TestReleaseTicketRefusalStopsTheRunAndTheStepCanResume(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	guard := "  The pushed-commits guard refuses: rc-1.0.0 holds a commit origin does not have.\n  Push it, then run update-status again.\n"

	w.refuse("In Progress", "  Complexity label missing.\n")
	mustFail(t, f, "prepare with a refusal", e.PreparePr(ctx, "v1.0.0-1"), `release ticket #1078 was not moved to In Progress, the release is being prepared: ✗ Ticket #1078 cannot move to In Progress.`)
	wantOutput(t, f, "The workflow refused to move release ticket #1078 to In Progress:", "  Complexity label missing.")
	if strings.Contains(f.out.String(), "\x1b") {
		t.Fatalf("the guard's colour codes reached the log:\n%q", f.out.String())
	}
	if _, err := os.Stat(f.worktree()); err == nil {
		t.Fatalf("a refusal of the first move must leave nothing prepared")
	}
	w.lift("In Progress")
	mustRun(t, f, "prepare again", e.PreparePr(ctx, "v1.0.0-1"))

	w.refuse("AI Testing", guard)
	mustFail(t, f, "tag --rc-branch with a refusal", e.TagRcBranch(ctx, "v1.0.0-1"), "release ticket #1078 was not moved to AI Testing")
	wantOutput(t, f, "  The pushed-commits guard refuses: rc-1.0.0 holds a commit origin does not have.", "  Push it, then run update-status again.")
	if f.originRef(t, "v1.0.0-1^{commit}") != f.originRef(t, "rc-1.0.0") {
		t.Fatalf("the candidate is cut on origin all the same: the refusal only stops the run")
	}
	if got := w.at(releaseTicketNumber); got != "In Progress" {
		t.Fatalf("a refused move leaves the ticket in %q", got)
	}

	w.lift("AI Testing")
	f.out.Reset()
	mustRun(t, f, "tag --rc-branch again", e.TagRcBranch(ctx, "v1.0.0-1"))
	wantOutput(t, f, "v1.0.0-1 is already tagged and pushed with rc-1.0.0: nothing to cut again.", "Release ticket #1078 moved from In Progress to AI Testing")
	if got := w.at(releaseTicketNumber); got != "AI Testing" {
		t.Fatalf("the resumed step left the ticket in %q", got)
	}
	if msg := gitIn(t, f.origin, "log", "-1", "--format=%s", "rc-1.0.0"); msg != "chore(#1078): release v1.0.0-1" {
		t.Fatalf("the resumed step cut again: %q", msg)
	}
}

func TestReleaseTicketRefusedInReviewKeepsThePullRequestAndResumes(t *testing.T) {
	t.Parallel()
	f, gh, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0"))
	w.refuse("In Review", "  A new RC needs an open pull request that is not a draft.\n")
	mustFail(t, f, "open-pr with a refusal", e.OpenPr(ctx, "v1.0.0"), "release ticket #1078 was not moved to In Review")
	if gh.called("pr create --base main --head rc-1.0.0") != 1 {
		t.Fatalf("the pull request must be open when the ticket is asked to move: %v", gh.calls)
	}
	if got := w.at(releaseTicketNumber); got != "AI Testing" {
		t.Fatalf("the ticket is in %q", got)
	}
	w.lift("In Review")
	mustRun(t, f, "open-pr again", e.OpenPr(ctx, "v1.0.0"))
	if gh.called("pr create --base main --head rc-1.0.0") != 1 {
		t.Fatalf("the second open-pr opened another pull request: %v", gh.calls)
	}
	if got := w.at(releaseTicketNumber); got != "In Review" {
		t.Fatalf("the ticket is in %q", got)
	}
}

// The workflow's Done guard needs more than a merge: it refuses, the run stops with its message, and the tag and the
// merge stay as they are. The step run again, once the ticket can move, finds nothing to bring back and finishes the move.
func TestReleaseTicketRefusedDoneStopsSyncBackAndResumes(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0", MergePrOptions{}))
	mustRun(t, f, "tag", e.Tag(ctx, "v1.0.0"))
	w.refuse("Done", "  No unique clean main -> develop synchronization PR preserves release commit abc.\n")
	mustFail(t, f, "sync-back --merge with a refusal", e.SyncBackMerge(ctx, "v1.0.0"), "release ticket #1078 was not moved to Done, the release is back on the trunk")
	wantOutput(t, f, "  No unique clean main -> develop synchronization PR preserves release commit abc.")
	gitIn(t, f.origin, "merge-base", "--is-ancestor", "v1.0.0", "develop")
	w.lift("Done")
	f.out.Reset()
	mustRun(t, f, "sync-back --merge again", e.SyncBackMerge(ctx, "v1.0.0"))
	wantOutput(t, f, "develop already holds v1.0.0", "Release ticket #1078 moved from In Review to Done")
}

// A release candidate that came back to the trunk leaves the version's ticket open: it is Done once the public release
// is back.
func TestReleaseCandidateSyncBackLeavesTheTicketOpen(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0-1"))
	mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0-1", MergePrOptions{}))
	mustRun(t, f, "tag", e.Tag(ctx, "v1.0.0-1"))
	mustRun(t, f, "sync-back --merge", e.SyncBackMerge(ctx, "v1.0.0-1"))
	gitIn(t, f.origin, "merge-base", "--is-ancestor", "v1.0.0-1", "develop")
	wantOutput(t, f, "Release ticket #1078 stays open: v1.0.0-1 is a release candidate, and the ticket is Done once the public release is back on develop.")
	if got := w.at(releaseTicketNumber); got != "In Review" {
		t.Fatalf("the ticket of a version whose candidate is back is in %q", got)
	}
	for _, move := range w.moves() {
		if strings.HasSuffix(move, " Done") {
			t.Fatalf("a candidate closed the version's ticket: %v", w.moves())
		}
	}
}

// A step run again, or a ticket already past a status, is never moved back.
func TestReleaseTicketIsNeverMovedBack(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	w.put(releaseTicketNumber, "IN   review")
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr again", e.OpenPr(ctx, "v1.0.0"))
	wantOutput(t, f,
		"Release ticket #1078 is already in IN   review, past In Progress: not moved back.",
		"Release ticket #1078 is already in IN   review, past AI Testing: not moved back.",
		"Release ticket #1078 is already in IN   review.")
	if moves := w.moves(); len(moves) != 0 {
		t.Fatalf("a ticket in review was moved: %v", moves)
	}
	w.put(releaseTicketNumber, "Done")
	mustRun(t, f, "open-pr with the ticket done", e.OpenPr(ctx, "v1.0.0"))
	if moves := w.moves(); len(moves) != 0 || w.at(releaseTicketNumber) != "Done" {
		t.Fatalf("a ticket that is done was moved: %v, now %q", moves, w.at(releaseTicketNumber))
	}
}

// A status the workflow does not declare says nothing of where the ticket stands: it is left alone.
func TestReleaseTicketInAnUnknownStatusIsLeftAlone(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, soloManifest(""))
	w.put(releaseTicketNumber, "Parking lot")
	mustRun(t, f, "prepare --pr", e.PreparePr(context.Background(), "v1.0.0-1"))
	wantOutput(t, f, `Release ticket #1078 is in "Parking lot", which its workflow does not declare: not moved to In Progress.`)
	if moves := w.moves(); len(moves) != 0 {
		t.Fatalf("moves: %v", moves)
	}
}

// A status that cannot be read is no reason to move blindly: the step stops.
func TestReleaseTicketStopsWhenItsStatusCannotBeRead(t *testing.T) {
	t.Parallel()
	f, _, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	for name, want := range map[string]string{
		"status-error":   "could not read the status of the release ticket #1078: gh: HTTP 401: bad credentials",
		"status-garbled": `no "Ticket #1078 is currently in status" line`,
	} {
		if err := os.WriteFile(filepath.Join(w.dir, "refuse", name), nil, 0644); err != nil {
			t.Fatal(err)
		}
		mustFail(t, f, "prepare with "+name, e.PreparePr(ctx, "v1.0.0-1"), want)
		if err := os.Remove(filepath.Join(w.dir, "refuse", name)); err != nil {
			t.Fatal(err)
		}
	}
	if moves := w.moves(); len(moves) != 0 {
		t.Fatalf("a ticket whose status could not be read was moved: %v", moves)
	}
	mustRun(t, f, "prepare once it answers", e.PreparePr(ctx, "v1.0.0-1"))
}

// Without SaaSFoundry, MoltenTerm releases as before and calls nothing: no manifest, a manifest without its workflow
// skill, a skill whose manifest declares no workflow, a commit format that names no ticket.
func TestReleaseWithoutSaaSFoundryCallsNothing(t *testing.T) {
	t.Parallel()
	for name, setup := range map[string]func(t *testing.T, f *fixture) *fakeWorkflow{
		"no manifest": func(t *testing.T, f *fixture) *fakeWorkflow {
			return &fakeWorkflow{t: t, dir: t.TempDir()}
		},
		"no workflow skill": func(t *testing.T, f *fixture) *fakeWorkflow {
			w := installWorkflow(t, f, soloManifest(""))
			if err := os.RemoveAll(filepath.Join(f.checkout, ".claude")); err != nil {
				t.Fatal(err)
			}
			return w
		},
		"a manifest with no workflow": func(t *testing.T, f *fixture) *fakeWorkflow {
			return installWorkflow(t, f, `{"manifestVersion":4,"modules":{"harness":{"managed":true}},"workflow":{"commitFormat":{"requireTicket":true}}}`)
		},
		"a workflow with no status": func(t *testing.T, f *fixture) *fakeWorkflow {
			return installWorkflow(t, f, `{"workflow":{"tool":"github-projects","commitFormat":{"requireTicket":true},"statuses":[]}}`)
		},
		"commits that name no ticket": func(t *testing.T, f *fixture) *fakeWorkflow {
			return installWorkflow(t, f, `{"workflow":{"tool":"github-projects","branchNaming":{"release":"rc-{version}"},"statuses":[{"name":"In Progress"},{"name":"AI Testing"}]}}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			f := makeFixture(t)
			w := setup(t, f)
			gh := &fakePrGitHub{t: t, f: f, checks: []string{"pass"}, state: "CLEAN"}
			e := f.env()
			e.Run = gh.run
			e.Ticket = releaseTicketNumber
			ctx := context.Background()
			mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
			mustRun(t, f, "tag --rc-branch", e.TagRcBranch(ctx, "v1.0.0-1"))
			mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
			mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
			mustRun(t, f, "merge-pr", e.MergePr(ctx, "v1.0.0", MergePrOptions{}))
			mustRun(t, f, "tag", e.Tag(ctx, "v1.0.0"))
			mustRun(t, f, "sync-back --merge", e.SyncBackMerge(ctx, "v1.0.0"))
			if !f.tagOnOrigin(t, "v1.0.0-1") {
				t.Fatalf("the candidate was not tagged")
			}
			gitIn(t, f.origin, "merge-base", "--is-ancestor", "v1.0.0", "develop")
			if calls := w.calls(); len(calls) != 0 {
				t.Fatalf("the workflow's CLI was called: %v", calls)
			}
			for _, said := range []string{"Release ticket #", "its workflow", "ticket's status"} {
				if strings.Contains(f.out.String(), said) {
					t.Fatalf("a project without SaaSFoundry sees nothing of the workflow, the output says %q:\n%s", said, f.out.String())
				}
			}
		})
	}
}

// The direct flow has no RC branch and no pull request to follow: the ticket found in the version's milestone is moved
// when the release is prepared, and nothing else of the workflow is asked for.
func TestReleaseTicketFoundInTheMilestoneIsMovedByTheDirectFlow(t *testing.T) {
	t.Parallel()
	f := makeFixture(t)
	w := installWorkflow(t, f, soloManifest(""))
	f.gh.issues = `[{"number":41,"title":"An open bug"},{"number":1078,"title":"Release v1.0.0"}]`
	e := f.env()
	ctx := context.Background()
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	mustRun(t, f, "finalize", e.Finalize(ctx, "v1.0.0-1"))
	wantCalls(t, f, w, "status 1078", "update-status 1078 In Progress")
	wantOutput(t, f, "Release ticket #1078 moved from Backlog to In Progress")
	if calls := f.gh.called("issue", "create"); len(calls) != 0 {
		t.Fatalf("a second ticket was created: %v", calls)
	}
}

// No escape hatch rides along: the calls name the ticket and the status and nothing else, and what the environment
// carries to switch a guard off does not reach the workflow.
func TestReleaseTicketNeverSetsOrPassesAnEscapeHatch(t *testing.T) {
	serialTest(t, "sets SF_WORKFLOW_BYPASS_* in the process environment, which the workflow's CLI would inherit")
	t.Setenv("SF_WORKFLOW_BYPASS_PUSHED_GUARD", "1")
	t.Setenv("SF_WORKFLOW_BYPASS_REASON", "the developer's own hatch")
	f, _, w, e := prFlowProject(t, soloManifest(""))
	ctx := context.Background()
	mustRun(t, f, "prepare --pr", e.PreparePr(ctx, "v1.0.0-1"))
	mustRun(t, f, "tag --rc-branch", e.TagRcBranch(ctx, "v1.0.0-1"))
	mustRun(t, f, "prepare --pr the public release", e.PreparePr(ctx, "v1.0.0"))
	mustRun(t, f, "open-pr", e.OpenPr(ctx, "v1.0.0"))
	if len(w.moves()) != 3 {
		t.Fatalf("moves: %v", w.moves())
	}
	if hatches := w.hatches(); len(hatches) != 0 {
		t.Fatalf("the workflow's CLI inherited an escape hatch: %v", hatches)
	}
	for _, call := range w.calls() {
		words := strings.Fields(call)
		if len(words) < 2 || (words[0] != "status" && words[0] != "update-status") || words[1] != "1078" {
			t.Fatalf("a call other than a status read or a move: %q", call)
		}
		for _, word := range words {
			if strings.HasPrefix(word, "--") || strings.Contains(strings.ToLower(word), "bypass") {
				t.Fatalf("an option reached the workflow's CLI: %q", call)
			}
		}
	}
}

func TestExecWorkflowDropsTheEscapeHatchesOfTheEnvironment(t *testing.T) {
	t.Parallel()
	kept := withoutWorkflowHatches([]string{"PATH=/bin", "SF_WORKFLOW_BYPASS_NATURE_GUARD=1", "SF_WORKFLOW_BYPASS_REASON=x", "SF_DISABLE_SRS_HOOK=1", "HOME=/h"})
	if strings.Join(kept, " ") != "PATH=/bin SF_DISABLE_SRS_HOOK=1 HOME=/h" {
		t.Fatalf("kept %v", kept)
	}
}

// The code that moves the ticket names no option that switches a guard off; the workflow's own escape hatches are the
// developer's to apply, never MoltenTerm's. (The ticket's creation, #1800, has its own reason for --bypass-srs.)
func TestTheCodeThatMovesATicketNamesNoEscapeHatch(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"ticketstatus.go", filepath.Join("..", "sfticket", "workflow.go")} {
		text := readFile(t, path)
		for _, hatch := range []string{"--bypass", "--skip-local-ci", "bypass-reason", "bypass-srs", "Setenv("} {
			if strings.Contains(text, hatch) {
				t.Errorf("%s names %q", path, hatch)
			}
		}
		if n := strings.Count(text, "SF_WORKFLOW_BYPASS_"); path == "ticketstatus.go" && n != 1 {
			t.Errorf("%s names %d SF_WORKFLOW_BYPASS_ variables: only the prefix it strips is allowed", path, n)
		}
	}
}
