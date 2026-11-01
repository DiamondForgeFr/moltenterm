// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

const stalledHead = "c20e007895f1c3e20de859e18438c3e33f8ddd3c"

// The case of #1713: the agent posted "AI testing / Local CI" pending on 2026-10-28, its `molten ci run` was refused
// for untrusted commands, and the PR read "CI running · 1 of 18" four days later.
func stalledPr(started time.Time) ReviewPr {
	rollup := []ghReviewRollup{
		{Name: "Unit Tests", WorkflowName: "CI", Status: "COMPLETED", Conclusion: "SUCCESS", StartedAt: "2026-10-28T13:00:00Z"},
		{Context: "AI testing / Local CI", State: "PENDING", StartedAt: started.UTC().Format(time.RFC3339)},
	}
	return ReviewPr{Number: 1116, HeadOid: stalledHead, Mergeable: "MERGEABLE", MergeState: "UNSTABLE",
		Merge: reviewMergeWithChecks(ReviewMergeOfPr("MERGEABLE", "UNSTABLE"), SummarizeReviewChecks(rollup)),
		Ci:    SummarizeReviewChecks(rollup)}
}

func checkNamed(t *testing.T, pr ReviewPr, name string) ReviewCheck {
	t.Helper()
	for _, check := range pr.Ci.Checks {
		if check.Name == name {
			return check
		}
	}
	t.Fatalf("no check %s in %+v", name, pr.Ci.Checks)
	return ReviewCheck{}
}

func TestIsLocalCiCheck(t *testing.T) {
	for name, want := range map[string]bool{
		"local-unit":             true,
		"AI testing / Local CI":  true,
		"AI testing / local CI":  true,
		"AI testing / Built app": false,
		"Unit Tests":             false,
		"CI / Required gate":     false,
	} {
		if got := IsLocalCiCheck(name); got != want {
			t.Errorf("IsLocalCiCheck(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestReconcileLocalCiWaitingForApproval(t *testing.T) {
	now := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	pr := stalledPr(now.Add(-4 * 24 * time.Hour))
	if pr.Ci.Pending != 1 || pr.Merge != ReviewMergeRunning {
		t.Fatalf("GitHub's view first: %+v merge %s", pr.Ci, pr.Merge)
	}
	reconcileLocalCi(&pr, localCiFacts{untrusted: true}, now)
	if got := checkNamed(t, pr, "AI testing / Local CI").State; got != ReviewCheckUntrusted {
		t.Fatalf("waiting for approval, got %s", got)
	}
	if pr.Ci.Pending != 0 || pr.Ci.Untrusted != 1 || pr.Ci.State != ReviewCheckUntrusted {
		t.Fatalf("counts: %+v", pr.Ci)
	}
	if pr.Merge == ReviewMergeRunning {
		t.Fatal("nothing runs: the merge state no longer says running")
	}
}

func TestReconcileLocalCiInterrupted(t *testing.T) {
	now := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	posted := now.Add(-4 * 24 * time.Hour)
	// A run of this computer on that commit left behind: interrupted, at its last sign of life.
	pr := stalledPr(posted)
	run := CiRunRecord{Id: "r1", Sha: stalledHead, Status: CiStateInterrupted, StartedAt: posted.UnixMilli(), FinishedAt: posted.Add(time.Hour).UnixMilli()}
	reconcileLocalCi(&pr, localCiFacts{runs: []CiRunRecord{run}}, now)
	check := checkNamed(t, pr, "AI testing / Local CI")
	if check.State != ReviewCheckInterrupted || check.StoppedAt != run.FinishedAt {
		t.Fatalf("interrupted at the run's last sign of life: %+v", check)
	}
	if pr.Ci.Interrupted != 1 || pr.Ci.Pending != 0 {
		t.Fatalf("counts: %+v", pr.Ci)
	}
}

// No run record here, commands approved: the status may be another computer's or a teammate's, so it is neither
// running nor interrupted; it keeps when it was posted.
func TestReconcileLocalCiNotOnThisComputer(t *testing.T) {
	now := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	posted := now.Add(-4 * 24 * time.Hour)
	other := CiRunRecord{Id: "r0", Sha: "0000000000000000000000000000000000000000", Status: CiStateInterrupted, FinishedAt: posted.UnixMilli()}
	for _, facts := range []localCiFacts{{}, {runs: []CiRunRecord{other}}} {
		pr := stalledPr(posted)
		reconcileLocalCi(&pr, facts, now)
		check := checkNamed(t, pr, "AI testing / Local CI")
		if check.State != ReviewCheckNotLocal || check.StoppedAt != 0 || check.StartedAt != posted.Format(time.RFC3339) {
			t.Fatalf("not on this computer: %+v", check)
		}
		if pr.Ci.NotLocal != 1 || pr.Ci.Pending != 0 || pr.Ci.Interrupted != 0 || pr.Ci.State != ReviewCheckNotLocal {
			t.Fatalf("counts: %+v", pr.Ci)
		}
	}
}

func TestReconcileLocalCiLeavesLiveChecks(t *testing.T) {
	now := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	recent := stalledPr(now.Add(-30 * time.Second))
	reconcileLocalCi(&recent, localCiFacts{untrusted: true}, now)
	if got := checkNamed(t, recent, "AI testing / Local CI").State; got != ReviewCheckPending {
		t.Fatalf("a status just posted may be starting its run, got %s", got)
	}
	old := stalledPr(now.Add(-time.Hour))
	reconcileLocalCi(&old, localCiFacts{activeSha: stalledHead}, now)
	if got := checkNamed(t, old, "AI testing / Local CI").State; got != ReviewCheckPending {
		t.Fatalf("a run works on the head, got %s", got)
	}
	other := stalledPr(now.Add(-time.Hour))
	other.Ci.Checks = append(other.Ci.Checks, ReviewCheck{Name: "CI / slow", State: ReviewCheckPending})
	countReviewCi(&other.Ci)
	reconcileLocalCi(&other, localCiFacts{}, now)
	if got := checkNamed(t, other, "CI / slow").State; got != ReviewCheckPending || other.Ci.State != ReviewCheckPending {
		t.Fatalf("GitHub's own checks keep their state: %s %+v", got, other.Ci)
	}
}

func TestReconcileLocalCiTakesTheLocalVerdict(t *testing.T) {
	now := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	posted := now.Add(-time.Hour)
	for _, status := range []string{CiStateSuccess, CiStateFailure} {
		pr := stalledPr(posted)
		run := CiRunRecord{Id: "r2", Sha: stalledHead, Status: status, StartedAt: posted.UnixMilli(), FinishedAt: now.Add(-time.Minute).UnixMilli()}
		reconcileLocalCi(&pr, localCiFacts{runs: []CiRunRecord{run}}, now)
		if got := checkNamed(t, pr, "AI testing / Local CI").State; got != status {
			t.Fatalf("the agent's status reads as the local verdict %s, got %s", status, got)
		}
	}
	// A verdict older than the status says nothing of it.
	pr := stalledPr(posted)
	run := CiRunRecord{Id: "r3", Sha: stalledHead, Status: CiStateSuccess, FinishedAt: posted.Add(-time.Hour).UnixMilli()}
	reconcileLocalCi(&pr, localCiFacts{runs: []CiRunRecord{run}}, now)
	if got := checkNamed(t, pr, "AI testing / Local CI").State; got != ReviewCheckNotLocal {
		t.Fatalf("an older verdict: no run of it here, got %s", got)
	}
}

func TestCiInterruptedRunStoppedAtItsLastSignOfLife(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"a","run":"true"},{"name":"b","run":"true"}]}`)
	c.writeRecord(CiRunRecord{Id: "20260101-000000-bbbbbb", Dir: dir, Status: CiStateRunning, StartedAt: 1000, SeenAt: 9000,
		Jobs: []CiJobRecord{{Name: "a", Status: CiStateSuccess, StartedAt: 2000, FinishedAt: 3000}, {Name: "b", Status: CiStateRunning, StartedAt: 3000}}})
	runs := c.runs(dir)
	if len(runs) != 1 || runs[0].Status != CiStateInterrupted || runs[0].FinishedAt != 9000 {
		t.Fatalf("stopped at the heartbeat: %+v", runs)
	}
	if again := c.runs(dir); again[0].FinishedAt != 9000 {
		t.Fatalf("kept once written: %+v", again)
	}
}

func TestCiStatusExplainsNotRun(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"a","run":"true"}]}`)
	sha := gitIn(t, dir, "rev-parse", "HEAD")
	tree := gitIn(t, dir, "rev-parse", "HEAD^{tree}")
	c.writeRecord(CiRunRecord{Id: "20260101-000000-cccccc", Dir: dir, Sha: sha, Tree: tree, Status: CiStateRunning, StartedAt: 1000, SeenAt: 5000,
		Jobs: []CiJobRecord{{Name: "a", Status: CiStateRunning, StartedAt: 2000}}})
	v, err := c.StatusFrom(dir, "develop", "")
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != CiStateInterrupted || v.RunId != "20260101-000000-cccccc" || v.StoppedAt != 5000 {
		t.Fatalf("interrupted: %+v", v)
	}
	os.WriteFile(filepath.Join(dir, ".molten", "project.json"), []byte(`{"schema":1,"name":"P","ci":{"jobs":[{"name":"a","run":"false"}]}}`), 0644)
	if v, err = c.StatusFrom(dir, "develop", ""); err != nil || v.Status != CiStateUntrusted {
		t.Fatalf("changed commands wait for approval: %+v %v", v, err)
	}
	if plain, err := c.Status(dir, "develop"); err != nil || plain.Status != CiVerdictMissing {
		t.Fatalf("Status keeps its verdict words for the other readers: %+v %v", plain, err)
	}
}

func TestReconcileAnswerOnlyWithALocalCi(t *testing.T) {
	c, dir := makeCiFixture(t, `{"jobs":[{"name":"a","run":"true"}]}`)
	now := time.Now()
	answer := ReviewsAnswer{Dir: dir, Ready: []ReviewPr{stalledPr(now.Add(-time.Hour))}}
	reconcileAnswerLocalCi(c, &answer, now)
	if got := checkNamed(t, answer.Ready[0], "AI testing / Local CI").State; got != ReviewCheckNotLocal {
		t.Fatalf("trusted, no run here: not on this computer, got %s", got)
	}
	plain := ReviewsAnswer{Dir: t.TempDir(), Ready: []ReviewPr{stalledPr(now.Add(-time.Hour))}}
	reconcileAnswerLocalCi(c, &plain, now)
	if got := checkNamed(t, plain.Ready[0], "AI testing / Local CI").State; got != ReviewCheckPending {
		t.Fatalf("a project without a local CI keeps GitHub's word, got %s", got)
	}
}

func TestTrustNoticeSaysTheCiIsBlocked(t *testing.T) {
	notice := trustNotice("/p/SaaSFoundry", nil, "")
	if notice.TitleText == nil || notice.TitleText.Code != "notif.trust.title" || len(notice.Actions) != 1 {
		t.Fatalf("notice: %+v", notice)
	}
	if notice.Actions[0].Gesture != TrustReviewGesture || notice.Actions[0].Label != "Approve the commands…" {
		t.Fatalf("the main action approves: %+v", notice.Actions[0])
	}
}
