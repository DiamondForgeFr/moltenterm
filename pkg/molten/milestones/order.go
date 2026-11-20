// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package milestones

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The order of the milestones' tabs (#2416). Every open milestone is shown, so no rule decides which one is "the" active
// milestone any more: a finished milestone that waits for its release keeps its tab until the release closes it. The
// tabs come:
//  1. by version (semver), the oldest first: the release being prepared opens first, and a milestone with no due date
//     still stands where its version puts it. The due date only separates two milestones of one version;
//  2. then the titles that are not a version: a dated one before an undated one, the earliest due date first, then by
//     title;
//  3. then the lowest number.

var versionRegex = regexp.MustCompile(`^[vV]?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,39}))?(?:\s|$)`)

type version struct {
	ok    bool
	nums  [3]int
	pre   []string
	title string
}

// parseVersion reads the version a title starts with: "v1.3.0", "1.4", "1.0.0-rc.1", or "1.0.0 launch". A title that is
// not a version ("Later") gives ok false.
func parseVersion(title string) version {
	title = strings.TrimSpace(title)
	m := versionRegex.FindStringSubmatch(title)
	if m == nil {
		return version{title: strings.ToLower(title)}
	}
	v := version{ok: true, title: strings.ToLower(title)}
	for i := 0; i < 3; i++ {
		if m[i+1] != "" {
			v.nums[i], _ = strconv.Atoi(m[i+1])
		}
	}
	if m[4] != "" {
		v.pre = strings.Split(m[4], ".")
	}
	return v
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// comparePre follows semver: a version with a pre-release comes before the same version without one; identifiers
// compare one by one, numbers by value and before words, and a shorter list before a longer one that starts like it.
func comparePre(a []string, b []string) int {
	if len(a) == 0 || len(b) == 0 {
		switch {
		case len(a) == len(b):
			return 0
		case len(a) == 0:
			return 1
		default:
			return -1
		}
	}
	for i := 0; i < len(a) && i < len(b); i++ {
		an, bn := isNumeric(a[i]), isNumeric(b[i])
		switch {
		case an && bn:
			x, _ := strconv.Atoi(a[i])
			y, _ := strconv.Atoi(b[i])
			if x != y {
				return cmpInt(x, y)
			}
		case an != bn:
			if an {
				return -1
			}
			return 1
		case a[i] != b[i]:
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return cmpInt(len(a), len(b))
}

func cmpInt(a int, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func compareVersions(a version, b version) int {
	for i := range a.nums {
		if c := cmpInt(a.nums[i], b.nums[i]); c != 0 {
			return c
		}
	}
	return comparePre(a.pre, b.pre)
}

func tabBefore(a *forgeMilestone, av version, b *forgeMilestone, bv version) bool {
	if av.ok != bv.ok {
		return av.ok
	}
	if av.ok {
		if c := compareVersions(av, bv); c != 0 {
			return c < 0
		}
	}
	ad, bd := parseTime(a.DueOn), parseTime(b.DueOn)
	if ad.IsZero() != bd.IsZero() {
		return !ad.IsZero()
	}
	if !ad.Equal(bd) {
		return ad.Before(bd)
	}
	if !av.ok && av.title != bv.title {
		return av.title < bv.title
	}
	return a.Number < b.Number
}

// orderMilestones is the open milestones as the tabs list them, a milestone the forge gave no number left out.
func orderMilestones(list []forgeMilestone) []forgeMilestone {
	type entry struct {
		m *forgeMilestone
		v version
	}
	entries := make([]entry, 0, len(list))
	for i := range list {
		if list[i].Number <= 0 {
			continue
		}
		entries = append(entries, entry{m: &list[i], v: parseVersion(list[i].Title)})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return tabBefore(entries[i].m, entries[i].v, entries[j].m, entries[j].v)
	})
	rtn := make([]forgeMilestone, len(entries))
	for i, e := range entries {
		rtn[i] = *e.m
	}
	return rtn
}
