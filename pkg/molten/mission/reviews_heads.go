// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"context"
	"encoding/json"
	"log"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// A push refreshes its PR at once (#2145, FR-REV-022 AC22). The list reads GitHub at most once a minute, and GitHub
// computes a PR's mergeability and starts its checks some seconds after a push: a card kept "Conflicts with develop"
// or "CI red" for a head that was already rebased, and the developer's click handed an agent the old state. So a head
// that moved (a push seen in the repository's remote branches, or reported by the agent that pushed) makes wavesrv
// read that one PR again, outside the minute, and again every few seconds until GitHub shows the new head with its
// mergeability computed and its checks started, for two minutes at most.

const (
	// headFollowEvery: how often a pushed PR is read again while GitHub catches up.
	headFollowEvery = 4 * time.Second
	// headFollowTries bounds a follow to about two minutes; headChecksTries is the part of it spent waiting for the
	// first checks of a head GitHub has no check for yet (a project without CI never gets one).
	headFollowTries = 30
	headChecksTries = 3
	headReadTimeout = 30 * time.Second
)

// headFollow is the push a PR is followed for: from is the head the list showed, want the pushed one ("" when only
// the fact that it moved is known).
type headFollow struct {
	from   string
	want   string
	checks int
}

type headKey struct {
	dir    string
	number int
}

// ghOpenState is the state field `gh pr view` adds to a PR's fields; an open PR is the only one the list holds.
type ghOpenState struct {
	ghReviewPr
	State string `json:"state"`
}

// prViewFields are the list's fields (gh pr list) plus the PR's state, which a read of one PR may find merged or closed.
const prViewFields = prFields + ",state"

// RepoChanged is the repository watch's listener for the review list: a push or a fetch moved a remote branch of a
// project a view looks at, and a listed PR whose branch is somewhere else on origin than the head GitHub lists is read
// again now.
func (r *Reviews) RepoChanged(root string) {
	if r == nil || r.collector == nil {
		return
	}
	dir := filepath.Clean(root)
	if !r.collector.Active(dir) {
		return
	}
	r.addFollow(1)
	go func() {
		defer r.addFollow(-1)
		defer func() {
			panichandler.PanicHandler("molten:mission:reviews:pushes", recover())
		}()
		r.noticePushes(dir)
	}()
}

func (r *Reviews) noticePushes(dir string) {
	snap, ok := r.collector.Cached(dir)
	if !ok || snap.Github == nil {
		return
	}
	prs := listedPrs(BuildReviews(snap))
	if len(prs) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), headReadTimeout)
	defer cancel()
	tips := r.remoteTips(ctx, dir)
	for _, pr := range prs {
		tip := tips[pr.Branch]
		if tip == "" || tip == pr.HeadOid || r.followed(dir, pr.Number, tip) {
			continue
		}
		r.followHead(dir, pr, tip)
	}
}

func listedPrs(answer ReviewsAnswer) []ReviewPr {
	prs := make([]ReviewPr, 0, len(answer.Ready)+len(answer.Drafts))
	prs = append(prs, answer.Ready...)
	return append(prs, answer.Drafts...)
}

// remoteTips: the commit each branch of origin is at, as the repository knows it (a push moves it at once).
func (r *Reviews) remoteTips(ctx context.Context, dir string) map[string]string {
	tips := map[string]string{}
	out, err := r.run(ctx, dir, "git", "for-each-ref", "--format=%(objectname) %(refname:lstrip=3)", "refs/remotes/origin")
	if err != nil {
		return tips
	}
	for _, line := range strings.Split(string(out), "\n") {
		oid, branch, ok := strings.Cut(strings.TrimSpace(line), " ")
		if ok && oid != "" && branch != "" {
			tips[branch] = oid
		}
	}
	return tips
}

// HeadPushed is told that a branch got a new head: the agent that pushed reports it, or a hand-off found the PR ahead
// of the card. oid is the pushed head, "" when only the push is known. The PR is read again whatever was read lately.
func (r *Reviews) HeadPushed(dir string, branch string, oid string) {
	if r == nil || r.collector == nil || branch == "" {
		return
	}
	dir = filepath.Clean(dir)
	snap, ok := r.collector.Cached(dir)
	if !ok || snap.Github == nil {
		return
	}
	for _, pr := range listedPrs(BuildReviews(snap)) {
		if pr.Branch == branch {
			r.followHead(dir, pr, oid)
		}
	}
}

func (r *Reviews) followed(dir string, number int, want string) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	key := headKey{dir, number}
	if f := r.follows[key]; f != nil && f.want == want {
		return true
	}
	return r.followedWant[key] == want
}

// followHead starts reading the PR until GitHub shows the push; a follow already running is pointed at the new push.
func (r *Reviews) followHead(dir string, pr ReviewPr, want string) {
	key := headKey{dir, pr.Number}
	r.lock.Lock()
	if running := r.follows[key]; running != nil {
		running.want, running.checks = want, 0
		r.lock.Unlock()
		return
	}
	r.follows[key] = &headFollow{from: pr.HeadOid, want: want}
	r.followCount++
	r.lock.Unlock()
	go func() {
		defer r.addFollow(-1)
		defer func() {
			panichandler.PanicHandler("molten:mission:reviews:follow", recover())
		}()
		r.runFollow(key)
	}()
}

func (r *Reviews) addFollow(delta int) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.followCount += delta
}

// followsRunning counts the reads still going; the tests wait for it to reach zero before their folders go.
func (r *Reviews) followsRunning() int {
	r.lock.Lock()
	defer r.lock.Unlock()
	return r.followCount
}

func (r *Reviews) followState(key headKey) (headFollow, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	f := r.follows[key]
	if f == nil {
		return headFollow{}, false
	}
	return *f, true
}

func (r *Reviews) countCheckRead(key headKey) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if f := r.follows[key]; f != nil {
		f.checks++
	}
}

func (r *Reviews) endFollow(key headKey) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if f := r.follows[key]; f != nil {
		r.followedWant[key] = f.want
	}
	delete(r.follows, key)
}

func (r *Reviews) runFollow(key headKey) {
	defer r.endFollow(key)
	every := r.followEvery
	if every <= 0 {
		every = headFollowEvery
	}
	for tries := 0; tries < headFollowTries; tries++ {
		f, ok := r.followState(key)
		if !ok || r.readPushed(key, f) {
			return
		}
		time.Sleep(every)
	}
}

// readPushed reads the PR once, puts it in the project's list and tells the views; true when GitHub shows the push
// with its mergeability computed and its checks started, or the PR is not open any more.
func (r *Reviews) readPushed(key headKey, f headFollow) bool {
	snap, ok := r.collector.Cached(key.dir)
	if !ok || snap.Github == nil || snap.Github.Repo == "" {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), headReadTimeout)
	defer cancel()
	args := ghRepoArgs(ghRepoRef(snap.Github.Repo, snap.Github.Url), []string{"pr", "view", strconv.Itoa(key.number), "--json", prViewFields})
	out, err := r.run(ctx, key.dir, "gh", args...)
	if err != nil {
		log.Printf("molten: reading PR #%d after a push to its branch: %v\n", key.number, err)
		return false
	}
	var pr ghOpenState
	if json.Unmarshal(out, &pr) != nil || pr.Number != key.number {
		return false
	}
	open := strings.EqualFold(pr.State, "OPEN")
	if updated, ok := r.collector.ReplacePr(key.dir, key.number, json.RawMessage(out), open); ok && r.publish != nil {
		r.publish(r.answerOf(updated))
	}
	if !open {
		return true
	}
	if (f.want != "" && pr.HeadRefOid != f.want) || (f.want == "" && pr.HeadRefOid == f.from) {
		return false
	}
	if ReviewConflictOf(pr.Mergeable, pr.MergeStateStatus) == ReviewConflictComputing {
		return false
	}
	if len(pr.StatusCheckRollup) > 0 || f.checks >= headChecksTries {
		return true
	}
	r.countCheckRead(key)
	return false
}

// ReplacePr puts a PR read on its own into the project's cached list, in place of the one it lists, or takes it out
// when it is not open any more; the cache file follows. false when the project has no list or the PR is not in it (the
// next full read adds a new PR).
func (c *Collector) ReplacePr(dir string, number int, raw json.RawMessage, open bool) (Snapshot, bool) {
	snap, ok := c.replacePrLocked(dir, number, raw, open)
	if !ok {
		return Snapshot{}, false
	}
	c.saveCache(snap)
	if c.publish != nil {
		c.publish(snap)
	}
	return snap, true
}

func (c *Collector) replacePrLocked(dir string, number int, raw json.RawMessage, open bool) (Snapshot, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	state := c.stateLocked(dir)
	if state.snap.Github == nil || len(state.snap.Github.Prs) == 0 {
		return Snapshot{}, false
	}
	prs, found := withPr(state.snap.Github.Prs, number, raw, open)
	if !found {
		return Snapshot{}, false
	}
	// Copied: the snapshots already handed out share the pointer, and are read without this lock.
	github := *state.snap.Github
	github.Prs = prs
	state.snap.Github = &github
	if state.prPatches == nil {
		state.prPatches = map[int]prPatch{}
	}
	now := c.now()
	for n, patch := range state.prPatches {
		if now.Sub(patch.at) >= prPatchKeep {
			delete(state.prPatches, n)
		}
	}
	state.prPatches[number] = prPatch{raw: raw, open: open, at: now}
	return c.snapshotLocked(state), true
}

// prPatch is a PR read on its own: what a full list read that started before it must not undo.
type prPatch struct {
	raw  json.RawMessage
	open bool
	at   time.Time
}

// prPatchKeep: a full read that long after a patch cannot have started before it.
const prPatchKeep = 10 * time.Minute

// withNewerPrs puts back, in the list a full read just returned, the PRs read on their own after that read started: a
// push that landed while the list was being read shows in the PR read alone, not yet in the list.
func withNewerPrs(github *GithubSnapshot, patches map[int]prPatch, startedAt time.Time) *GithubSnapshot {
	if github == nil || len(github.Prs) == 0 || len(patches) == 0 {
		return github
	}
	prs := github.Prs
	for number, patch := range patches {
		if !patch.at.After(startedAt) {
			continue
		}
		if next, found := withPr(prs, number, patch.raw, patch.open); found {
			prs = next
		}
	}
	if len(prs) == len(github.Prs) && string(prs) == string(github.Prs) {
		return github
	}
	rtn := *github
	rtn.Prs = prs
	return &rtn
}

// withPr replaces PR number in the list's JSON by raw, or removes it when it is not open.
func withPr(prs json.RawMessage, number int, raw json.RawMessage, open bool) (json.RawMessage, bool) {
	var list []json.RawMessage
	if json.Unmarshal(prs, &list) != nil {
		return prs, false
	}
	for i, item := range list {
		var head struct {
			Number int `json:"number"`
		}
		if json.Unmarshal(item, &head) != nil || head.Number != number {
			continue
		}
		next := append([]json.RawMessage{}, list[:i]...)
		if open {
			next = append(next, raw)
		}
		next = append(next, list[i+1:]...)
		out, err := json.Marshal(next)
		if err != nil {
			return prs, false
		}
		return out, true
	}
	return prs, false
}
