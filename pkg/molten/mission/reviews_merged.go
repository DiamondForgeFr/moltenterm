// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"log"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The Reviews view's Recently merged (#843): a merged PR leaves the review list, and the developer looking for it
// right after should still see that it merged, when, by whom and whether a release carries it. The PRs come with the
// collector's GitHub read (one `gh pr list --state merged` per refresh, no poller of its own); where each one ships is
// read from the project's git in the background, while someone asks, and kept: a tag that carries a commit stays so.

const (
	ReviewMergedDays = 7
	ReviewMergedMax  = 20

	// Where a merged PR ships: a release tag carries its merge commit, the release branch does (no tag yet), or
	// neither (the next release). Empty while git has not answered, or when the commit is not in the local clone.
	ReviewShipsTag    = "tag"
	ReviewShipsBranch = "branch"
	ReviewShipsNext   = "next"
)

const (
	// A commit no tag carries yet is read again at most once a minute, every 10 s on a forced refresh.
	reviewShipsMaxAge      = time.Minute
	reviewShipsMinInterval = minForcedInterval
	reviewShipsTimeout     = 45 * time.Second
)

type ReviewMergedPr struct {
	Number     int    `json:"number"`
	Title      string `json:"title"`
	Url        string `json:"url"`
	Branch     string `json:"branch"`
	Base       string `json:"base"`
	Author     string `json:"author,omitempty"`
	MergedAt   string `json:"mergedat"`
	MergedBy   string `json:"mergedby,omitempty"`
	MergeOid   string `json:"mergeoid,omitempty"`
	Ticket     int    `json:"ticket,omitempty"`
	TicketFrom string `json:"ticketfrom,omitempty"`
	// ReviewShips…, and the tag or branch named.
	Ships   string `json:"ships,omitempty"`
	ShipsIn string `json:"shipsin,omitempty"`
}

type ghMergedPr struct {
	Number            int    `json:"number"`
	Title             string `json:"title"`
	Url               string `json:"url"`
	HeadRefName       string `json:"headRefName"`
	BaseRefName       string `json:"baseRefName"`
	IsCrossRepository bool   `json:"isCrossRepository"`
	MergedAt          string `json:"mergedAt"`
	Author            struct {
		Login string `json:"login"`
	} `json:"author"`
	MergedBy *struct {
		Login string `json:"login"`
	} `json:"mergedBy"`
	MergeCommit *struct {
		Oid string `json:"oid"`
	} `json:"mergeCommit"`
	ClosingIssuesReferences []struct {
		Number int `json:"number"`
	} `json:"closingIssuesReferences"`
}

var commitOidRe = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)

// buildMerged lists the PRs merged into the target in the window before the GitHub read, newest first.
func buildMerged(raw json.RawMessage, target string, githubAt int64, ticketRes []*regexp.Regexp) ([]ReviewMergedPr, error) {
	rtn := []ReviewMergedPr{}
	if len(raw) == 0 {
		return rtn, nil
	}
	var prs []ghMergedPr
	if err := json.Unmarshal(raw, &prs); err != nil {
		return rtn, err
	}
	readAt := time.UnixMilli(githubAt)
	if githubAt <= 0 {
		readAt = time.Now()
	}
	since := readAt.Add(-ReviewMergedDays * 24 * time.Hour)
	for _, pr := range prs {
		mergedAt, err := time.Parse(time.RFC3339, pr.MergedAt)
		if err != nil || mergedAt.Before(since) || pr.IsCrossRepository || pr.BaseRefName != target {
			continue
		}
		row := ReviewMergedPr{
			Number:   pr.Number,
			Title:    pr.Title,
			Url:      pr.Url,
			Branch:   pr.HeadRefName,
			Base:     pr.BaseRefName,
			Author:   pr.Author.Login,
			MergedAt: pr.MergedAt,
		}
		if pr.MergedBy != nil {
			row.MergedBy = pr.MergedBy.Login
		}
		if pr.MergeCommit != nil && commitOidRe.MatchString(pr.MergeCommit.Oid) {
			row.MergeOid = pr.MergeCommit.Oid
		}
		for _, ref := range pr.ClosingIssuesReferences {
			if ref.Number > 0 {
				row.Ticket, row.TicketFrom = ref.Number, ReviewTicketFromClosing
				break
			}
		}
		if row.Ticket == 0 {
			if n := ticketOfBranch(pr.HeadRefName, ticketRes); n > 0 {
				row.Ticket, row.TicketFrom = n, ReviewTicketFromBranch
			}
		}
		rtn = append(rtn, row)
	}
	sort.SliceStable(rtn, func(i, j int) bool { return rtn[i].MergedAt > rtn[j].MergedAt })
	if len(rtn) > ReviewMergedMax {
		rtn = rtn[:ReviewMergedMax]
	}
	return rtn, nil
}

type reviewShip struct {
	ships string
	in    string
	at    time.Time
}

type reviewShipsState struct {
	ships   map[string]reviewShip
	running bool
	usedAt  time.Time
	// What the running read asks: the commits, the tags' prefix and the release branch.
	oids      []string
	tagPrefix string
	release   string
}

func (r *Reviews) applyShipsLocked(answer *ReviewsAnswer) {
	state := r.ships[answer.Dir]
	if state == nil {
		return
	}
	for i := range answer.Merged {
		row := &answer.Merged[i]
		if ship, ok := state.ships[row.MergeOid]; ok && row.MergeOid != "" {
			row.Ships, row.ShipsIn = ship.ships, ship.in
		}
	}
}

// prepareShips fills the merged rows with where they ship as known, and says whether a git read starts now.
func (r *Reviews) prepareShips(answer *ReviewsAnswer, snap Snapshot, force bool) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	if len(answer.Merged) == 0 {
		r.applyShipsLocked(answer)
		return false
	}
	state := r.ships[answer.Dir]
	if state == nil {
		if len(r.ships) >= maxProjects {
			r.evictShipsLocked()
		}
		state = &reviewShipsState{ships: map[string]reviewShip{}}
		r.ships[answer.Dir] = state
	}
	now := r.now()
	state.usedAt = now
	r.applyShipsLocked(answer)
	if state.running {
		return false
	}
	var due []string
	for _, row := range answer.Merged {
		if row.MergeOid == "" {
			continue
		}
		ship, ok := state.ships[row.MergeOid]
		age := now.Sub(ship.at)
		if !ok || (ship.ships != ReviewShipsTag &&(age >= reviewShipsMaxAge || (force && age >= reviewShipsMinInterval))) {
			due = append(due, row.MergeOid)
		}
	}
	if len(due) == 0 {
		return false
	}
	state.running = true
	state.oids = due
	state.tagPrefix, state.release = "", ""
	if snap.Git != nil {
		state.tagPrefix, state.release = snap.Git.TagPrefix, snap.Git.Release
	}
	// A project whose PRs go straight into its release branch: that branch says nothing of a release.
	if state.release == answer.Target {
		state.release = ""
	}
	return true
}

func (r *Reviews) evictShipsLocked() {
	var oldest string
	var oldestAt time.Time
	for dir, state := range r.ships {
		if state.running {
			continue
		}
		if oldest == "" || state.usedAt.Before(oldestAt) {
			oldest, oldestAt = dir, state.usedAt
		}
	}
	if oldest != "" {
		delete(r.ships, oldest)
	}
}

func (r *Reviews) takeShipsQuery(dir string) ([]string, string, string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.ships[dir]
	if state == nil {
		return nil, "", ""
	}
	return state.oids, state.tagPrefix, state.release
}

func (r *Reviews) storeShips(dir string, found map[string]reviewShip) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.ships[dir]
	if state == nil {
		return
	}
	state.running = false
	for oid, ship := range found {
		state.ships[oid] = ship
	}
}

func (r *Reviews) readShips(dir string) {
	found := map[string]reviewShip{}
	defer func() {
		if rec := recover(); rec != nil {
			panichandler.PanicHandler("molten:mission:reviews:ships", rec)
		}
		r.storeShips(dir, found)
		if snap, ok := r.collector.Cached(dir); ok && r.publish != nil {
			r.publish(r.answerOf(snap))
		}
	}()
	oids, tagPrefix, release := r.takeShipsQuery(dir)
	ctx, cancel := context.WithTimeout(context.Background(), reviewShipsTimeout)
	defer cancel()
	for _, oid := range oids {
		ships, in, ok := ReadShips(ctx, r.run, dir, oid, tagPrefix, release)
		if !ok {
			continue
		}
		found[oid] = reviewShip{ships: ships, in: in, at: r.now()}
	}
}

// ReadShips says where a merge commit ships: the first release tag that carries it (in version order), else the
// release branch when it carries it, else the next release. Not ok when git cannot read the commit (not fetched yet).
func ReadShips(ctx context.Context, run Runner, dir string, oid string, tagPrefix string, release string) (string, string, bool) {
	if !commitOidRe.MatchString(oid) {
		return "", "", false
	}
	if _, err := run(ctx, dir, "git", "cat-file", "-e", oid+"^{commit}"); err != nil {
		return "", "", false
	}
	args := []string{"tag", "--contains", oid, "--sort=v:refname"}
	if tagPrefix != "" {
		args = append(args, "--list", tagPrefix+"*")
	}
	out, err := run(ctx, dir, "git", args...)
	if err != nil {
		log.Printf("molten: reading the tags that carry %s in %s: %v\n", oid, dir, err)
		return "", "", false
	}
	for _, line := range strings.Split(string(out), "\n") {
		if tag := strings.TrimSpace(line); tag != "" {
			return ReviewShipsTag, tag, true
		}
	}
	if release != "" && !strings.HasPrefix(release, "-") {
		for _, ref := range []string{"refs/remotes/origin/" + release, "refs/heads/" + release} {
			if _, err := run(ctx, dir, "git", "merge-base", "--is-ancestor", oid, ref); err == nil {
				return ReviewShipsBranch, release, true
			}
		}
	}
	return ReviewShipsNext, "", true
}
