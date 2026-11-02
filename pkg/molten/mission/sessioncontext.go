// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What a durable session works on (FR-SHELL-058, #933): its ticket from the branch naming, its pull request and that
// PR's state from the collector's cache (the open PRs and the recently merged ones). Nothing here starts a process: the
// sessions list is rebuilt every few seconds (FR-PERF-011). A PR closed without merging is not in the cache: its state
// stays unknown.

var sessionCollectorLock sync.Mutex
var sessionCollector *Collector

func useSessionCollector(c *Collector) {
	sessionCollectorLock.Lock()
	defer sessionCollectorLock.Unlock()
	sessionCollector = c
}

func getSessionCollector() *Collector {
	sessionCollectorLock.Lock()
	defer sessionCollectorLock.Unlock()
	return sessionCollector
}

type sessionPr struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Url         string `json:"url"`
	HeadRefName string `json:"headRefName"`
	IsDraft     bool   `json:"isDraft"`
	MergedAt    string `json:"mergedAt"`
}

var repoNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func parseSessionPrs(raw json.RawMessage) []sessionPr {
	if len(raw) == 0 {
		return nil
	}
	var prs []sessionPr
	if json.Unmarshal(raw, &prs) != nil {
		return nil
	}
	return prs
}

// mergedSessionPrs: the snapshot's closed PRs that merged; the others were closed without merging (#1088).
func mergedSessionPrs(raw json.RawMessage) []sessionPr {
	var rtn []sessionPr
	for _, pr := range parseSessionPrs(raw) {
		if pr.MergedAt != "" {
			rtn = append(rtn, pr)
		}
	}
	return rtn
}

func findSessionPr(prs []sessionPr, number int, branch string) (sessionPr, bool) {
	for _, pr := range prs {
		if number > 0 && pr.Number == number {
			return pr, true
		}
		if number == 0 && branch != "" && pr.HeadRefName == branch {
			return pr, true
		}
	}
	return sessionPr{}, false
}

// ResolveSessionContext answers q from the GitHub part of a project's snapshot (nil when unknown); ticketOf reads the
// ticket a branch names.
func ResolveSessionContext(q molten.SessionContextQuery, gh *GithubSnapshot, ticketOf func(branch string) int) *molten.SessionContext {
	ctx := &molten.SessionContext{Repo: q.Repo, Branch: q.Branch, Pr: q.Number}
	if q.Branch != "" && ticketOf != nil {
		ctx.Ticket = ticketOf(q.Branch)
	}
	if gh != nil {
		if ctx.Repo == "" {
			ctx.Repo = gh.Repo
		}
		// A PR named by the origin is looked up in the project only when it is the project's repository.
		sameRepo := q.Repo == "" || strings.EqualFold(q.Repo, gh.Repo)
		if sameRepo {
			if pr, ok := findSessionPr(parseSessionPrs(gh.Prs), q.Number, q.Branch); ok {
				ctx.Pr, ctx.PrTitle, ctx.PrUrl = pr.Number, pr.Title, pr.Url
				ctx.PrState = molten.SessionPrOpen
				if pr.IsDraft {
					ctx.PrState = molten.SessionPrDraft
				}
			} else if pr, ok := findSessionPr(mergedSessionPrs(gh.Merged), q.Number, q.Branch); ok {
				ctx.Pr, ctx.PrTitle, ctx.PrUrl = pr.Number, pr.Title, pr.Url
				ctx.PrState = molten.SessionPrMerged
			}
		}
	}
	if ctx.Pr > 0 && ctx.PrUrl == "" && repoNameRe.MatchString(ctx.Repo) {
		ctx.PrUrl = fmt.Sprintf("https://github.com/%s/pull/%d", ctx.Repo, ctx.Pr)
	}
	return ctx
}

// SessionContextOf is the sessions list's context lookup (pkg/molten/sessions UseContextLookup).
func SessionContextOf(q molten.SessionContextQuery) *molten.SessionContext {
	var gh *GithubSnapshot
	if c := getSessionCollector(); c != nil && q.Project != "" {
		if snap, ok := c.Cached(q.Project); ok {
			gh = snap.Github
		}
	}
	ticketOf := func(branch string) int {
		if q.Project != "" {
			return TicketOfBranch(q.Project, branch)
		}
		return ticketOfBranch(branch, []*regexp.Regexp{defaultTicketBranchRe})
	}
	return ResolveSessionContext(q, gh, ticketOf)
}
