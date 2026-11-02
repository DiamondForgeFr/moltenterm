// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// What the merged history adds for the list of what would ship (#903, FR-MC-021): read from each PR's body and labels
// here, so the bodies never travel to the view.

const (
	BehaviourFromLabel    = "label"
	BehaviourFromSection  = "section"
	BehaviourFromBreaking = "breaking"

	prSummaryMaxRunes = 200
	// Epic > Story > Task: two levels above a ticket are enough.
	historyParentFields = "parent{number title url issueType{name} parent{number title url issueType{name}}}"
)

type HistoryTicketRef struct {
	Number int    `json:"number"`
	Title  string `json:"title,omitempty"`
	Url    string `json:"url,omitempty"`
	Type   string `json:"type,omitempty"`
}

// BehaviourChange flags a PR that changes behaviour the user already knows. The signals are conservative: a label
// that names it, a body section headed so, or a "!" conventional title; never a guess from the prose.
type BehaviourChange struct {
	From  string `json:"from"`
	Label string `json:"label,omitempty"`
	// What to verify: the first line of the body's section, when there is one.
	Verify string `json:"verify,omitempty"`
}

type ghHistoryParent struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Url       string `json:"url"`
	IssueType *struct {
		Name string `json:"name"`
	} `json:"issueType"`
	Parent *ghHistoryParent `json:"parent"`
}

var (
	behaviourLabelRe   = regexp.MustCompile(`(?i)breaking|behaviou?r[ _-]?change`)
	behaviourHeadingRe = regexp.MustCompile(`(?i)^(?:#{1,6}\s*|\*\*|__)\s*(?:behaviou?r changes?|breaking changes?|changements? de comportement)\b`)
	breakingFooterRe   = regexp.MustCompile(`^BREAKING[ -]CHANGE:\s*(.*)$`)
	breakingTitleRe    = regexp.MustCompile(`^[a-z]+(?:\([^)]*\))?!:`)
	summaryHeadingRe   = regexp.MustCompile(`(?i)^#{1,6}\s*(?:summary|what|résumé)\s*$`)
	headingRe          = regexp.MustCompile(`^#{1,6}\s`)
	closingLineRe      = regexp.MustCompile(`(?i)^(?:resolves|closes|fixes|refs?)\s+#\d+\.?$`)
	htmlCommentRe      = regexp.MustCompile(`(?s)<!--.*?-->`)
	listMarkRe         = regexp.MustCompile(`^(?:[-*+]|\d+[.)])\s+`)
	mdLinkRe           = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
)

func parentRefs(parent *ghHistoryParent) []HistoryTicketRef {
	var rtn []HistoryTicketRef
	for p := parent; p != nil && p.Number > 0; p = p.Parent {
		ref := HistoryTicketRef{Number: p.Number, Title: p.Title, Url: p.Url}
		if p.IssueType != nil {
			ref.Type = p.IssueType.Name
		}
		rtn = append(rtn, ref)
	}
	return rtn
}

func bodyLines(body string) []string {
	body = htmlCommentRe.ReplaceAllString(body, "")
	return strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
}

// plainLine turns a markdown line into one line of text, cut to the summary's length.
func plainLine(line string) string {
	line = strings.TrimSpace(line)
	line = listMarkRe.ReplaceAllString(line, "")
	line = mdLinkRe.ReplaceAllString(line, "$1")
	line = strings.NewReplacer("**", "", "__", "", "`", "").Replace(line)
	line = strings.TrimSpace(line)
	if utf8.RuneCountInString(line) > prSummaryMaxRunes {
		runes := []rune(line)
		line = strings.TrimSpace(string(runes[:prSummaryMaxRunes-1])) + "…"
	}
	return line
}

// firstProse is the first line of text from start on, before the next heading; skip says whether a heading ends it.
func firstProse(lines []string, start int, stopAtHeading bool) string {
	for i := start; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" || line == "---" || strings.HasPrefix(line, "|") || strings.HasPrefix(line, "```") {
			continue
		}
		if headingRe.MatchString(line) {
			if stopAtHeading {
				return ""
			}
			continue
		}
		if closingLineRe.MatchString(line) {
			continue
		}
		if text := plainLine(line); text != "" {
			return text
		}
	}
	return ""
}

// prSummary is one line from a PR body: the first under a Summary or What heading, else its first line of prose.
func prSummary(body string) string {
	lines := bodyLines(body)
	for i, line := range lines {
		if summaryHeadingRe.MatchString(strings.TrimSpace(line)) {
			if text := firstProse(lines, i+1, true); text != "" {
				return text
			}
		}
	}
	return firstProse(lines, 0, false)
}

func behaviourChange(title string, body string, labels []string) *BehaviourChange {
	var rtn *BehaviourChange
	for _, label := range labels {
		if behaviourLabelRe.MatchString(label) {
			rtn = &BehaviourChange{From: BehaviourFromLabel, Label: label}
			break
		}
	}
	lines := bodyLines(body)
	for i, line := range lines {
		line = strings.TrimSpace(line)
		verify := ""
		if m := breakingFooterRe.FindStringSubmatch(line); m != nil {
			verify = plainLine(m[1])
			if verify == "" {
				verify = firstProse(lines, i+1, true)
			}
		} else if behaviourHeadingRe.MatchString(line) {
			// "**Behaviour change:** text" carries its text on the heading's line.
			if !strings.HasPrefix(line, "#") {
				rest := behaviourHeadingRe.ReplaceAllString(line, "")
				verify = plainLine(strings.TrimLeft(rest, ":*_ "))
			}
			if verify == "" {
				verify = firstProse(lines, i+1, true)
			}
		} else {
			continue
		}
		if rtn == nil {
			rtn = &BehaviourChange{From: BehaviourFromSection}
		}
		rtn.Verify = verify
		return rtn
	}
	if rtn == nil && breakingTitleRe.MatchString(title) {
		rtn = &BehaviourChange{From: BehaviourFromBreaking}
	}
	return rtn
}
