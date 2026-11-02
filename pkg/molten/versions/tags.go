// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package versions

import (
	"strings"
)

const (
	DefaultTagPrefix = "v"
	// Proposed for the first public release when the project declares no versions.firstpublic.
	DefaultFirstPublic = "1.0.0"

	ChannelRc     = "rc"
	ChannelPublic = "public"

	// versions.rcformat (#1155): how a project numbers its release candidates. Numeric (X.Y.Z-N) is the default: an MSI
	// installer only takes a number after the dash (Notulia's rule).
	RcFormatNumeric = "numeric"
	// X.Y.Z-rc.N.
	RcFormatRcDot = "rcdot"
)

// Rules are a project's versions settings (versions.tagprefix, versions.firstpublic, versions.rcformat in
// .molten/project.json).
type Rules struct {
	TagPrefix string `json:"tagprefix"`
	// The first public release's number. Tags below its first candidate are not this project's releases: a fork that
	// fetched its upstream's tags (Wave's v0.14.5) must not read them as its own.
	FirstPublic string `json:"firstpublic"`
	// RcFormatNumeric ("" too) or RcFormatRcDot: the form of the next candidates only, both forms are always read.
	RcFormat string `json:"rcformat,omitempty"`
}

func ValidRcFormat(f string) bool {
	return f == "" || f == RcFormatNumeric || f == RcFormatRcDot
}

func (r Rules) rcLabel() string {
	if r.RcFormat == RcFormatRcDot {
		return RcLabelRc
	}
	return ""
}

// RcPattern is how the project's candidates read, for a message: X.Y.Z-N or X.Y.Z-rc.N.
func (r Rules) RcPattern() string {
	if r.RcFormat == RcFormatRcDot {
		return "X.Y.Z-rc.N"
	}
	return "X.Y.Z-N"
}

func (r Rules) prefix() string {
	if r.TagPrefix == "" {
		return DefaultTagPrefix
	}
	return r.TagPrefix
}

func (r Rules) floor() (Version, bool) {
	if r.FirstPublic == "" {
		return Version{}, false
	}
	base, err := ParseBase(r.FirstPublic)
	if err != nil {
		return Version{}, false
	}
	return base.WithRc(1), true
}

// Tag is the tag of a version, with the project's prefix.
func (r Rules) Tag(v Version) string {
	return r.prefix() + v.String()
}

// ReleaseOf reads a tag as one of the project's releases: the prefix, a strict version, and not below the floor.
func (r Rules) ReleaseOf(tag string) (Version, bool) {
	tag = strings.TrimSpace(tag)
	rest, ok := strings.CutPrefix(tag, r.prefix())
	if !ok {
		return Version{}, false
	}
	v, err := ParseVersion(rest)
	if err != nil {
		return Version{}, false
	}
	if floor, ok := r.floor(); ok && Compare(v, floor) < 0 {
		return Version{}, false
	}
	return v, true
}

// ChannelOfTag returns "rc", "public", or "" for a tag that is not one of the project's releases: a tag nobody can
// classify is never published under a default (Notulia's channelOfTag).
func (r Rules) ChannelOfTag(tag string) string {
	v, ok := r.ReleaseOf(tag)
	if !ok {
		return ""
	}
	if v.IsRc() {
		return ChannelRc
	}
	return ChannelPublic
}

// highest returns the highest release tag of one channel, or "".
func (r Rules) highest(tags []string, rc bool) string {
	best := ""
	var bestVersion Version
	for _, tag := range tags {
		v, ok := r.ReleaseOf(tag)
		if !ok || v.IsRc() != rc {
			continue
		}
		if best == "" || Compare(v, bestVersion) > 0 {
			best, bestVersion = strings.TrimSpace(tag), v
		}
	}
	return best
}

// LastPublic is the highest public release among the tags, in semver order (not by date), or "".
func (r Rules) LastPublic(tags []string) string {
	return r.highest(tags, false)
}

// LastRc is the highest release candidate among the tags, or "".
func (r Rules) LastRc(tags []string) string {
	return r.highest(tags, true)
}

// NextRc is the next free candidate number of a public version: one more than the highest candidate number already
// tagged, in either form (after X.Y.Z-2, X.Y.Z-rc.3).
func (r Rules) NextRc(base Version, tags []string) int {
	max := 0
	for _, tag := range tags {
		v, ok := r.ReleaseOf(tag)
		if !ok || !v.IsRc() || Compare(v.Base(), base.Base()) != 0 {
			continue
		}
		max = maxInt(max, v.Rc)
	}
	return max + 1
}

// NextCandidate is the next release candidate of a public version, in the project's format. A version that already
// has an X.Y.Z-rc.N candidate keeps that form until it is public: an X.Y.Z-N after it would sort below it, and an
// updater would never offer it.
func (r Rules) NextCandidate(base Version, tags []string) Version {
	label := r.rcLabel()
	for _, tag := range tags {
		v, ok := r.ReleaseOf(tag)
		if ok && v.IsRc() && v.RcLabel != "" && Compare(v.Base(), base.Base()) == 0 {
			label = v.RcLabel
		}
	}
	return base.Base().WithRcLabel(r.NextRc(base, tags), label)
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
