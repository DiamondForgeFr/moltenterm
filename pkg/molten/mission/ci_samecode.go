// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"path/filepath"
	"regexp"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

var oidRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

// What a merge waiting for a PR's checks asks of the local CI (#2141). A head rebased then pushed by an agent was
// often tested before its push: its local-* statuses went nowhere (the commit was not on GitHub yet) and a new run is
// refused as already green on that code, so GitHub never shows them and the wait never ends. The verdict on the head's
// tree answers instead, and its statuses are posted on the head once, so GitHub and the Integration list agree.

var sameCodePosted = struct {
	lock sync.Mutex
	shas map[string]bool
}{shas: map[string]bool{}}

// GreenOn tells whether every job of the project's pipeline passed on the code of commit sha (fetched once when the
// clone lacks it); when it did and the pipeline posts statuses, it posts them on sha (once per commit).
func (c *Ci) GreenOn(dir string, sha string) bool {
	if !oidRe.MatchString(sha) {
		return false
	}
	verdict, err := c.Status(dir, sha)
	if err != nil && firstTry(dir, "fetch@"+sha) {
		// A head GitHub rebased itself (update-branch) is not in the local clone yet.
		ctx, cancel := context.WithTimeout(context.Background(), ciCommandTimeout)
		_, ferr := c.git(ctx, filepath.Clean(dir), "fetch", "--quiet", "--no-tags", "origin", sha)
		cancel()
		if ferr == nil {
			verdict, err = c.Status(dir, sha)
		}
	}
	if err != nil || verdict.Status != CiStateSuccess {
		return false
	}
	pipeline, err := readCiPipeline(filepath.Clean(dir))
	if err != nil || pipeline.Ci.Statuses != molten.PipelineCiStatusesGithub || !firstTry(dir, "post@"+sha) {
		return true
	}
	for _, job := range pipeline.Ci.Jobs {
		go c.publishStatus(filepath.Clean(dir), sha, job.Name, "success", "passed on the same code "+ciPublishScopeNote)
	}
	return true
}

// firstTry: true the first time what is done once per commit (a fetch, the statuses' post) is asked for.
func firstTry(dir string, what string) bool {
	sameCodePosted.lock.Lock()
	defer sameCodePosted.lock.Unlock()
	key := projectKey(dir) + "\x00" + what
	if sameCodePosted.shas[key] {
		return false
	}
	sameCodePosted.shas[key] = true
	return true
}

// Busy tells whether a local CI run is in progress for the project: a run of a new head may be next.
func (c *Ci) Busy(dir string) bool {
	return c.activeRun(dir) != nil
}

// LocalCiGreenOn is GreenOn on wavesrv's local CI; false when Mission Control is not started.
func LocalCiGreenOn(dir string, sha string) bool {
	r := liveReviews()
	if r == nil || r.ci == nil {
		return false
	}
	return r.ci.GreenOn(dir, sha)
}

// LocalCiBusy is Busy on wavesrv's local CI; false when Mission Control is not started.
func LocalCiBusy(dir string) bool {
	r := liveReviews()
	if r == nil || r.ci == nil {
		return false
	}
	return r.ci.Busy(dir)
}
