// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The failed dependency or security scans of the listed pull requests (FR-REV-036 AC1 to AC8): which check is the
// project's scan, which advisories it failed on, and whether the failure is shared. Nothing here starts an agent or
// writes anything but the developer's one answer about a check: the Integration panel, and the work that follows a
// shared block, read the answer's securityblocks.

// must match frontend/moltenterm-shell/reviews/reviews-client.ts
const ReviewsSecurityCommand = "moltenmissionsecurityscan"

// SecurityScansFileName is where the developer's answers about a project's scan are kept, in the cache folder.
const SecurityScansFileName = "security-scans.json"

const (
	// The trunk turns red or green without a listed pull request moving: it is read again after this.
	securityMaxAge = 5 * time.Minute
	// An assessment reads gh a few times per failed scan; this only bounds a failing run.
	securityTimeout = 90 * time.Second
)

// ReviewsSecurityRequest is the developer's answer about a check that looks like the project's scan: confirm it is the
// scan, say it is not, or take the answer back (secfix.AnswerConfirm, AnswerDismiss, AnswerReset).
type ReviewsSecurityRequest struct {
	Dir    string `json:"dir"`
	Check  string `json:"check"`
	Answer string `json:"answer"`
}

type securityState struct {
	// The key of the inputs the running or last assessment looked at.
	key     string
	at      time.Time
	askedAt time.Time
	running bool
	again   bool
	has     bool
	result  secfix.Result
	usedAt  time.Time
}

// readSecurityDeclaration reads `ci.security` of the project's pipeline; nil when the project declares none or its
// declaration has problems (`molten project validate` names them).
func readSecurityDeclaration(dir string) *secfix.Declaration {
	data, err := os.ReadFile(filepath.Join(dir, molten.ProjectPipelineFile))
	if err != nil {
		return nil
	}
	var project struct {
		Ci *struct {
			Security *secfix.Declaration `json:"security"`
		} `json:"ci"`
	}
	if json.Unmarshal(data, &project) != nil || project.Ci == nil || project.Ci.Security == nil {
		return nil
	}
	if problems := project.Ci.Security.Problems(); len(problems) > 0 {
		return nil
	}
	return project.Ci.Security
}

func securityChecks(pr ReviewPr) []secfix.Check {
	checks := make([]secfix.Check, 0, len(pr.Ci.Checks))
	for _, check := range pr.Ci.Checks {
		checks = append(checks, secfix.Check{Name: check.Name, Workflow: check.Workflow, Local: check.Local,
			Failed: check.State == ReviewCheckFailure, RunId: check.RunId, JobId: check.JobId})
	}
	return checks
}

// securityInput is what an assessment of the answer's pull requests would look at; false when GitHub was not read.
func (r *Reviews) securityInput(answer ReviewsAnswer) (secfix.Input, bool) {
	if answer.State != GithubStateOk || answer.Repo == "" {
		return secfix.Input{}, false
	}
	confirmed, dismissed := r.securityStore.Get(answer.Dir)
	in := secfix.Input{Dir: answer.Dir, Trunk: answer.Target, Policy: secfix.Policy{Declaration: readSecurityDeclaration(answer.Dir), Confirmed: confirmed, Dismissed: dismissed}}
	for _, pr := range append(append([]ReviewPr{}, answer.Ready...), answer.Drafts...) {
		in.Prs = append(in.Prs, secfix.PrInput{Number: pr.Number, HeadOid: pr.HeadOid, Checks: securityChecks(pr)})
	}
	return in, true
}

// applySecurity fills the answer with what the last assessment found, for the pull requests it lists and only while
// one of their failed checks could still be the scan; it returns what a new assessment would look at and its key.
func (r *Reviews) applySecurity(answer *ReviewsAnswer) (secfix.Input, string) {
	in, ok := r.securityInput(*answer)
	if !ok {
		return in, ""
	}
	key := in.Key()
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.scans[answer.Dir]
	if key == "" || state == nil || !state.has {
		return in, key
	}
	listed := map[int]bool{}
	for _, pr := range append(append([]ReviewPr{}, answer.Ready...), answer.Drafts...) {
		listed[pr.Number] = true
	}
	result := state.result.Restrict(listed)
	answer.SecurityBlocks, answer.SecurityOffers, answer.SecurityUnread = result.Blocks, result.Offers, result.Unread
	for _, list := range [][]ReviewPr{answer.Ready, answer.Drafts} {
		for i := range list {
			list[i].SecurityBlock = result.PrOfBlock(list[i].Number)
		}
	}
	return in, key
}

// SecurityResult is what the project's last assessment of its failed scans found, for the work that follows a shared
// block; false when none ran, or the failed checks that could be the scan are gone since.
func (r *Reviews) SecurityResult(dir string) (secfix.Result, bool) {
	if r == nil {
		return secfix.Result{}, false
	}
	dir = filepath.Clean(dir)
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.scans[dir]
	if state == nil || !state.has || state.key == "" {
		return secfix.Result{}, false
	}
	return state.result, true
}

// LiveSecurityResult is SecurityResult on the running Mission Control; false when it is not started.
func LiveSecurityResult(dir string) (secfix.Result, bool) {
	return liveReviews().SecurityResult(dir)
}

// prepareSecurity says whether an assessment starts now: the failed checks that could be the scan changed, the last
// one is old, or the developer forced a refresh; never two at once, and the same inputs at most once every few seconds.
func (r *Reviews) prepareSecurity(dir string, key string, force bool) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.scans[dir]
	if key == "" {
		if state != nil {
			state.has, state.result, state.key = false, secfix.Result{}, ""
		}
		return false
	}
	if state == nil {
		if len(r.scans) >= maxProjects {
			r.evictScansLocked()
		}
		state = &securityState{}
		r.scans[dir] = state
	}
	now := r.now()
	state.usedAt = now
	if state.running {
		state.again = state.again || key != state.key || force
		return false
	}
	due := key != state.key || now.Sub(state.at) >= securityMaxAge || force
	// A new key is a new failed check or a new answer of the developer: it is read at once, what it reads being kept by run.
	if !due || (key == state.key && !state.askedAt.IsZero() && now.Sub(state.askedAt) < reviewReportsMinInterval) {
		return false
	}
	state.running = true
	state.askedAt = now
	state.key = key
	return true
}

func (r *Reviews) evictScansLocked() {
	var oldest string
	var oldestAt time.Time
	for dir, state := range r.scans {
		if state.running {
			continue
		}
		if oldest == "" || state.usedAt.Before(oldestAt) {
			oldest, oldestAt = dir, state.usedAt
		}
	}
	if oldest != "" {
		delete(r.scans, oldest)
	}
}

// storeSecurity keeps an assessment's result; true when the inputs changed while it ran, so another one follows.
func (r *Reviews) storeSecurity(dir string, result secfix.Result, assessed bool) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.scans[dir]
	if state == nil {
		return false
	}
	state.running = false
	state.at = r.now()
	if assessed {
		state.result, state.has = result, true
	}
	again := state.again
	state.again = false
	return again
}

// readSecurity assesses the failed scans in the background and tells the views.
func (r *Reviews) readSecurity(in secfix.Input, repoRef string) {
	result, assessed := r.assessSecurity(in, repoRef)
	again := r.storeSecurity(in.Dir, result, assessed)
	if assessed {
		r.publishCurrent(in.Dir)
	}
	if again {
		r.Get(ReviewsRequest{Dir: in.Dir})
	}
}

func (r *Reviews) assessSecurity(in secfix.Input, repoRef string) (result secfix.Result, assessed bool) {
	defer func() {
		if rec := recover(); rec != nil {
			panichandler.PanicHandler("molten:mission:reviews:security", rec)
			assessed = false
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), securityTimeout)
	defer cancel()
	gh := func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		return r.run(ctx, dir, "gh", ghRepoArgs(repoRef, args)...)
	}
	return r.securityReader.Assess(ctx, gh, in), true
}

// startSecurity asks for the assessment the answer's failed checks call for, in the background.
func (r *Reviews) startSecurity(answer ReviewsAnswer, in secfix.Input, key string, force bool) {
	// GitHub not read (yet, or just now): what was found stays until it is.
	if answer.State != GithubStateOk || answer.Repo == "" {
		return
	}
	if !r.prepareSecurity(answer.Dir, key, force) {
		return
	}
	repoRef := ghRepoRef(answer.Repo, answer.Url)
	goRecovered("molten:mission:reviews:security", func() { r.readSecurity(in, repoRef) })
}

// AnswerSecurityScan records the developer's answer about a check that looks like the project's scan, and answers with
// the list as it reads then (FR-REV-036 AC2). The answer is kept in MoltenTerm's data folder, never in the repository.
func (r *Reviews) AnswerSecurityScan(req ReviewsSecurityRequest) (ReviewsAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return ReviewsAnswer{}, err
	}
	dir := filepath.Clean(req.Dir)
	if err := r.securityStore.Answer(dir, req.Check, req.Answer); err != nil {
		return ReviewsAnswer{}, uimsg.Errorf(uimsg.Make("mission.reviews.securityAnswer", "detail", uimsg.Detail(err)),
			"the answer about the security scan could not be kept: %v", err)
	}
	return r.Get(ReviewsRequest{Dir: dir, Force: true})
}
