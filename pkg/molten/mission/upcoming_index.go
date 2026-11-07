// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import "sync"

// The index of who works on what (#1955, FR-REV-022 AC21): the agents the Integration rows show on each branch are the
// ones the launchers read before they put an agent on a PR, so a click and its card never disagree.

var liveIndex = struct {
	lock    sync.Mutex
	reviews *Reviews
}{}

func useLiveReviews(r *Reviews) {
	liveIndex.lock.Lock()
	defer liveIndex.lock.Unlock()
	liveIndex.reviews = r
}

func liveReviews() *Reviews {
	liveIndex.lock.Lock()
	defer liveIndex.lock.Unlock()
	return liveIndex.reviews
}

// LiveBranchAgents lists the agents on the project's branches as wavesrv places them now (the answer is read again when
// the cached one is a few seconds old). false when Mission Control is not started or the project's worktrees cannot be
// read: the caller then knows nothing, and says so rather than guessing nobody works there.
func LiveBranchAgents(dir string) ([]BranchAgent, bool) {
	r := liveReviews()
	if r == nil {
		return nil, false
	}
	answer, err := r.Upcoming(UpcomingRequest{Dir: dir, Force: true})
	if err != nil || answer.Error != "" {
		return nil, false
	}
	return answer.Agents, true
}
