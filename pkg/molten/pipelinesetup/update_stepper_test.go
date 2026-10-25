// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Step 2a for a project already set up (#1102): the check drawn, adjusted, and the uncommitted edits as changes.

// Step 2a proposes what a new setup's step 3 does (#1104): a check on each changelog step and the project's formatter,
// as changes to tick; the Release menu's check does not, and a check taken is never offered back for removal.
func TestStep2aProposesTheChecksAndTheFormatter(t *testing.T) {
	dir, s := upToDateRepository(t)
	writeFiles(t, dir, map[string]string{"package.json": `{ "name": "saasfoundryai", "version": "1.0.4", "scripts": { "format": "prettier --write" } }`})
	gitIn(t, dir, "commit", "--quiet", "-am", "chore(#4): format script")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
	ctx := context.Background()
	menu, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if menu.State != UpdateStateUpToDate {
		t.Fatalf("the menu's check offers the proposals: %v", ChangeKeys(menu.Changes))
	}
	check, err := s.Check(ctx, CheckRequest{Dir: dir, Proposals: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"public/changelog-en", "public/changelog-fr", "rc/changelog-en"} {
		c, ok := changeByKey(check.Changes, key)
		if !ok || c.Kind != ChangeChanged || !c.Take || c.Customised || !strings.Contains(c.After, `"check"`) {
			t.Fatalf("%s: %+v (all: %v)", key, c, ChangeKeys(check.Changes))
		}
	}
	versions, ok := changeByKey(check.Changes, VersionsKey)
	if !ok || !strings.Contains(versions.After, "npm run format --") {
		t.Fatalf("the formatter: %+v", versions)
	}
	if len(check.Reasons) != 1 || check.Reasons[0].Code != UpdateReasonProposed {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature, Proposals: true})
	if c, _ := stepById(readPipeline(t, dir).Release.Public, "changelog-en"); c.Check == nil {
		t.Fatalf("the check was not written: %+v", c)
	}
	after, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if after.State != UpdateStateUpToDate {
		t.Fatalf("the checks taken are offered back: %v", ChangeKeys(after.Changes))
	}
}

// The formatter added to SaaSFoundryAI's versions block: one new field, the version files as written.
func TestKeptVersionsAddsOnlyTheNewField(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "saasfoundry-committed-f191383e.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Versions *molten.PipelineVersions `json:"versions"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Versions == nil {
		t.Fatalf("no versions block: %v", err)
	}
	file.Versions.Format = "npm run format --"
	kept, ok := keptVersions(data, file.Versions)
	if !ok {
		t.Fatal("the versions block was not read")
	}
	text, err := MergeTopLevel(data, nil, []keyValue{{Key: "versions", Value: kept}})
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		have[line] = true
	}
	var added []string
	for _, line := range strings.Split(string(text), "\n") {
		if !have[line] {
			added = append(added, line)
		}
	}
	// The format line, and the comma the field before it gains.
	if len(added) != 2 || !strings.Contains(strings.Join(added, "\n"), `"format": "npm run format --"`) {
		t.Fatalf("added lines: %q", added)
	}
}

// SaaSFoundryAI's committed pipeline writes short steps on one line: a change keeps every other step's text.
func TestKeptReleaseKeepsTheStepsAsWritten(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "saasfoundry-committed-f191383e.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Release *molten.PipelineRelease `json:"release"`
	}
	if err := json.Unmarshal(data, &file); err != nil || file.Release == nil {
		t.Fatalf("not a pipeline with a release: %v", err)
	}
	cur := file.Release
	merged := &molten.PipelineRelease{Rc: cur.Rc}
	for _, s := range cur.Public {
		if s.Id != "close-milestone" {
			merged.Public = append(merged.Public, s)
		}
	}
	kept, ok := keptRelease(data, merged)
	if !ok {
		t.Fatal("the release block was not read step by step")
	}
	text, err := MergeTopLevel(data, nil, []keyValue{{Key: "release", Value: kept}})
	if err != nil {
		t.Fatal(err)
	}
	removed := strings.Count(string(data), "\n") - strings.Count(string(text), "\n")
	if removed != 1 || strings.Contains(string(text), "close-milestone") {
		t.Fatalf("%d lines removed:\n%s", removed, text)
	}
	have := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		have[line] = true
	}
	for _, line := range strings.Split(string(text), "\n") {
		if !have[line] {
			t.Fatalf("a kept step was rewritten: %q", line)
		}
	}
}

// upToDateRepository: the pre-#1046 pipeline updated once, so the check finds nothing to change.
func upToDateRepository(t *testing.T) (string, *Setup) {
	t.Helper()
	dir := pre1046Repository(t, nil)
	s := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil)
	s.TreesDir = t.TempDir()
	check, err := s.Check(context.Background(), CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature})
	again, err := s.Check(context.Background(), CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if again.State != UpdateStateUpToDate {
		t.Fatalf("not up to date: %v", ChangeKeys(again.Changes))
	}
	return dir, s
}

func TestCheckDrawsTheRemovedAndAddedStepsInPlace(t *testing.T) {
	dir := pre1046Repository(t, nil)
	s := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil)
	check, err := s.Check(context.Background(), CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if check.Drawn == nil || check.Options == nil || check.Adjusted {
		t.Fatalf("drawn %v, options %v, adjusted %v", check.Drawn, check.Options, check.Adjusted)
	}
	got := strings.Join(stepIds(check.Drawn.Public), ",")
	for _, id := range []string{"promote", "finalize", "open-pr", "merge-pr", "reconcile", "sync-back"} {
		if !strings.Contains(","+got+",", ","+id+",") {
			t.Fatalf("%s is not drawn: %s", id, got)
		}
	}
	if strings.Index(got, "promote") > strings.Index(got, "open-pr") {
		t.Fatalf("a removed step is drawn after the steps that followed it: %s", got)
	}
}

// An up-to-date pipeline can still be adjusted: the adjustment's changes are offered and written by pull request.
func TestCheckAdjustsAnUpToDatePipeline(t *testing.T) {
	dir, s := upToDateRepository(t)
	ctx := context.Background()
	plain, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	same := *plain.Options
	unchanged, err := s.Check(ctx, CheckRequest{Dir: dir, Options: &same})
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.State != UpdateStateUpToDate || unchanged.Adjusted {
		t.Fatalf("the inferred choices given back are not an adjustment: %s %v", unchanged.State, ChangeKeys(unchanged.Changes))
	}
	adjusted := *plain.Options
	adjusted.Milestone = false
	adjusted.Channels = []string{ChannelPublic}
	check, err := s.Check(ctx, CheckRequest{Dir: dir, Options: &adjusted})
	if err != nil {
		t.Fatal(err)
	}
	if check.State != UpdateStateUpdate || !check.Adjusted {
		t.Fatalf("state %s, adjusted %v", check.State, check.Adjusted)
	}
	if got := strings.Join(ChangeKeys(check.Changes), ","); got != "removed:public/close-milestone" {
		t.Fatalf("changes: %s", got)
	}
	if len(check.Reasons) != 1 || check.Reasons[0].Code != UpdateReasonAdjusted {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
	// The steps that stay keep their text: removing one adds no line.
	have := map[string]bool{}
	for _, line := range strings.Split(check.Current, "\n") {
		have[line] = true
	}
	for _, line := range strings.Split(check.Proposed, "\n") {
		if !have[line] {
			t.Fatalf("a kept step was rewritten: %q\n%s", line, check.Proposed)
		}
	}
	if len(check.Options.Channels) != 2 {
		t.Fatalf("an adjustment drops no channel: %v", check.Options.Channels)
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature, Options: &adjusted})
	if _, ok := stepById(readPipeline(t, dir).Release.Public, "close-milestone"); ok {
		t.Fatal("the adjustment was not written")
	}
	if len(readPipeline(t, dir).Release.Rc) == 0 {
		t.Fatal("the release candidate was dropped")
	}
	after, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if after.State != UpdateStateUpToDate {
		t.Fatalf("after the adjustment: %v", ChangeKeys(after.Changes))
	}
}

// Nothing to change: the update refuses to open a pull request.
func TestUpdateRefusesAnUpToDatePipeline(t *testing.T) {
	dir, s := upToDateRepository(t)
	check, err := s.Check(context.Background(), CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if check.Proposed != check.Current {
		t.Fatalf("nothing changes, yet the proposed text differs:\n%s\n---\n%s", check.Current, check.Proposed)
	}
	job := waitFor(t, s)(s.Update(context.Background(), UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature, PrRequest: PrRequest{Ticket: 7}}))
	if job.Failure == nil || job.Failure.Code != PrFailureUpdateChanged {
		t.Fatalf("an update with nothing to change must be refused: %+v", job.Failure)
	}
}

// Uncommitted edits, included, are changes of their own: one per release step, one for the rest of the file; one
// left out keeps its committed text and is not recorded as declined.
func TestCheckListsTheUncommittedEditsAsChanges(t *testing.T) {
	dir, s := upToDateRepository(t)
	ctx := context.Background()
	path := filepath.Join(dir, molten.ProjectPipelineFile)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Replace(string(data), "Close the milestone once the release is published", "Close the milestone after the announcement", 1)
	text = strings.Replace(text, `"name": "SaaSFoundryAI",`, `"name": "SaaSFoundryAI CLI",`, 1)
	if text == string(data) {
		t.Fatal("the fixture did not change")
	}
	writeFiles(t, dir, map[string]string{molten.ProjectPipelineFile: text})

	ignored, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if ignored.State != UpdateStateUpToDate || !ignored.Pr.Uncommitted {
		t.Fatalf("left out, the edits change nothing: %s %v", ignored.State, ChangeKeys(ignored.Changes))
	}
	check, err := s.Check(ctx, CheckRequest{Dir: dir, IncludeLocal: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ChangeKeys(check.Changes), ","); got != "changed:local/file,changed:local/public/close-milestone,changed:public/close-milestone" {
		t.Fatalf("changes: %s", got)
	}
	file, _ := changeByKey(check.Changes, LocalFileKey)
	if !file.Local || !file.Take || file.Title != "name" || !strings.Contains(file.After, "SaaSFoundryAI CLI") || !strings.Contains(file.Before, "SaaSFoundryAI") {
		t.Fatalf("the file change: %+v", file)
	}
	// The edited step reads as the developer's own against the template: offered, kept unless ticked.
	if c, _ := changeByKey(check.Changes, "public/close-milestone"); !c.Customised || c.Take {
		t.Fatalf("the template's version: %+v", c)
	}
	if len(check.Reasons) != 2 || check.Reasons[0].Code != UpdateReasonLocal || check.Reasons[1].Code != UpdateReasonCustomised {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
	if !strings.Contains(check.Proposed, "after the announcement") || !strings.Contains(check.Proposed, "SaaSFoundryAI CLI") {
		t.Fatalf("every edit ticked, the working copy is proposed:\n%s", check.Proposed)
	}
	choices := map[string]bool{"local/public/close-milestone": false}
	partial, err := s.Check(ctx, CheckRequest{Dir: dir, IncludeLocal: true, Choices: choices})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(partial.Proposed, "after the announcement") || !strings.Contains(partial.Proposed, "SaaSFoundryAI CLI") {
		t.Fatalf("a left-out step keeps its committed text:\n%s", partial.Proposed)
	}
	known := map[string]bool{}
	for _, line := range strings.Split(partial.Current+text, "\n") {
		known[line] = true
	}
	for _, line := range strings.Split(partial.Proposed, "\n") {
		if !known[line] {
			t.Fatalf("a step was rewritten: %q", line)
		}
	}
	if len(partial.Errors) > 0 {
		t.Fatalf("errors: %v", partial.Errors)
	}
	job := waitFor(t, s)(s.Update(ctx, UpdateRequest{Dir: dir, Base: partial.Base, Signature: partial.Signature, Choices: choices,
		PrRequest: PrRequest{IncludeLocal: true, LocalBase: partial.Pr.LocalBase, Ticket: 7}}))
	if job.Failure != nil {
		t.Fatalf("the update failed: %+v", job.Failure)
	}
	if got, _ := os.ReadFile(path); string(got) != text {
		t.Fatal("the working copy's edits were touched")
	}
	gitIn(t, dir, "checkout", "--quiet", "--", molten.ProjectPipelineFile)
	mergePr(t, dir, job.Branch)
	merged := readPipeline(t, dir)
	if m, _ := stepById(merged.Release.Public, "close-milestone"); m.Title != "Close the milestone once the release is published" {
		t.Fatalf("close-milestone: %+v", m)
	}
	if merged.Name != "SaaSFoundryAI CLI" {
		t.Fatalf("the edit outside the release steps was lost: %q", merged.Name)
	}
	if rec := readRecordFile(t, dir); rec == nil || len(rec.Declined) != 0 {
		t.Fatalf("a left-out edit was recorded as declined: %+v", rec)
	}
}
