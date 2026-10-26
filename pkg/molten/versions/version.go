// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package versions holds a project's release numbering (FR-REL-001, DS-REL-001), ported from Notulia
// (src/lib/releaseChannel.ts, src/lib/nextVersion.ts): a public release is X.Y.Z, a release candidate X.Y.Z-N or
// X.Y.Z-rc.N (versions.rcformat, #1155), and the next number is read from conventional commits.
// frontend/moltenterm-shell/releases/versions.ts is its twin; both run testdata/vectors.json, so they cannot drift
// apart unnoticed.
package versions

import (
	"fmt"
	"regexp"
	"strconv"
)

const (
	// The highest candidate number a Windows MSI ProductVersion can hold (Notulia's MAX_PRERELEASE).
	MaxRc = 65535

	// The word of an X.Y.Z-rc.N candidate.
	RcLabelRc = "rc"
)

// No leading zeros, and a candidate number from 1: X.Y.Z-0 is never a release, so a working tree may carry it to
// mean "before the first release candidate". Both candidate forms are always read, whatever the project's
// versions.rcformat: a project that switches keeps its old tags.
var versionRegex = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(rc)\.)?([1-9]\d*))?$`)

type Version struct {
	Major int
	Minor int
	Patch int
	// 0 for a public release.
	Rc int
	// "" for X.Y.Z-N, RcLabelRc for X.Y.Z-rc.N; meaningless on a public release.
	RcLabel string
}

// ParseVersion reads X.Y.Z, X.Y.Z-N or X.Y.Z-rc.N (1 ≤ N ≤ MaxRc).
func ParseVersion(s string) (Version, error) {
	m := versionRegex.FindStringSubmatch(s)
	if m == nil {
		return Version{}, fmt.Errorf("not a release version: %q (X.Y.Z, X.Y.Z-N or X.Y.Z-rc.N)", s)
	}
	nums := make([]int, 4)
	for i, group := range []int{1, 2, 3, 5} {
		if m[group] == "" {
			continue
		}
		n, err := strconv.Atoi(m[group])
		if err != nil {
			return Version{}, fmt.Errorf("not a release version: %q", s)
		}
		nums[i] = n
	}
	if nums[3] > MaxRc {
		return Version{}, fmt.Errorf("not a release version: %q (a candidate number is at most %d)", s, MaxRc)
	}
	return Version{Major: nums[0], Minor: nums[1], Patch: nums[2], Rc: nums[3], RcLabel: m[4]}, nil
}

// ParseBase reads a public version, X.Y.Z.
func ParseBase(s string) (Version, error) {
	v, err := ParseVersion(s)
	if err != nil {
		return Version{}, err
	}
	if v.IsRc() {
		return Version{}, fmt.Errorf("not a public version: %q (X.Y.Z)", s)
	}
	return v, nil
}

func (v Version) String() string {
	if v.Rc == 0 {
		return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	}
	if v.RcLabel != "" {
		return fmt.Sprintf("%d.%d.%d-%s.%d", v.Major, v.Minor, v.Patch, v.RcLabel, v.Rc)
	}
	return fmt.Sprintf("%d.%d.%d-%d", v.Major, v.Minor, v.Patch, v.Rc)
}

func (v Version) IsRc() bool {
	return v.Rc != 0
}

// Base is the public version a release candidate leads to.
func (v Version) Base() Version {
	return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch}
}

// WithRc is the X.Y.Z-N candidate of v's public version; WithRcLabel the same in another form.
func (v Version) WithRc(rc int) Version {
	return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch, Rc: rc}
}

func (v Version) WithRcLabel(rc int, label string) Version {
	return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch, Rc: rc, RcLabel: label}
}

func compareInt(a int, b int) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

// Compare orders as semver does: 1.0.0-1 < 1.0.0-2 < 1.0.0-10 < 1.0.0-rc.1 < 1.0.0-rc.2 < 1.0.0 < 1.0.1-1. A numeric
// pre-release sorts before an alphanumeric one, so every X.Y.Z-N comes before every X.Y.Z-rc.N: the order npm and the
// updaters apply.
func Compare(a Version, b Version) int {
	if c := compareInt(a.Major, b.Major); c != 0 {
		return c
	}
	if c := compareInt(a.Minor, b.Minor); c != 0 {
		return c
	}
	if c := compareInt(a.Patch, b.Patch); c != 0 {
		return c
	}
	if a.Rc == 0 || b.Rc == 0 {
		return -compareInt(a.Rc, b.Rc)
	}
	if a.RcLabel != b.RcLabel {
		if a.RcLabel == "" {
			return -1
		}
		if b.RcLabel == "" {
			return 1
		}
		if a.RcLabel < b.RcLabel {
			return -1
		}
		return 1
	}
	return compareInt(a.Rc, b.Rc)
}
