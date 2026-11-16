// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package mission

import (
	"regexp"
	"strings"
)

// What a pull request asks the developer to test (FR-BRW-017, DS-BRW-024, #2326): the items of its body's "How to
// verify" section, the section the workflow asks every agent to write, or a section of the same purpose under another
// usual name. A section without a list gives its first paragraph, a line per step. Automated test sections ("Tests",
// "Testing") are not the developer's steps and are left out.

const (
	verifyMaxSteps   = 12
	verifyMaxStepLen = 280
)

var verifyHeadings = []string{
	"how to verify", "how to test", "steps to verify", "test plan", "testing plan", "human testing", "manual testing",
	"to test", "comment vérifier", "comment tester", "plan de test", "à tester", "à vérifier",
}

var (
	verifyHeadingRe     = regexp.MustCompile(`^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$`)
	verifyBoldHeadingRe = regexp.MustCompile(`^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$`)
	verifyListItemRe    = regexp.MustCompile(`^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$`)
	verifyRuleRe        = regexp.MustCompile(`^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$`)
)

// headingOf reads a Markdown heading (`## How to verify`) or a line that only holds bold text (`**How to verify**`).
func headingOf(line string) (string, bool) {
	if m := verifyHeadingRe.FindStringSubmatch(line); m != nil {
		return m[1], true
	}
	if m := verifyBoldHeadingRe.FindStringSubmatch(line); m != nil {
		return m[1], true
	}
	return "", false
}

func isVerifyHeading(title string) bool {
	norm := strings.ToLower(strings.Trim(strings.TrimSpace(title), " :*_`"))
	for _, heading := range verifyHeadings {
		if norm == heading || strings.HasPrefix(norm, heading+" ") || strings.HasPrefix(norm, heading+":") || strings.HasPrefix(norm, heading+" (") {
			return true
		}
	}
	return false
}

func cleanStep(text string) string {
	text = strings.TrimSpace(strings.NewReplacer("**", "", "__", "").Replace(text))
	if runes := []rune(text); len(runes) > verifyMaxStepLen {
		text = strings.TrimSpace(string(runes[:verifyMaxStepLen-1])) + "…"
	}
	return text
}

// verifySteps lists the steps of the body's verification section, nil when it has none.
func verifySteps(body string) []string {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	start := -1
	for i, line := range lines {
		if title, ok := headingOf(line); ok && isVerifyHeading(title) {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil
	}
	var items []string
	fence := false
	for _, line := range lines[start:] {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		if _, ok := headingOf(line); ok || verifyRuleRe.MatchString(line) {
			break
		}
		if m := verifyListItemRe.FindStringSubmatch(line); m != nil {
			items = append(items, cleanStep(m[1]))
			continue
		}
		// A wrapped item goes on in an indented line.
		if trimmed != "" && len(items) > 0 && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) {
			items[len(items)-1] = cleanStep(items[len(items)-1] + " " + trimmed)
		}
	}
	steps := items
	if len(steps) == 0 {
		steps = firstParagraph(lines[start:])
	}
	rtn := []string{}
	for _, step := range steps {
		if step != "" {
			rtn = append(rtn, step)
		}
		if len(rtn) == verifyMaxSteps {
			break
		}
	}
	if len(rtn) == 0 {
		return nil
	}
	return rtn
}

// firstParagraph: the section's first run of text lines, outside code, up to the next heading or rule.
func firstParagraph(lines []string) []string {
	var rtn []string
	fence := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fence = !fence
			continue
		}
		if fence {
			continue
		}
		if _, ok := headingOf(line); ok || verifyRuleRe.MatchString(line) {
			break
		}
		if trimmed == "" {
			if len(rtn) > 0 {
				break
			}
			continue
		}
		rtn = append(rtn, cleanStep(trimmed))
	}
	return rtn
}
