// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
)

// Analyze and resolve stops fighting a shared security block (FR-REV-036 AC14): a check of a pull request that fails on
// advisories the pull request did not cause is not the pull request's to fix, whoever tries. When a security fix covers
// the advisories (in flight, or just merged), the check is left out of the blockers: it is not rerun and not handed to an
// agent, whether or not the setting that starts the fix on its own is on. When no fix covers it yet, the check stays in the
// list, marked, and the brief says what it is: a shared dependency advisory, not to be rerun nor fixed in the pull request.

// RestartReasonSecurityCovered: every check that fails on the pull request is a security check a fix covers.
const RestartReasonSecurityCovered = "securitycovered"

// securityCover is what the pull request's security checks are: the ones a fix covers (left out), and which fix.
type securityCover struct {
	covered []InvestigateCheck
	fix     secfix.Fix
	// ids: the advisories of the pull request's block, as a line.
	ids string
}

func (c securityCover) any() bool {
	return len(c.covered) > 0
}

func hasSecurityMark(checks []InvestigateCheck) bool {
	for _, c := range checks {
		if c.Security != "" {
			return true
		}
	}
	return false
}

// nameKey keeps the letters and digits of a check's name, in lower case: the names of the scan (cleaned once by the
// assessment, once by the request) compare whatever spaces or marks the cleaning left.
func nameKey(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// sameCheck: the two names are the one check; only a name cut short (it ends with an ellipsis) is the start of the other.
func sameCheck(a string, b string) bool {
	ka, kb := nameKey(a), nameKey(b)
	if ka == "" || kb == "" {
		return false
	}
	if ka == kb {
		return true
	}
	return (strings.HasSuffix(a, "…") && strings.HasPrefix(kb, ka)) || (strings.HasSuffix(b, "…") && strings.HasPrefix(ka, kb))
}

// securityCover sorts the remote checks of a pull request: those of a shared block whose advisories a fix covers are
// dropped; those of a shared block no fix covers are kept and marked with the advisories; the others are as they were.
func (r *Restarter) securityCover(dir string, number int, checks []InvestigateCheck) ([]InvestigateCheck, securityCover) {
	var cover securityCover
	kept := make([]InvestigateCheck, 0, len(checks))
	for _, c := range checks {
		// What the window sent is never believed: a mark says only what wavesrv read.
		c.Security = ""
		kept = append(kept, c)
	}
	if r.env.SecurityFix.Result == nil || len(checks) == 0 {
		return kept, cover
	}
	result, ok := r.env.SecurityFix.Result(dir)
	if !ok {
		return kept, cover
	}
	fingerprint := result.PrOfBlock(number)
	block, found := findBlock(result, fingerprint)
	if fingerprint == "" || !found {
		return kept, cover
	}
	var names []string
	shared := false
	for _, pr := range block.Prs {
		if pr.Number == number {
			names, shared = pr.Checks, pr.Shared
		}
	}
	if !shared {
		return kept, cover
	}
	ids := secfix.Ids(block.Advisories)
	cover.ids = strings.Join(shownIds(ids), ", ")
	var fixes []secfix.Fix
	if store := r.fixStore(); store != nil {
		fixes = store.List(dir)
	}
	plan, fix := secfix.PlanOf(fixes, ids, r.env.Now().UnixMilli())
	standsFor := plan == secfix.PlanCovered || plan == secfix.PlanAddendum
	out := kept[:0:0]
	for _, c := range kept {
		isScan := false
		for _, name := range names {
			isScan = isScan || sameCheck(c.Name, name)
		}
		switch {
		case !isScan:
			out = append(out, c)
		case standsFor:
			cover.covered = append(cover.covered, c)
			cover.fix = fix
		default:
			c.Security = cover.ids
			out = append(out, c)
		}
	}
	return out, cover
}

// coveredMessage says, in English, why Analyze and resolve has nothing to do on a pull request whose only blocker is the
// shared security check.
func (c securityCover) coveredMessage() string {
	by := "MoltenTerm's security fix"
	if c.fix.Ticket > 0 {
		by += " #" + strconv.Itoa(c.fix.Ticket)
	}
	return fmt.Sprintf("The dependency scan fails on advisories this pull request did not cause (%s): %s covers them. There is nothing to resolve here; the pull request resumes once the fix is merged.", c.ids, by)
}

// writeSecurityCover is the part of the brief that names the scan's check as not the agent's: the ones a fix covers (left
// out of the list above) and, for the ones still listed, what they are.
func writeSecurityCover(sb *strings.Builder, b blockers) {
	if !b.security.any() {
		return
	}
	by := "MoltenTerm's security fix"
	if b.security.fix.Ticket > 0 {
		by += " #" + strconv.Itoa(b.security.fix.Ticket)
	}
	if b.security.fix.Pr > 0 {
		by += " (PR #" + strconv.Itoa(b.security.fix.Pr) + ")"
	}
	sb.WriteString("\n### The dependency scan is not yours\n\n")
	for _, c := range b.security.covered {
		fmt.Fprintf(sb, "- %s fails on shared advisories (%s) that this pull request did not cause. %s covers them: do not rerun it, do not open a ticket for it, and do not touch the dependencies in this pull request.\n",
			c.Name, b.security.ids, by)
	}
}
