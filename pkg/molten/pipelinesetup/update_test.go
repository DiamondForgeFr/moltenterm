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

// Updating a release setup (#1086): testdata/pre1046-project.json is what the first template (#1030, a93884dd) wrote
// for the SaaSFoundryAI-shaped repository, before its release branch was protected.

func protectedRules(t *testing.T) string {
	t.Helper()
	rules, err := os.ReadFile(filepath.Join("testdata", "rules-branches-protected.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(rules)
}

func pre1046Repository(t *testing.T, edit func(string) string) string {
	t.Helper()
	dir := protectedRepository(t)
	data, err := os.ReadFile(filepath.Join("testdata", "pre1046-project.json"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if edit != nil {
		text = edit(text)
	}
	commitPipeline(t, dir, text)
	return dir
}

// updateAndMerge opens the update's pull request and merges it.
func updateAndMerge(t *testing.T, s *Setup, req UpdateRequest) PrJob {
	t.Helper()
	req.Ticket = 7
	job := waitFor(t, s)(s.Update(context.Background(), req))
	if job.Failure != nil {
		t.Fatalf("the update failed: %+v", job.Failure)
	}
	mergePr(t, req.Dir, job.Branch)
	return job
}

func readRecordFile(t *testing.T, dir string) *Record {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(RecordFile)))
	if err != nil {
		return nil
	}
	return recordFrom(data)
}

func readPipeline(t *testing.T, dir string) *molten.Pipeline {
	t.Helper()
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		t.Fatalf("the pipeline is not valid: %v", report.Errors)
	}
	return report.Pipeline
}

func withoutProposals(r *molten.PipelineRelease) {
	for _, steps := range [][]molten.PipelineStep{r.Rc, r.Public} {
		for i := range steps {
			steps[i].Check = nil
		}
	}
}

func changeByKey(changes []Change, key string) (Change, bool) {
	for _, c := range changes {
		if c.Key == key {
			return c, true
		}
	}
	return Change{}, false
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCheckOffersTheUpdateToAPre1046PipelineOnAProtectedBranch(t *testing.T) {
	dir := pre1046Repository(t, nil)
	s := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil)
	ctx := context.Background()
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if check.State != UpdateStateUpdate || check.RecordTemplate != 0 || check.Template != TemplateVersion {
		t.Fatalf("state %s, record %d", check.State, check.RecordTemplate)
	}
	if len(check.Reasons) < 3 || check.Reasons[0] != (UpdateReason{Code: UpdateReasonProtected, Detail: "master"}) ||
		check.Reasons[1].Code != UpdateReasonLabels || check.Reasons[2].Code != UpdateReasonTemplate {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
	for _, want := range []string{
		"removed:rc/promote", "changed:rc/prepare", "removed:rc/finalize", "added:rc/tag", "removed:rc/sync-back",
		"removed:public/promote", "added:public/reconcile", "added:public/open-pr", "added:public/merge-pr", "added:public/tag",
		"removed:public/finalize", "changed:public/sync-back", "versions:versions",
	} {
		kind, key, _ := strings.Cut(want, ":")
		c, ok := changeByKey(check.Changes, key)
		if !ok || c.Kind != kind || c.Customised || !c.Take {
			t.Fatalf("%s: %+v (all: %v)", want, c, ChangeKeys(check.Changes))
		}
	}
	if len(check.Errors) > 0 {
		t.Fatalf("the update is not valid: %v\n%s", check.Errors, check.Proposed)
	}

	// The update gives what a fresh setup of the same repository writes.
	fresh := protectedRepository(t)
	draft, err := s.Draft(ctx, DraftRequest{Dir: fresh})
	if err != nil {
		t.Fatal(err)
	}
	// The checks and the formatter are proposed at a new setup's step 3 only (#1104), not offered as an update.
	withoutProposals(draft.Proposal.Release)
	s.TreesDir = t.TempDir()
	job := updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature})
	if job.Subject != "chore(#7): update the release setup" {
		t.Fatalf("subject: %s", job.Subject)
	}
	updated := readPipeline(t, dir)
	if got, want := jsonOf(t, updated.Release), jsonOf(t, draft.Proposal.Release); got != want {
		t.Fatalf("release after the update:\n%s\nfresh setup:\n%s", got, want)
	}
	if got, want := jsonOf(t, updated.Versions), jsonOf(t, draft.Proposal.Versions); got != want {
		t.Fatalf("versions after the update:\n%s\nfresh setup:\n%s", got, want)
	}
	rec := readRecordFile(t, dir)
	if rec == nil || rec.Template != TemplateVersion || len(rec.Steps) != len(updated.Release.Rc)+len(updated.Release.Public) {
		t.Fatalf("record: %+v", rec)
	}
	again, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if again.State != UpdateStateUpToDate || len(again.Changes) != 0 || len(again.Reasons) != 0 {
		t.Fatalf("after the update: %s %v", again.State, ChangeKeys(again.Changes))
	}
}

// The developer's own step and a step whose command they changed are kept unless they choose otherwise.
func TestUpdateKeepsTheDevelopersSteps(t *testing.T) {
	dir := pre1046Repository(t, func(text string) string {
		text = strings.Replace(text, `"run": "molten release close-milestone {tag}"
            },`, `"run": "molten release close-milestone {tag}"
            },
            { "id": "notify", "title": "Tell the team", "phase": "publish", "run": "./scripts/notify.sh {tag}" },`, 1)
		return strings.Replace(text, `"title": "Carry the release commit back to develop by pull request",
                "phase": "back",
                "run": "molten release sync-back {tag}"
            }
        ]
    }`, `"title": "Carry the release commit back to develop by pull request",
                "phase": "back",
                "run": "./scripts/sync-back.sh {tag}"
            }
        ]
    }`, 1)
	})
	writeFiles(t, dir, map[string]string{"scripts/notify.sh": "#!/bin/sh\n", "scripts/sync-back.sh": "#!/bin/sh\n"})
	gitIn(t, dir, "add", "scripts")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#4): scripts")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
	s := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil)
	s.TreesDir = t.TempDir()
	ctx := context.Background()
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	notify, _ := changeByKey(check.Changes, "public/notify")
	syncBack, _ := changeByKey(check.Changes, "public/sync-back")
	if notify.Kind != ChangeRemoved || !notify.Customised || notify.Take {
		t.Fatalf("notify: %+v", notify)
	}
	if syncBack.Kind != ChangeChanged || !syncBack.Customised || syncBack.Take || !strings.Contains(syncBack.Before, "./scripts/sync-back.sh") {
		t.Fatalf("sync-back: %+v", syncBack)
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature})
	public := readPipeline(t, dir).Release.Public
	if got := strings.Join(stepIds(public), ","); got != "prepare,reconcile,changelog-en,changelog-fr,open-pr,merge-pr,tag,close-milestone,notify,dispatch-deploy-docs,sync-back" {
		t.Fatalf("public steps: %s", got)
	}
	if s, _ := stepById(public, "sync-back"); s.Run != "./scripts/sync-back.sh {tag}" {
		t.Fatalf("the customised sync-back was replaced: %+v", s)
	}
	// Declined once, not offered again.
	again, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if again.State != UpdateStateUpToDate {
		t.Fatalf("declined changes are offered again: %v", ChangeKeys(again.Changes))
	}

	// Edited after the update: a customisation, kept by default; chosen, the template's version comes back.
	text, _ := os.ReadFile(filepath.Join(dir, molten.ProjectPipelineFile))
	edited := strings.Replace(string(text), "Close the milestone once the release is published", "Close the milestone after the announcement", 1)
	commitPipeline(t, dir, edited)
	check, err = s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	milestone, ok := changeByKey(check.Changes, "public/close-milestone")
	if !ok || !milestone.Customised || milestone.Take || len(check.Changes) != 1 || len(check.Reasons) != 1 || check.Reasons[0].Code != UpdateReasonCustomised {
		t.Fatalf("changes: %+v, reasons: %+v", check.Changes, check.Reasons)
	}
	choices := map[string]bool{"public/close-milestone": true}
	preview, err := s.Check(ctx, CheckRequest{Dir: dir, Choices: choices})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(preview.Proposed, "after the announcement") || !strings.Contains(check.Proposed, "after the announcement") {
		t.Fatal("the proposed text does not follow the choices")
	}
	updateAndMerge(t, s, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature, Choices: choices})
	if m, _ := stepById(readPipeline(t, dir).Release.Public, "close-milestone"); m.Title != "Close the milestone once the release is published" {
		t.Fatalf("close-milestone: %+v", m)
	}
}

func TestUpdateRefusesAChangedFileOrList(t *testing.T) {
	dir := pre1046Repository(t, nil)
	s := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil)
	ctx := context.Background()
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	s.TreesDir = t.TempDir()
	stale := waitFor(t, s)(s.Update(ctx, UpdateRequest{Dir: dir, Base: "stale", Signature: check.Signature, PrRequest: PrRequest{Ticket: 7}}))
	if stale.Failure == nil || stale.Failure.Code != PrFailureMoved {
		t.Fatalf("a file changed since the check must be refused: %+v", stale.Failure)
	}
	other := waitFor(t, s)(s.Update(ctx, UpdateRequest{Dir: dir, Base: check.Base, Signature: "other", PrRequest: PrRequest{Ticket: 7}}))
	if other.Failure == nil || other.Failure.Code != PrFailureUpdateChanged {
		t.Fatalf("a list changed since the check must be refused: %+v", other.Failure)
	}
	before, _ := os.ReadFile(filepath.Join(dir, molten.ProjectPipelineFile))
	if !strings.Contains(string(before), `"id": "promote"`) || readRecordFile(t, dir) != nil {
		t.Fatal("a refused update wrote something")
	}
	if heads := gitOut(t, dir, "ls-remote", "--heads", "origin"); strings.Contains(heads, "release-pipeline") {
		t.Fatalf("a refused update pushed: %s", heads)
	}
	if _, err := s.Update(ctx, UpdateRequest{Dir: dir, Base: check.Base, Signature: check.Signature}); err == nil {
		t.Fatal("the commit format needs a ticket")
	}
}

// An unprotected release branch keeps the promotion: a pre-#1046 pipeline only gets the version labels.
func TestCheckUnprotectedPre1046PipelineOffersTheLabelsOnly(t *testing.T) {
	dir := pre1046Repository(t, nil)
	s := MakeSetup(githubAs(t, "[]", nil), nil)
	check, err := s.Check(context.Background(), CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(ChangeKeys(check.Changes), ","); got != "versions:versions" {
		t.Fatalf("changes: %s", got)
	}
	if len(check.Reasons) != 1 || check.Reasons[0].Code != UpdateReasonLabels || check.Reasons[0].Detail != "3" {
		t.Fatalf("reasons: %+v", check.Reasons)
	}
}

func TestCheckWithoutReleaseIsMissing(t *testing.T) {
	dir := protectedRepository(t)
	check, err := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil).Check(context.Background(), CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if check.State != UpdateStateMissing {
		t.Fatalf("state: %s", check.State)
	}
}

// A fresh setup records the steps written as the template drafted them; one the developer changed in between is not.
func TestWriteRecordsTheGeneratedSteps(t *testing.T) {
	dir := protectedRepository(t)
	s := MakeSetup((&fakeForge{}).runner(t, protectedRules(t)), nil)
	draft, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Replace(draft.Proposed, "Close the milestone once the release is published", "Close the milestone", 1)
	s.TreesDir = t.TempDir()
	job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: text, Base: draft.Base, Generated: draft.Generated, PrRequest: PrRequest{Ticket: 7}}))
	if job.Failure != nil {
		t.Fatalf("failure: %+v", job.Failure)
	}
	mergePr(t, dir, job.Branch)
	rec := readRecordFile(t, dir)
	if rec == nil || rec.Steps["public/open-pr"] == "" || rec.Steps["public/close-milestone"] != "" {
		t.Fatalf("record: %+v", rec)
	}
}
