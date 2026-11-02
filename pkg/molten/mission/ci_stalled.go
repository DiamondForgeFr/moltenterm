// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A local CI that nothing runs never reads as running (#1713, FR-MC-011, FR-REV-001). GitHub keeps a pending commit
// status forever once its poster is gone: the local-<job> statuses of a run whose MoltenTerm stopped, or the "AI
// testing / Local CI" status an agent posts before `molten ci run` and never updates when the run is refused for
// untrusted commands or the agent stops. The local CI knows better: its commands may wait for the developer's
// approval, its own run on that commit was interrupted, it has its own verdict, or it has no run of it at all (then
// the status may be another computer's). `molten ci status` and the Integration cards say the same.

const (
	CiStateUntrusted = "untrusted"

	ReviewCheckInterrupted = "interrupted"
	ReviewCheckUntrusted   = "untrusted"
	// No run of it on this computer and the commands approved: it may run on another computer, so it is neither
	// running nor interrupted here.
	ReviewCheckNotLocal = "notlocal"

	// A local CI status this recent keeps its running state: its run may be starting.
	reviewLocalCiGrace = 2 * time.Minute
	// The step sf-workflow's ai-status posts as "AI testing / <step>"; the local CI's is named after it.
	aiTestingStatusPrefix = "ai testing / "
	aiTestingLocalCiStep  = "local ci"
)

func (c *Ci) commandsUntrusted(dir string, pipeline *molten.Pipeline) bool {
	if c.trust == nil || pipeline == nil {
		return false
	}
	return !c.trust.IsTrusted(dir, CommandsHash(PipelineCommands(pipeline)))
}

// explainNotRun tells why a code with no verdict has none: the commands wait for approval, or its last run was
// interrupted (and when it stopped).
func (c *Ci) explainNotRun(dir string, pipeline *molten.Pipeline, v *CiCodeVerdict) {
	if v.Status != CiVerdictMissing {
		return
	}
	if c.commandsUntrusted(dir, pipeline) {
		v.Status = CiStateUntrusted
		return
	}
	for _, rec := range c.runs(dir) {
		if rec.Tree != v.Tree && rec.Sha != v.Sha {
			continue
		}
		if rec.Status == CiStateInterrupted {
			v.Status, v.RunId, v.StoppedAt = CiStateInterrupted, rec.Id, rec.FinishedAt
		}
		return
	}
}

// localCiFacts: what the local CI of a project knows of the commits its pull requests carry.
type localCiFacts struct {
	untrusted bool
	// The commit a run works on now, "" when none does.
	activeSha string
	// Newest first.
	runs []CiRunRecord
}

// localFacts: false when the project declares no local CI, so its pull requests' statuses are not the local CI's.
func (c *Ci) localFacts(dir string) (localCiFacts, bool) {
	pipeline, err := readCiPipeline(dir)
	if err != nil {
		return localCiFacts{}, false
	}
	facts := localCiFacts{untrusted: c.commandsUntrusted(dir, pipeline), runs: c.runs(dir)}
	if active := c.activeRun(dir); active != nil {
		if rec, err := c.readRecord(dir, active.runId); err == nil {
			facts.activeSha = rec.Sha
		}
	}
	return facts, true
}

// IsLocalCiCheck: a status the local CI publishes (local-<job>) or the agent's step for it ("AI testing / Local CI").
func IsLocalCiCheck(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if strings.HasPrefix(lower, "local-") {
		return true
	}
	return strings.HasPrefix(lower, aiTestingStatusPrefix) && strings.Contains(lower, aiTestingLocalCiStep)
}

func isAiTestingCheck(name string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(name)), aiTestingStatusPrefix)
}

func checkStartedMs(check ReviewCheck) int64 {
	started, err := time.Parse(time.RFC3339, check.StartedAt)
	if err != nil {
		return 0
	}
	return started.UnixMilli()
}

// reconcileLocalCi rereads the pending local CI checks of a PR with what the local CI knows of its head.
func reconcileLocalCi(pr *ReviewPr, facts localCiFacts, now time.Time) {
	if pr.HeadOid == "" || facts.activeSha == pr.HeadOid {
		return
	}
	var last *CiRunRecord
	for i := range facts.runs {
		if facts.runs[i].Sha == pr.HeadOid {
			last = &facts.runs[i]
			break
		}
	}
	changed := false
	for i := range pr.Ci.Checks {
		check := &pr.Ci.Checks[i]
		if check.State != ReviewCheckPending || !IsLocalCiCheck(check.Name) {
			continue
		}
		started := checkStartedMs(*check)
		finished := last != nil && (last.Status == CiStateSuccess || last.Status == CiStateFailure)
		// The agent's step status is the local CI's verdict once a run on that commit ended after it was posted.
		if isAiTestingCheck(check.Name) && finished && last.FinishedAt >= started {
			check.State = last.Status
			changed = true
			continue
		}
		if started > 0 && now.UnixMilli()-started < reviewLocalCiGrace.Milliseconds() {
			continue
		}
		changed = true
		if facts.untrusted {
			check.State = ReviewCheckUntrusted
			continue
		}
		// Interrupted only on the word of a run record of this computer; without one the status may come from
		// another computer or a teammate, which nothing here can tell.
		if last != nil && last.Status == CiStateInterrupted {
			check.State = ReviewCheckInterrupted
			check.StoppedAt = last.FinishedAt
			continue
		}
		check.State = ReviewCheckNotLocal
	}
	if !changed {
		return
	}
	countReviewCi(&pr.Ci)
	pr.Merge = reviewMergeWithChecks(ReviewMergeOfPr(pr.Mergeable, pr.MergeState), pr.Ci)
}

// ciRunJustStarted: the record a run publishes when it starts, before any job ran.
func ciRunJustStarted(rec CiRunRecord) bool {
	for _, job := range rec.Jobs {
		if job.Status != CiStateQueued {
			return false
		}
	}
	return rec.Status == CiStateRunning && rec.SeenAt == 0
}

// CiChanged publishes the project's review list again once a local CI run started or ended, when it was read.
func (r *Reviews) CiChanged(dir string) {
	if r == nil || r.publish == nil || r.collector == nil {
		return
	}
	snap, ok := r.collector.Cached(filepath.Clean(dir))
	if !ok {
		return
	}
	r.publish(r.answerOf(snap))
}

// reconcileAnswerLocalCi applies reconcileLocalCi to every PR of an answer, when the project has a local CI.
func reconcileAnswerLocalCi(ci *Ci, answer *ReviewsAnswer, now time.Time) {
	if ci == nil || answer == nil || answer.Dir == "" {
		return
	}
	facts, ok := ci.localFacts(answer.Dir)
	if !ok {
		return
	}
	for i := range answer.Ready {
		reconcileLocalCi(&answer.Ready[i], facts, now)
	}
	for i := range answer.Drafts {
		reconcileLocalCi(&answer.Drafts[i], facts, now)
	}
}
