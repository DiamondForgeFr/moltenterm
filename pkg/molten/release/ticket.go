// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/sfticket"
)

// The release's ticket (#1046, #1800): the ticket the release commits name when the project's commit format wants one.
// It is the one given (--ticket, MOLTEN_RELEASE_TICKET), else the issue of the version's milestone titled as its
// release ("Release v1.2.0"), else one the release creates there: a release must not stop halfway on bookkeeping it
// can do itself.

const (
	milestonePageSize = 100
	// A milestone is read page by page up to this many pages (5000 issues) before the release gives up looking and asks
	// for --ticket, so a lookup that cannot finish never turns into a second ticket.
	milestoneMaxPages = 50

	// Said to the project's ticket tool when its SRS is enabled: the release ticket has no source in the SRS.
	releaseTicketSrsReason = "release-ticket"
	releaseTicketTrees     = "molten-release-trees"
)

// ReleaseTicketTitle is the title of a version's release ticket: "Release v1.2.0".
func (p *Project) ReleaseTicketTitle(base string) string {
	return "Release " + p.Rules.TagPrefix + base
}

// titlesRelease tells whether an issue's title is that of the release ticket of a public version: "Release v1.2.0", with
// or without the tag prefix, optionally followed by a word of its own ("Release v1.2.0 (public)"). Another version
// ("Release v1.2.0-3", "Release v1.2.01") and any other title that happens to mention the version do not count: a
// milestone holds hundreds of issues, and the release commits must never name a ticket that is not the release's.
func (p *Project) titlesRelease(title string, base string) bool {
	prefixes := []string{regexp.QuoteMeta(p.Rules.TagPrefix)}
	if p.Rules.TagPrefix != "v" {
		prefixes = append(prefixes, "v")
	}
	re := regexp.MustCompile(`(?i)^\s*release\s+(?:` + strings.Join(prefixes, "|") + `)?` + regexp.QuoteMeta(base) + `(?:$|[\s:;,()\x{2013}\x{2014}])`)
	return re.MatchString(title)
}

const (
	// The ticket was given: --ticket, or MOLTEN_RELEASE_TICKET.
	ticketGiven = "given"
	// The milestone already held it.
	ticketFound = "found"
	// The milestone held none: the release made it.
	ticketCreated = "created"
)

// ticketAnswer is the release ticket and how the release came by it.
type ticketAnswer struct {
	Number    int
	How       string
	Milestone string
	Title     string
	// Resolved by this call, not remembered from an earlier one of the run.
	Fresh bool
}

// milestoneRead reads the milestone of a version once, for the checks of a run that all want it.
type milestoneRead struct {
	e    *Env
	dir  string
	base string
	done bool
	m    *Milestone
	err  error
}

func (e *Env) milestoneReader(dir string, base string) *milestoneRead {
	return &milestoneRead{e: e, dir: dir, base: base}
}

func (r *milestoneRead) get(ctx context.Context) (*Milestone, error) {
	if !r.done {
		r.m, r.err = r.e.milestoneOf(ctx, r.dir, r.base, false)
		r.done = true
	}
	return r.m, r.err
}

func (e *Env) rememberedTicket(key string) (ticketAnswer, bool) {
	e.ticketLock.Lock()
	defer e.ticketLock.Unlock()
	a, ok := e.tickets[key]
	a.Fresh = false
	return a, ok
}

func (e *Env) rememberTicket(key string, a ticketAnswer) {
	e.ticketLock.Lock()
	defer e.ticketLock.Unlock()
	if e.tickets == nil {
		e.tickets = map[string]ticketAnswer{}
	}
	e.tickets[key] = a
}

// givenTicket is the ticket the caller named: --ticket, else MOLTEN_RELEASE_TICKET; 0 for none.
func (e *Env) givenTicket() int {
	if e.Ticket > 0 {
		return e.Ticket
	}
	if n, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(os.Getenv(TicketEnv)), "#")); err == nil && n > 0 {
		return n
	}
	return 0
}

// releaseTicketMissing is why no ticket could be had where there is nowhere to create one.
func releaseTicketMissing(p *Project, base string) error {
	return fmt.Errorf("the project's commit format names a ticket (chore(#N): ...): pass --ticket N, or put an issue titled \"Release %s\" in the %s milestone", p.Rules.TagPrefix+base, base)
}

// resolveReleaseTicket is the ticket the release's commits name, when the convention wants one: --ticket, then
// MOLTEN_RELEASE_TICKET, then the issue of the version's milestone titled as its release ("Release v1.2.0"), which is
// created when the milestone holds none. It answers the same ticket for the whole run. read: where the milestone is read
// from, shared with the caller's other checks; nil reads it here.
func (e *Env) resolveReleaseTicket(ctx context.Context, p *Project, base string, read *milestoneRead) (ticketAnswer, error) {
	if !p.Convention.TicketScope {
		return ticketAnswer{}, nil
	}
	if n := e.givenTicket(); n > 0 {
		return ticketAnswer{Number: n, How: ticketGiven}, nil
	}
	key := p.Root + "|" + base
	if a, ok := e.rememberedTicket(key); ok {
		return a, nil
	}
	missing := releaseTicketMissing(p, base)
	if !e.OnGithub(ctx, p.Root) {
		return ticketAnswer{}, missing
	}
	if read == nil {
		read = e.milestoneReader(p.Root, base)
	}
	m, err := read.get(ctx)
	if err != nil {
		return ticketAnswer{}, fmt.Errorf("could not read the milestones to find the release ticket: %w; pass --ticket N", err)
	}
	if m == nil {
		return ticketAnswer{}, missing
	}
	found, err := e.findReleaseTicket(ctx, p, m, base)
	if err != nil {
		return ticketAnswer{}, err
	}
	answer := ticketAnswer{How: ticketFound, Milestone: m.Title, Fresh: true}
	if found != nil {
		answer.Number, answer.Title = found.Number, found.Title
	} else {
		answer.How, answer.Title = ticketCreated, p.ReleaseTicketTitle(base)
		if answer.Number, err = e.createReleaseTicket(ctx, p, m, base); err != nil {
			return ticketAnswer{}, err
		}
	}
	e.rememberTicket(key, answer)
	return answer, nil
}

// releaseTicket is resolveReleaseTicket for the steps that only name the ticket: it says how the release came by it the
// first time of the run.
func (e *Env) releaseTicket(ctx context.Context, p *Project, base string) (int, error) {
	a, err := e.resolveReleaseTicket(ctx, p, base, nil)
	if err != nil || !a.Fresh {
		return a.Number, err
	}
	switch a.How {
	case ticketCreated:
		e.printf("Created #%d, the release ticket of milestone %s (%s).\n", a.Number, a.Milestone, a.Title)
	case ticketFound:
		e.printf("Commits name #%d, the release ticket of milestone %s (%s).\n", a.Number, a.Milestone, a.Title)
	}
	return a.Number, nil
}

type milestoneListed struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	PullRequest json.RawMessage `json:"pull_request"`
}

// findReleaseTicket looks for the release's ticket in every issue of the milestone, closed ones included, page by page;
// nil, nil: it read them all and there is none. It stops at the first page that holds it, so the usual case, a recent
// ticket, costs one request.
func (e *Env) findReleaseTicket(ctx context.Context, p *Project, m *Milestone, base string) (*milestoneListed, error) {
	for page := 1; page <= milestoneMaxPages; page++ {
		out, err := e.gh(ctx, p.Root, "api", fmt.Sprintf("repos/{owner}/{repo}/issues?milestone=%d&state=all&per_page=%d&page=%d", m.Number, milestonePageSize, page))
		if err != nil {
			return nil, fmt.Errorf("could not read the issues of milestone %s to find the release ticket: %w; pass --ticket N", m.Title, err)
		}
		var issues []milestoneListed
		if err := json.Unmarshal(out, &issues); err != nil {
			return nil, fmt.Errorf("gh api issues: unreadable answer; pass --ticket N")
		}
		for i := range issues {
			issue := &issues[i]
			if len(issue.PullRequest) > 0 && string(issue.PullRequest) != "null" {
				continue
			}
			if p.titlesRelease(issue.Title, base) {
				return issue, nil
			}
		}
		if len(issues) < milestonePageSize {
			return nil, nil
		}
	}
	return nil, fmt.Errorf("milestone %s holds more than %d issues and none is the release ticket: pass --ticket N", m.Title, milestoneMaxPages*milestonePageSize)
}

// createReleaseTicket makes the release's ticket in the milestone: through the project's ticket tool when it has one
// (on its board, as an internal task of low complexity, as its own workflow wants), else a plain issue.
func (e *Env) createReleaseTicket(ctx context.Context, p *Project, m *Milestone, base string) (int, error) {
	title := p.ReleaseTicketTitle(base)
	body := fmt.Sprintf("Tracks the release of %s: its commits and pull requests name this ticket, and its release pull request closes it.\n\nCreated by `molten release`: the project's commit format names a ticket, and milestone %s held none.", p.Rules.TagPrefix+base, m.Title)
	n := 0
	if rel := sfticket.ToolOf(p.Root); rel != "" {
		n = e.createWithTicketTool(ctx, p, m, rel, title, body)
	}
	if n == 0 {
		out, err := e.gh(ctx, p.Root, "issue", "create", "--title", title, "--body", body, "--milestone", m.Title)
		if err != nil {
			return 0, fmt.Errorf("could not create the release ticket \"%s\" in milestone %s: %w; pass --ticket N, or create it there", title, m.Title, err)
		}
		if n = sfticket.IssueNumber(string(out)); n == 0 {
			return 0, fmt.Errorf("the release ticket \"%s\" was created in milestone %s but its number cannot be read from %q; pass --ticket N", title, m.Title, strings.TrimSpace(string(out)))
		}
	}
	return n, nil
}

// createWithTicketTool runs the project's ticket CLI as committed on its trunk (or its release branch), the copy the
// project reviewed, never the working copy's. 0: no ticket was made, a plain issue is made instead.
func (e *Env) createWithTicketTool(ctx context.Context, p *Project, m *Milestone, rel string, title string, body string) int {
	var script string
	for _, ref := range []string{"origin/" + p.Trunk, "origin/" + p.Release} {
		if out, err := e.git(ctx, p.Root, "show", ref+":"+rel); err == nil && out != "" {
			script = out + "\n"
			break
		}
	}
	if script == "" {
		return 0
	}
	spec := sfticket.Spec{Type: sfticket.TypeTask, Title: title, Body: body, Complexity: sfticket.ComplexityLow,
		Nature: sfticket.NatureInternal, Milestone: m.Title, SrsBypassReason: releaseTicketSrsReason}
	n, ok, unfinished := sfticket.Create(ctx, sfticket.Runner(e.run), p.Root, []byte(script), filepath.Join(os.TempDir(), releaseTicketTrees), spec)
	if !ok {
		return 0
	}
	if unfinished != nil {
		// The ticket exists: it must be found in its milestone next time, or the release would make a second one.
		e.printf("Warning: the project's ticket tool did not finish #%d: %v.\n", n, unfinished)
		if _, err := e.gh(ctx, p.Root, "api", "--method", "PATCH", fmt.Sprintf("repos/{owner}/{repo}/issues/%d", n), "-F", fmt.Sprintf("milestone=%d", m.Number)); err != nil {
			e.printf("Warning: #%d is not in milestone %s: %v.\n", n, m.Title, err)
		}
	}
	return n
}
