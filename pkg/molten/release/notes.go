// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The minimal notes of a release, drafted from its commit subjects (Notulia's release-notes.mjs fallback). Written
// notes (DS-REL-003: the facts handed to the project's coding agent, an audit of the public text) replace DraftNotes;
// until then the draft is what the developer reviews and edits before the cut.

const maxNotesLines = 40

var trailingTicketRegex = regexp.MustCompile(`\s*\(#\d+\)\s*$`)

type NotesFacts struct {
	Tag     string
	Channel string
	// The release the notes start from ("" for the first one).
	Since string
	// Commit subjects since then, newest first, merges excluded.
	Subjects []string
}

func (f NotesFacts) sinceLabel() string {
	if f.Since == "" {
		return "the start of the history"
	}
	return f.Since
}

// previousRelease is the release the notes of v start from: the last public release for a public one, the last
// release of either channel for a candidate; only tags reachable from the cut count.
func (e *Env) previousRelease(ctx context.Context, wt string, p *Project, v versions.Version) string {
	best := ""
	var bestVersion versions.Version
	for _, tag := range e.releaseTags(ctx, wt, p, "--merged", "HEAD") {
		tv, _ := p.Rules.ReleaseOf(tag)
		if versions.Compare(tv, v) >= 0 || (!v.IsRc() && tv.IsRc()) {
			continue
		}
		if best == "" || versions.Compare(tv, bestVersion) > 0 {
			best, bestVersion = tag, tv
		}
	}
	return best
}

func (e *Env) gatherNotesFacts(ctx context.Context, wt string, p *Project, tag string, v versions.Version) (NotesFacts, error) {
	facts := NotesFacts{Tag: tag, Channel: versions.ChannelPublic, Since: e.previousRelease(ctx, wt, p, v)}
	if v.IsRc() {
		facts.Channel = versions.ChannelRc
	}
	rangeArg := "HEAD"
	if facts.Since != "" {
		rangeArg = facts.Since + "..HEAD"
	}
	args := []string{"log", "--no-merges", "--format=%s", rangeArg}
	// A fork's upstream history is not the project's own: the first release would otherwise list every upstream
	// commit since the beginning.
	if remotes, _ := e.gitLines(ctx, wt, "remote"); slices.Contains(remotes, "upstream") {
		args = append(args, "--not", "--remotes=upstream")
	}
	subjects, err := e.gitLines(ctx, wt, args...)
	if err != nil {
		return facts, fmt.Errorf("could not read the commits since %s: %w", facts.sinceLabel(), err)
	}
	facts.Subjects = subjects
	return facts, nil
}

func noteLine(subject string) string {
	subject = strings.TrimSpace(trailingTicketRegex.ReplaceAllString(subject, ""))
	first, size := utf8.DecodeRuneInString(subject)
	if first == utf8.RuneError {
		return subject
	}
	return string(unicode.ToUpper(first)) + subject[size:]
}

// DraftNotes groups the conventional subjects a user would notice (feat, then fix, perf and revert) without their
// scope or ticket number; the rest (chore, ci, docs, refactor…, and subjects outside the convention) is left out.
func DraftNotes(f NotesFacts) string {
	var added, fixed []string
	seen := map[string]bool{}
	for _, subject := range f.Subjects {
		c, ok := versions.ParseCommit(versions.CommitInput{Subject: subject})
		if !ok {
			continue
		}
		line := noteLine(c.Subject)
		key := strings.ToLower(line)
		if line == "" || seen[key] {
			continue
		}
		switch c.Type {
		case "feat":
			added = append(added, line)
		case "fix", "perf", "revert":
			fixed = append(fixed, line)
		default:
			continue
		}
		seen[key] = true
	}
	var sb strings.Builder
	if len(added)+len(fixed) == 0 {
		sb.WriteString("Maintenance release: nothing changes for users.\n")
		return sb.String()
	}
	budget := maxNotesLines
	left := 0
	section := func(title string, lines []string) {
		if len(lines) == 0 {
			return
		}
		if budget <= 0 {
			left += len(lines)
			return
		}
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		fmt.Fprintf(&sb, "## %s\n\n", title)
		for i, line := range lines {
			if budget == 0 {
				left += len(lines) - i
				break
			}
			fmt.Fprintf(&sb, "- %s\n", line)
			budget--
		}
	}
	section("New", added)
	section("Fixes", fixed)
	if left > 0 {
		fmt.Fprintf(&sb, "\nAnd %d more changes.\n", left)
	}
	return sb.String()
}
