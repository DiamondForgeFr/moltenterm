// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package onboarding

import (
	"sort"
	"time"
)

// The release-time check of FR-ONB-008 AC-11 (#1697): before a release candidate, every agent profile is re-read on
// the vendor's pages. RELEASE.md's "Agent profiles refreshed" item runs TestAgentProfilesFreshForRelease with the
// candidate's date in ReleaseDateEnv; the item is ticked only when it lists nothing.

const (
	ReleaseDateEnv             = "MOLTENTERM_RC_DATE"
	ProfileReleaseMaxAgeDays   = 30
	profileCheckedOnDateLayout = "2006-01-02"
)

type StaleProfile struct {
	Id        string
	CheckedOn string
	// -1 when CheckedOn is missing or not a date
	AgeDays int
}

// StaleProfiles lists the catalog's profiles checked more than maxAgeDays before the release date, by id. A profile
// without a readable checked date is listed too: it cannot prove it was refreshed.
func StaleProfiles(release time.Time, maxAgeDays int) []StaleProfile {
	return staleProfilesIn(agentFactsCatalog, release, maxAgeDays)
}

func staleProfilesIn(catalog map[string]AgentFacts, release time.Time, maxAgeDays int) []StaleProfile {
	day := time.Date(release.Year(), release.Month(), release.Day(), 0, 0, 0, 0, time.UTC)
	var rtn []StaleProfile
	for id, facts := range catalog {
		checked, err := time.Parse(profileCheckedOnDateLayout, facts.CheckedOn)
		if err != nil {
			rtn = append(rtn, StaleProfile{Id: id, CheckedOn: facts.CheckedOn, AgeDays: -1})
			continue
		}
		age := int(day.Sub(checked).Hours() / 24)
		if age > maxAgeDays {
			rtn = append(rtn, StaleProfile{Id: id, CheckedOn: facts.CheckedOn, AgeDays: age})
		}
	}
	sort.Slice(rtn, func(i, j int) bool { return rtn[i].Id < rtn[j].Id })
	return rtn
}

// ParseReleaseDate reads a candidate's date as RELEASE.md gives it (YYYY-MM-DD).
func ParseReleaseDate(value string) (time.Time, error) {
	return time.Parse(profileCheckedOnDateLayout, value)
}
