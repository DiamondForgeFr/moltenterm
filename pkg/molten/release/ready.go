// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The readiness of a release (#1800): everything known to stop it later is checked before the first step that writes
// anything (the version bump, the commit, the tag, the push), and reported in one list, not one failure at a time in
// the middle of the release. The checks are the ones the steps always made, gathered instead of stopping at the first;
// what is only bookkeeping (the release ticket) is fixed on the spot. It blocks only on what GitHub or the system
// would refuse anyway: a warning (a milestone with open issues, no milestone at all) never stops a release.
//
// The report is the step's log, one line per check ("  ok       ..."), and its last line, when something blocks, names
// every problem: that is the line Mission Control's release card shows.

const (
	readyOk      = "ok"
	readyFixed   = "fixed"
	readyWarning = "warning"
	readyProblem = "problem"
)

type readiness struct {
	e        *Env
	problems []string
}

func (e *Env) beginReadiness(tag string, what string) *readiness {
	e.printf("Checking that %s is ready to %s.\n", tag, what)
	return &readiness{e: e}
}

func (r *readiness) say(state string, format string, args ...any) {
	r.e.printf("  %-8s %s\n", state, fmt.Sprintf(format, args...))
}

func (r *readiness) ok(format string, args ...any)    { r.say(readyOk, format, args...) }
func (r *readiness) fixed(format string, args ...any) { r.say(readyFixed, format, args...) }
func (r *readiness) warn(format string, args ...any)  { r.say(readyWarning, format, args...) }

func (r *readiness) problem(format string, args ...any) {
	text := fmt.Sprintf(format, args...)
	r.problems = append(r.problems, text)
	r.say(readyProblem, "%s", text)
}

// finish says whether the release is ready; when it is not, the error holds every problem. nothing: what was left
// untouched.
func (r *readiness) finish(tag string, nothing string) error {
	if len(r.problems) == 0 {
		r.e.printf("%s is ready.\n", tag)
		return nil
	}
	return fmt.Errorf("%s is not ready, %s: %s", tag, nothing, strings.Join(r.problems, "; "))
}

// Ready checks that the cut of a tag can start, without changing anything but the release ticket (created when the
// milestone holds none): the checks the preparation makes first. pr: the release goes by pull request, from an RC
// branch made from the trunk.
func (e *Env) Ready(ctx context.Context, tag string, pr bool) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, _, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	return e.readyToPrepare(ctx, p, tag, v, pr)
}

func (e *Env) readyToPrepare(ctx context.Context, p *Project, tag string, v versions.Version, pr bool) error {
	r := e.beginReadiness(tag, "be cut")
	e.checkPreparation(ctx, r, p, tag, v, pr)
	return r.finish(tag, "nothing was changed")
}

// checkPreparation is what the preparation needs: the version files, origin, the tag and its number, the release branch
// and what it has not given back to the trunk yet, then GitHub: the milestone and the release ticket. Every check runs
// when it can, so that one report holds everything.
func (e *Env) checkPreparation(ctx context.Context, r *readiness, p *Project, tag string, v versions.Version, pr bool) {
	if len(p.Files) == 0 {
		r.problem("%s declares no versions.files: nothing would carry %s", p.Root, tag)
	} else {
		paths := make([]string, 0, len(p.Files))
		for _, f := range p.Files {
			paths = append(paths, f.Path)
		}
		r.ok("%s is written in %s", v, strings.Join(paths, ", "))
	}
	if err := e.fetch(ctx, p.Root); err != nil {
		// What origin holds cannot be read: the checks that read it would answer from stale refs.
		r.problem("%v", err)
		e.checkGithub(ctx, r, p, v)
		return
	}
	if where := e.tagTaken(ctx, p.Root, tag); where != "" {
		r.problem("%s already exists %s: nothing was changed", tag, where)
	} else {
		r.ok("%s is not taken", tag)
	}
	if err := p.checkNumber(v, e.releaseTags(ctx, p.Root, p)); err != nil {
		r.problem("%v", err)
	} else {
		r.ok("%s is the next release of its channel", tag)
	}
	if e.revParse(ctx, p.Root, "origin/"+p.Release) == "" {
		r.problem("%v", p.releaseBranchMissing())
	} else {
		r.ok("origin has %s", p.Release)
		if pending := e.releasesNotCarriedBack(ctx, p); len(pending) > 0 {
			r.problem("%s holds release commits %s lacks (%s): merge their sync-back pull request first, or run molten release sync-back", p.Release, p.Trunk, strings.Join(pending, ", "))
		} else {
			r.ok("%s holds no release commit %s lacks", p.Release, p.Trunk)
		}
	}
	if pr {
		if branch, err := p.RcBranch(v); err != nil {
			r.problem("%v", err)
		} else if e.revParse(ctx, p.Root, "origin/"+p.Trunk) == "" {
			r.problem("origin has no %s branch", p.Trunk)
		} else {
			r.ok("%s will be made from %s", branch, p.Trunk)
		}
	}
	e.checkGithub(ctx, r, p, v)
}

// checkGithub checks what a project on GitHub needs from it: gh answers (the milestone is read through it), the
// version's milestone is there, and the release ticket is, when the commit format names one. A missing milestone is
// only a warning for a project whose commits name no ticket: a milestone reports, it does not block (FR-REL-002).
func (e *Env) checkGithub(ctx context.Context, r *readiness, p *Project, v versions.Version) {
	base := v.Base().String()
	read := e.milestoneReader(p.Root, base)
	githubFailed := false
	if e.OnGithub(ctx, p.Root) {
		m, err := read.get(ctx)
		switch {
		case err != nil:
			githubFailed = true
			hint := ""
			if p.Convention.TicketScope {
				hint = "; or pass --ticket N"
			}
			r.problem("GitHub did not answer (is gh installed and signed in? gh auth login): %v%s", err, hint)
		case m == nil:
			if !p.Convention.TicketScope {
				r.warn("no open milestone for %s: the release ships without one (reported, not blocking)", base)
			}
		default:
			r.ok("milestone %s is open", m.Title)
			if len(m.Issues) > 0 {
				r.warn("%d open issue(s) in milestone %s (reported, not blocking)", len(m.Issues), m.Title)
			}
		}
	}
	// A ticket that was given needs no GitHub; one to find needs the answer GitHub just failed to give.
	if p.Convention.TicketScope && (!githubFailed || e.givenTicket() > 0) {
		e.checkTicket(ctx, r, p, base, read)
	}
}

// checkTicket finds the release ticket, or creates it, and says which. 0: there is none, and the report says why.
func (e *Env) checkTicket(ctx context.Context, r *readiness, p *Project, base string, read *milestoneRead) int {
	a, err := e.resolveReleaseTicket(ctx, p, base, read)
	if err != nil {
		r.problem("%v", err)
		return 0
	}
	switch {
	case a.How == ticketCreated && a.Fresh:
		r.fixed("Created #%d, the release ticket of milestone %s (%s).", a.Number, a.Milestone, a.Title)
	case a.How == ticketGiven:
		r.ok("the release commits name #%d, the ticket given", a.Number)
	default:
		r.ok("the release commits name #%d, the release ticket of milestone %s (%s)", a.Number, a.Milestone, a.Title)
	}
	return a.Number
}

// readyToCommit checks the prepared tree before it is committed (checkPrepared) and the release ticket the commit
// names. It returns what the commit takes and the ticket; nothing may be committed when r holds a problem.
func (e *Env) readyToCommit(ctx context.Context, r *readiness, p *Project, wt string, tag string, v versions.Version) (map[string]bool, int) {
	allowed, err := e.checkPrepared(ctx, p, wt, tag, v)
	if err != nil {
		r.problem("%v", err)
	} else {
		r.ok("the prepared tree holds the release and nothing else, and its notes are fit to publish")
	}
	if !p.Convention.TicketScope {
		return allowed, 0
	}
	return allowed, e.checkTicket(ctx, r, p, v.Base().String(), nil)
}
