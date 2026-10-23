// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// A topic's pull requests come from its branch (#991): one lookup through the user's gh for Claude Code and Codex
// alike, where Claude Code's pr-link records were the only source and Codex records none. Like the ticket labels
// (tickets.go), gh runs only when a companion that shows asks to look again, never from a poller; only the branch
// name goes to gh.

const (
	// A branch's answer is asked again after this long (a PR opened since), after branchPRFailedRecheck when gh
	// failed (not installed, not a GitHub folder).
	branchPRRecheck       = 3 * time.Minute
	branchPRFailedRecheck = 15 * time.Minute
	maxBranchPRBytes      = 256 * 1024
	maxBranchNameBytes    = 255
)

// Trunk branches are not looked up: their PRs (a release's develop → main) are not the topic's.
var trunkBranches = map[string]bool{"main": true, "master": true, "develop": true, "development": true, "dev": true, "trunk": true}

// branchPREntry is one branch's lookup: done once gh answered; prs is kept while it is asked again.
type branchPREntry struct {
	prs    []PRLink
	done   bool
	failed bool
	at     time.Time
}

// lookupBranch tells whether a branch's PRs are looked up: a named, non-trunk branch gh cannot read as an option.
func lookupBranch(branch string) bool {
	if branch == "" || branch == "HEAD" || len(branch) > maxBranchNameBytes || strings.HasPrefix(branch, "-") {
		return false
	}
	if strings.ContainsFunc(branch, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return false
	}
	return !trunkBranches[branch]
}

func (e *branchPREntry) stale(now time.Time) bool {
	if !e.done {
		return false
	}
	wait := branchPRRecheck
	if e.failed {
		wait = branchPRFailedRecheck
	}
	return now.Sub(e.at) >= wait
}

// branchPRs answers a branch's PRs from the cache; with fetch, a branch never asked, or answered long ago, is looked
// up in the background (the watchers are poked when it answers).
func (m *Manager) branchPRs(dir string, branch string, fetch bool) []PRLink {
	if m.branchPRLookup == nil || dir == "" || !lookupBranch(branch) {
		return nil
	}
	key := dir + "\x00" + branch
	m.lock.Lock()
	defer m.lock.Unlock()
	e := m.prBranches[key]
	if !fetch || (e != nil && !e.stale(m.now())) || m.prLookups >= maxTicketLookups {
		if e == nil {
			return nil
		}
		return e.prs
	}
	if e == nil {
		if len(m.prBranches) >= maxTicketCache {
			return nil
		}
		if m.prBranches == nil {
			m.prBranches = map[string]*branchPREntry{}
		}
		e = &branchPREntry{}
		m.prBranches[key] = e
	}
	e.done = false
	m.prLookups++
	go m.lookupBranchPRs(key, dir, branch)
	return e.prs
}

func (m *Manager) lookupBranchPRs(key string, dir string, branch string) {
	defer func() {
		panichandler.PanicHandler("molten:companion:branchprs", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), ticketLookupTimeout)
	defer cancel()
	prs, err := m.branchPRLookup(ctx, dir, branch)
	m.setBranchPRs(key, prs, err != nil)
	m.pokeAll()
}

func (m *Manager) setBranchPRs(key string, prs []PRLink, failed bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.prLookups--
	e := m.prBranches[key]
	if e == nil {
		return
	}
	e.done, e.failed, e.at = true, failed, m.now()
	if !failed {
		e.prs = prs
	}
}

// GhBranchPRs lists a branch's pull requests in this repository (not a fork's branch of the same name), newest first,
// with `gh pr list --head <branch>`, in the project's folder.
func GhBranchPRs(ctx context.Context, dir string, branch string) ([]PRLink, error) {
	out, err := runGh(ctx, dir, maxBranchPRBytes, "pr", "list", "--head="+branch, "--state", "all", "--limit", "10",
		"--json", "number,url,isCrossRepository")
	if err != nil {
		return nil, err
	}
	var answer []struct {
		Number            int    `json:"number"`
		Url               string `json:"url"`
		IsCrossRepository bool   `json:"isCrossRepository"`
	}
	if err := json.Unmarshal(out, &answer); err != nil {
		return nil, err
	}
	var rtn []PRLink
	for _, pr := range answer {
		if pr.Number <= 0 || pr.IsCrossRepository || len(rtn) >= MaxTopicPRs {
			continue
		}
		url := pr.Url
		if !strings.HasPrefix(url, "https://") {
			url = ""
		}
		rtn = append(rtn, PRLink{Number: pr.Number, Url: cutString(url, 500)})
	}
	slices.SortFunc(rtn, func(a, b PRLink) int { return b.Number - a.Number })
	return rtn, nil
}

// ResolveBranchPRs gives the branches of the shown topics their PRs, as prsOf answers them.
func (s *Session) ResolveBranchPRs(prsOf func(branch string) []PRLink) {
	seen := map[string]bool{}
	changed := false
	for _, t := range s.shownTopics() {
		if seen[t.branch] || !lookupBranch(t.branch) {
			continue
		}
		seen[t.branch] = true
		prs := prsOf(t.branch)
		if slices.Equal(prs, s.branchPRs[t.branch]) {
			continue
		}
		if s.branchPRs == nil {
			s.branchPRs = map[string][]PRLink{}
		}
		s.branchPRs[t.branch] = append([]PRLink(nil), prs...)
		changed = true
	}
	if changed {
		s.touch()
	}
}
