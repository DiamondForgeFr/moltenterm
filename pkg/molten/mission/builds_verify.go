// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/remoteci"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// A commit already verified is never verified again (#2277, FR-MC-012): before it runs the local CI, a build's Verify
// phase looks up the project's GitHub CI for the build's exact commit (pkg/molten/remoteci holds the guardrails) and
// passes when a run of the full suites is green. A run still going is waited for while its jobs make progress, until
// the developer chooses to verify here instead. Anything else, an error included, says why in one line and runs the
// local CI as before.

const (
	VerifyByGithub  = "github"
	VerifyByWaiting = "waiting"
	VerifyByLocal   = "local"

	// How often a build waiting for GitHub's run looks at it again: three requests each time, of an hourly allowance.
	buildGithubPoll = 20 * time.Second
)

// BuildVerify is how a build's commit is verified, for the build's row: By a green GitHub run (github), while it waits
// for one (waiting), or with the local CI (local), then with why GitHub's result was not used.
type BuildVerify struct {
	By    string `json:"by"`
	RunId int64  `json:"runid,omitempty"`
	Url   string `json:"url,omitempty"`
	Sha   string `json:"sha,omitempty"`
	// By github: the jobs of the run that concluded success. By waiting: the jobs that ended, of those the run has.
	Jobs    int         `json:"jobs,omitempty"`
	Done    int         `json:"done,omitempty"`
	Total   int         `json:"total,omitempty"`
	Why     string      `json:"why,omitempty"`
	WhyText *uimsg.Text `json:"whytext,omitempty"`
}

func (r *Runs) githubPollInterval() time.Duration {
	if r.pollEvery > 0 {
		return r.pollEvery
	}
	return buildGithubPoll
}

func (r *Runs) askVerifyHere(runId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.verifyHere == nil {
		r.verifyHere = map[string]bool{}
	}
	r.verifyHere[runId] = true
}

func (r *Runs) takeVerifyHere(runId string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	asked := r.verifyHere[runId]
	delete(r.verifyHere, runId)
	return asked
}

// VerifyHere makes a build that waits for GitHub's CI verify its commit with the local CI at once.
func (r *Runs) VerifyHere(dir string, runId string) error {
	if err := checkRunId(runId); err != nil {
		return err
	}
	rec, err := r.readRecord(filepath.Clean(dir), runId)
	if err != nil {
		return err
	}
	if rec.State != RunStateRunning || rec.Verify == nil || rec.Verify.By != VerifyByWaiting {
		return uimsg.Errorf(uimsg.Make("mission.build.notWaiting", "title", rec.Title), "%s is not waiting for GitHub's CI", rec.Title)
	}
	r.askVerifyHere(runId)
	return nil
}

func jobsText(count int) string {
	if count == 1 {
		return "1 job"
	}
	return strconv.Itoa(count) + " jobs"
}

// verifyLocal records that GitHub's CI is not used for this build, and says why.
func (b *buildLog) verifyLocal(why string, text *uimsg.Text) {
	b.rec.Verify = &BuildVerify{By: VerifyByLocal, Why: why, WhyText: text}
	b.say("GitHub CI not used: %s. Verifying with the local CI.", why)
}

func (b *buildLog) verifiedByGithub(answer remoteci.Answer) {
	b.rec.Verify = &BuildVerify{By: VerifyByGithub, RunId: answer.RunId, Url: answer.Url, Sha: shortSha(answer.Sha), Jobs: answer.Jobs}
	b.say("Verified by GitHub CI · run %d · %s green on %s", answer.RunId, jobsText(answer.Jobs), shortSha(answer.Sha))
	b.say("  %s", answer.Url)
}

func (b *buildLog) waitingForGithub(answer remoteci.Answer, announced bool) {
	b.rec.Verify = &BuildVerify{By: VerifyByWaiting, RunId: answer.RunId, Url: answer.Url, Sha: shortSha(answer.Sha), Done: answer.JobsDone, Total: answer.JobsTotal}
	if announced {
		b.refresh()
		return
	}
	b.say("GitHub CI run %d is still going on %s: waiting for it while its jobs make progress", answer.RunId, shortSha(answer.Sha))
	b.say("  %s", answer.Url)
}

// githubTarget is the project's GitHub repository, as origin says, and the branches whose runs count.
func (r *Runs) githubTarget(ctx context.Context, dir string) (string, []string) {
	out, err := r.buildGit(ctx, dir, "remote", "get-url", "origin")
	repo := ""
	if err == nil {
		repo = release.GithubRepo(strings.TrimSpace(string(out)))
	}
	trunk, _ := r.buildTrunk(ctx, dir)
	branches := []string{}
	for _, name := range []string{trunk, molten.ResolvedBranches(dir).Release} {
		if name != "" && !containsString(branches, name) {
			branches = append(branches, name)
		}
	}
	return repo, branches
}

func containsString(list []string, item string) bool {
	for _, s := range list {
		if s == item {
			return true
		}
	}
	return false
}

// githubClient runs gh in the project with its repository named, so gh never picks a remote by itself (a fork's
// upstream is resolved before origin).
func (r *Runs) githubClient(dir string, repo string) remoteci.Gh {
	return func(ctx context.Context, args ...string) ([]byte, error) {
		callCtx, cancel := context.WithTimeout(ctx, githubRunTimeout)
		defer cancel()
		return r.git(callCtx, dir, "gh", ghRepoArgs(repo, args)...)
	}
}

// pauseForGithub waits for the next look at GitHub's run. It ends early when the build is cancelled or the developer
// chose to verify here, which it looks at every second: a cancel never waits for GitHub's poll.
func (r *Runs) pauseForGithub(ctx context.Context, b *buildLog) (cancelled bool, here bool) {
	next := time.NewTimer(r.githubPollInterval())
	defer next.Stop()
	tick := time.NewTicker(r.ciPollInterval())
	defer tick.Stop()
	for {
		if b.cancelled() {
			return true, false
		}
		if r.takeVerifyHere(b.rec.Id) {
			return false, true
		}
		select {
		case <-ctx.Done():
			return true, false
		case <-next.C:
			return false, false
		case <-tick.C:
		}
	}
}

// verifyByGithub passes the Verify phase when GitHub's CI is green on the build's commit. used says it did; stopped says
// the build was cancelled meanwhile. When neither, the local CI verifies.
func (r *Runs) verifyByGithub(ctx context.Context, b *buildLog) (used bool, stopped bool) {
	dir := b.rec.storageProject()
	repo, branches := r.githubTarget(ctx, dir)
	client := r.githubClient(dir, repo)
	check := func() remoteci.Answer {
		return remoteci.Check(ctx, client, remoteci.Query{Repo: repo, Sha: b.rec.Commit, Branches: branches})
	}
	b.say("looking for a green GitHub CI run on %s", shortSha(b.rec.Commit))
	answer := check()
	watch := verifyWatch{last: r.now()}
	watch.observe(r.now(), answer.Progress)
	for announced := false; ; announced = true {
		switch answer.Status {
		case remoteci.StatusVerified:
			b.verifiedByGithub(answer)
			return true, false
		case remoteci.StatusUnverified:
			why, text := answer.Reason.Describe()
			b.verifyLocal(why, text)
			return false, false
		}
		b.waitingForGithub(answer, announced)
		cancelled, here := r.pauseForGithub(ctx, b)
		if cancelled {
			return false, true
		}
		if here {
			b.verifyLocal("you chose to verify here instead", uimsg.Make("mission.build.github.hereChosen"))
			return false, false
		}
		now := r.now()
		answer = check()
		if answer.Status == remoteci.StatusPending && watch.observe(now, answer.Progress) >= buildVerifyStall {
			minutes := strconv.Itoa(int(buildVerifyStall.Minutes()))
			b.verifyLocal(fmt.Sprintf("its run made no progress for %s minutes", minutes), uimsg.Make("mission.build.github.stalled", "minutes", minutes))
			return false, false
		}
	}
}
