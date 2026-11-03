// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The commits the release chain makes follow the project's commit convention (#1046): a project whose workflow
// requires a ticket (.saasfoundry.json workflow.commitFormat.requireTicket) or whose commitlint wants a "(#N)" scope
// gets "chore(#N): release v1.2.0"; the commit-msg hook would refuse anything else in the release worktree. Every
// release commit also carries a Molten-Release trailer, so the chain finds it whatever its subject.

const (
	ReleaseTrailer = "Molten-Release"
	// The ticket of the release, when the commit format needs one and no --ticket is given.
	TicketEnv = "MOLTEN_RELEASE_TICKET"

	defaultMaxHeader = 100
)

var commitlintFiles = []string{"commitlint.config.mjs", "commitlint.config.js", "commitlint.config.cjs", "commitlint.config.ts",
	"commitlint.config.mts", "commitlint.config.cts", ".commitlintrc", ".commitlintrc.json", ".commitlintrc.js", ".commitlintrc.cjs",
	".commitlintrc.mjs", ".commitlintrc.yml", ".commitlintrc.yaml", ".commitlintrc.ts"}

var commitlintTicketScopeRegex = regexp.MustCompile(`\\\(#`)
var commitlintScopeRequiredRegex = regexp.MustCompile(`['"]scope-empty['"]\s*:\s*\[\s*2\s*,\s*['"]never['"]`)
var commitlintHeaderMaxRegex = regexp.MustCompile(`['"]header-max-length['"]\s*:\s*\[\s*\d\s*,\s*['"]always['"]\s*,\s*(\d+)`)

type Convention struct {
	// The commits name the release's ticket as their scope: chore(#N): ...
	TicketScope bool
	MaxHeader   int
}

// ReadConvention reads the commit convention of the project at root.
func ReadConvention(root string) Convention {
	c := Convention{MaxHeader: defaultMaxHeader}
	if _, requireTicket := molten.CommitFormatOf(root); requireTicket {
		c.TicketScope = true
	}
	for _, name := range commitlintFiles {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || len(data) > 1<<20 {
			continue
		}
		text := string(data)
		if commitlintTicketScopeRegex.MatchString(text) || commitlintScopeRequiredRegex.MatchString(text) {
			c.TicketScope = true
		}
		if m := commitlintHeaderMaxRegex.FindStringSubmatch(text); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil && n > 20 {
				c.MaxHeader = n
			}
		}
		break
	}
	return c
}

// header makes a commit subject: "chore(#N): text" when the convention wants the ticket, else "chore(release): text",
// cut to the convention's length.
func (c Convention) header(ticket int, text string) string {
	scope := "release"
	if c.TicketScope && ticket > 0 {
		scope = "#" + strconv.Itoa(ticket)
	}
	h := fmt.Sprintf("chore(%s): %s", scope, text)
	if c.MaxHeader > 0 && len(h) > c.MaxHeader {
		h = strings.TrimSpace(h[:c.MaxHeader-1]) + "…"
	}
	return h
}

// ReleaseSubject is the subject of a release's commit: "chore(release): v1.2.0 (public)", or "chore(#N): release
// v1.2.0" when the convention names the ticket.
func (c Convention) ReleaseSubject(ticket int, tag string, channel string) string {
	if c.TicketScope && ticket > 0 {
		return c.header(ticket, "release "+tag)
	}
	return ReleaseCommitSubject(tag, channel)
}

// ReleaseMessage is the release commit's whole message: its subject and the trailer the chain finds it by.
func (c Convention) ReleaseMessage(ticket int, tag string, channel string) string {
	return c.ReleaseSubject(ticket, tag, channel) + "\n\n" + ReleaseTrailer + ": " + tag
}

// IsReleaseCommit tells whether a commit (its subject and body) is the release commit of tag.
func IsReleaseCommit(subject string, body string, tag string) bool {
	if strings.HasPrefix(subject, "chore(release): "+tag+" (") {
		return true
	}
	for _, line := range strings.Split(body, "\n") {
		if strings.TrimSpace(line) == ReleaseTrailer+": "+tag {
			return true
		}
	}
	return false
}

// ReleaseTagOf reads the tag a release commit was made for, or "".
func ReleaseTagOf(subject string, body string) string {
	if name, ok := strings.CutPrefix(subject, "chore(release): "); ok {
		if tag, _, ok := strings.Cut(name, " ("); ok {
			return tag
		}
	}
	for _, line := range strings.Split(body, "\n") {
		if tag, ok := strings.CutPrefix(strings.TrimSpace(line), ReleaseTrailer+": "); ok {
			return strings.TrimSpace(tag)
		}
	}
	return ""
}

// TitleNamesTag tells whether a pull request's title names the tag as a whole (v1.0.0-1, not v1.0.0-10).
func TitleNamesTag(title string, tag string) bool {
	for from := 0; ; {
		i := strings.Index(title[from:], tag)
		if i < 0 {
			return false
		}
		end := from + i + len(tag)
		if end == len(title) || title[end] == ' ' || title[end] == ')' {
			return true
		}
		from = end
	}
}
