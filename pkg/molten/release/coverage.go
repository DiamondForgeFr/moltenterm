// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The scope of a changelog section written by hand (#1142): a public user never saw the release candidates, so a
// public section covers everything since the last public release, candidates included, as the public notes do
// (previousRelease); a candidate's covers what changed since the previous release of either channel. Before a public
// section is marked done, it is compared with the range's facts: what is not mentioned is listed for the developer,
// who may leave internal items out on purpose.

// The conventional types a user would notice, as DraftNotes keeps them.
var userFacingTypes = []string{"feat", "fix", "perf", "revert"}

var headingRegex = regexp.MustCompile(`^(#{1,6})\s`)

// CoverageItem is one change of the range a section should mention: a ticket, or a commit claiming none.
type CoverageItem struct {
	// 0 for a commit claiming no ticket.
	Ticket int `json:"ticket,omitempty"`
	// What its commits said.
	Text string `json:"text"`
	Url  string `json:"url,omitempty"`
}

func (i CoverageItem) String() string {
	if i.Ticket == 0 {
		return i.Text
	}
	return fmt.Sprintf("#%d", i.Ticket)
}

func (e *Env) tagVersion(ctx context.Context, tag string) (*Project, versions.Version, error) {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return nil, versions.Version{}, err
	}
	v, ok := p.Rules.ReleaseOf(tag)
	if !ok {
		return nil, versions.Version{}, fmt.Errorf("%q is not a release tag of this project", tag)
	}
	return p, v, nil
}

// ChangelogSince is the release a changelog section of tag starts from, read in e.Dir (the release worktree): the last
// public release for a public version, the previous release of either channel for a candidate; "" for the first one.
func (e *Env) ChangelogSince(ctx context.Context, tag string) (string, error) {
	p, v, err := e.tagVersion(ctx, tag)
	if err != nil {
		return "", err
	}
	return e.previousRelease(ctx, e.Dir, p, v), nil
}

// ChangelogItems is what a section of tag should mention: the tickets of the range's user-facing commits, and such
// commits claiming no ticket, newest first. Read from git only: nothing waits on GitHub.
func (e *Env) ChangelogItems(ctx context.Context, tag string) (string, []CoverageItem, error) {
	p, v, err := e.tagVersion(ctx, tag)
	if err != nil {
		return "", nil, err
	}
	since := e.previousRelease(ctx, e.Dir, p, v)
	subjects, err := e.rangeSubjects(ctx, e.Dir, since)
	if err != nil {
		return since, nil, fmt.Errorf("could not read the commits since %s: %w", NotesFacts{Since: since}.sinceLabel(), err)
	}
	url, _ := e.git(ctx, e.Dir, "remote", "get-url", "origin")
	return since, CoverageItems(subjects, NotesFacts{Repo: GithubRepo(url)}.repoUrl()), nil
}

// CoverageItems sorts the range's subjects into what a section should mention; base is the repository's web address,
// "" off GitHub.
func CoverageItems(subjects []string, base string) []CoverageItem {
	var items []CoverageItem
	index := map[int]int{}
	for _, raw := range subjects {
		subject := strings.TrimSpace(raw)
		c, ok := versions.ParseCommit(versions.CommitInput{Subject: subject})
		if !ok || !slices.Contains(userFacingTypes, c.Type) {
			continue
		}
		// The subject as written: a command name (`sf new`) keeps its case.
		text := strings.TrimSpace(trailingTicketRegex.ReplaceAllString(c.Subject, ""))
		refs := commitTickets(subject)
		if len(refs) == 0 {
			if text != "" && !slices.ContainsFunc(items, func(i CoverageItem) bool { return i.Ticket == 0 && i.Text == text }) {
				items = append(items, CoverageItem{Text: text})
			}
			continue
		}
		for _, n := range refs {
			if _, seen := index[n]; seen {
				continue
			}
			index[n] = len(items)
			item := CoverageItem{Ticket: n, Text: text}
			if base != "" {
				item.Url = fmt.Sprintf("%s/issues/%d", base, n)
			}
			items = append(items, item)
		}
	}
	return items
}

// ChangelogSection finds the section of a version: from the line holding heading (the step's check text) or, without
// one, from the first heading naming the version, to the next heading of the same level or above.
func ChangelogSection(text string, version string, heading string) (string, bool) {
	lines := strings.Split(text, "\n")
	versionRegex := regexp.MustCompile(`(^|[^0-9.])` + regexp.QuoteMeta(version) + `($|[^0-9.-]|-[^0-9])`)
	start, level := -1, 0
	for i, line := range lines {
		line = strings.TrimRight(line, "\r")
		m := headingRegex.FindStringSubmatch(line)
		found := false
		if heading != "" {
			found = strings.Contains(line, heading)
		} else {
			found = m != nil && versionRegex.MatchString(line)
		}
		if !found {
			continue
		}
		start = i
		if m != nil {
			level = len(m[1])
		}
		break
	}
	if start < 0 {
		return "", false
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		m := headingRegex.FindStringSubmatch(lines[i])
		if m != nil && (level == 0 && len(m[1]) <= 2 || level > 0 && len(m[1]) <= level) {
			end = i
			break
		}
	}
	return strings.Join(lines[start:end], "\n"), true
}

func normalizedWords(s string) string {
	var b strings.Builder
	space := true
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			space = false
			continue
		}
		if !space {
			b.WriteRune(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

// mentionsTicket: #12, …/issues/12 or …/pull/12, never #123.
func mentionsTicket(section string, n int) bool {
	re := regexp.MustCompile(`(?:#|/issues/|/pull/)` + strconv.Itoa(n) + `(?:[^0-9]|$)`)
	return re.MatchString(section)
}

// UncoveredItems are the items the section does not mention. A ticket is mentioned by its number or its link; a commit
// claiming no ticket by its subject, compared only in an English section: another language words it its own way.
func UncoveredItems(section string, items []CoverageItem, lang string) []CoverageItem {
	words := " " + normalizedWords(section) + " "
	var rtn []CoverageItem
	for _, item := range items {
		if item.Ticket > 0 {
			if !mentionsTicket(section, item.Ticket) {
				rtn = append(rtn, item)
			}
			continue
		}
		if lang != "en" {
			continue
		}
		if subject := normalizedWords(item.Text); subject != "" && !strings.Contains(words, " "+subject+" ") {
			rtn = append(rtn, item)
		}
	}
	return rtn
}
