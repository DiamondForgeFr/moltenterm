// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package versions

import (
	"fmt"
	"strings"
)

const (
	// The number is a choice: the first public release.
	HowDecision = "decision"
	// Read from the commits since the last public release.
	HowDerived = "derived"
	// Given explicitly (Notulia's `cut.sh <version>`).
	HowOverride = "override"
	HowRefused  = "refused"
)

type PlanResult struct {
	Channel string `json:"channel"`
	How     string `json:"how"`
	// The public version the release leads to.
	Base string `json:"base,omitempty"`
	// The release's own version: Base, or Base-N for a release candidate.
	Version string `json:"version,omitempty"`
	Tag     string `json:"tag,omitempty"`
	Level   string `json:"level,omitempty"`
	Reason  string `json:"reason"`
	// With an explicit version: the public version the commits give, shown beside it ("" when they give none).
	Derived    string `json:"derived,omitempty"`
	LastPublic string `json:"lastpublic,omitempty"`
}

func refused(channel string, lastPublic string, format string, args ...any) PlanResult {
	return PlanResult{Channel: channel, How: HowRefused, Reason: fmt.Sprintf(format, args...), LastPublic: lastPublic}
}

// Plan says which version and tag the next release of a channel carries. commits are those since the last public
// release (all of them before the first one). override, when given, is the public version to release instead of the
// derived one: it must be above the last public release, and it is taken even when the commits justify no release.
func (r Rules) Plan(tags []string, commits []CommitInput, channel string, override string) PlanResult {
	lastPublic := r.LastPublic(tags)
	if channel != ChannelRc && channel != ChannelPublic {
		return refused(channel, lastPublic, "Not a release channel: %q.", channel)
	}
	var base Version
	rtn := PlanResult{Channel: channel, LastPublic: lastPublic}
	derivedOk := true
	if lastPublic == "" {
		base = r.firstPublicProposal(tags)
		rtn.How = HowDecision
		rtn.Reason = "First public release: a choice, not a calculation."
	} else {
		last, _ := r.ReleaseOf(lastPublic)
		decision := DecideBump(last, commits)
		if decision == nil {
			derivedOk = false
			rtn.How = HowRefused
			rtn.Reason = fmt.Sprintf("Nothing a user would see since %s (only chore, ci, docs, test, style, build or refactor commits).", lastPublic)
		} else {
			base, _ = ParseBase(decision.Version)
			rtn.How = HowDerived
			rtn.Level = decision.Level
			rtn.Reason = decision.Reason
		}
	}
	if override != "" {
		chosen, err := ParseBase(strings.TrimSpace(override))
		if err != nil {
			return refused(channel, lastPublic, "%s is not a public version (X.Y.Z).", override)
		}
		if last, ok := r.ReleaseOf(lastPublic); ok && Compare(chosen, last) <= 0 {
			return refused(channel, lastPublic, "%s is not above the last public release, %s.", chosen, lastPublic)
		}
		if _, ok := r.ReleaseOf(r.Tag(chosen.WithRc(1))); !ok {
			return refused(channel, lastPublic, "%s is below versions.firstpublic (%s).", chosen, r.FirstPublic)
		}
		if derivedOk {
			rtn.Derived = base.String()
		}
		rtn.How = HowOverride
		rtn.Level = ""
		if derivedOk && lastPublic != "" {
			rtn.Reason = fmt.Sprintf("Chosen explicitly; the commits give %s.", base)
		} else if derivedOk {
			rtn.Reason = fmt.Sprintf("Chosen explicitly; %s was proposed for the first public release.", base)
		} else {
			rtn.Reason = fmt.Sprintf("Chosen explicitly; the commits since %s justify no release.", lastPublic)
		}
		base = chosen
	} else if !derivedOk {
		return rtn
	}
	version := base
	if channel == ChannelRc {
		rc := r.NextRc(base, tags)
		if rc > MaxRc {
			return refused(channel, lastPublic, "%s has no candidate number left (at most %d).", base, MaxRc)
		}
		version = base.WithRc(rc)
	}
	rtn.Base = base.String()
	rtn.Version = version.String()
	rtn.Tag = r.Tag(version)
	for _, tag := range tags {
		if strings.TrimSpace(tag) == rtn.Tag {
			return refused(channel, lastPublic, "%s is already tagged.", rtn.Tag)
		}
	}
	return rtn
}

// The proposal for the first public release: versions.firstpublic, else the version the candidates already lead to.
func (r Rules) firstPublicProposal(tags []string) Version {
	if base, err := ParseBase(r.FirstPublic); err == nil {
		return base
	}
	if lastRc, ok := r.ReleaseOf(r.LastRc(tags)); ok {
		return lastRc.Base()
	}
	base, _ := ParseBase(DefaultFirstPublic)
	return base
}
