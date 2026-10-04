// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Bug reports from agents (FR-MORPH-011, DS-MORPH-010): what `molten bug` decides before anything reaches GitHub. A
// coding agent searches MoltenTerm's issues first, then prepares a report that carries the environment and none of the
// user's secrets; it files only once the user approved. Same process as SaaSFoundryAI's `sf feedback bug`.

const (
	BugRepo        = "DiamondForgeFr/moltenterm"
	BugRepoEnvName = "MOLTEN_BUG_REPO"
	BugLabel       = "bug"
	BugAgentLabel  = "reported-from-moltenterm"
	// The developers' own bug tickets carry the workflow's complexity label.
	BugWorkflowLabel = "complexity: bug"

	BugAdviceComment    = "comment"
	BugAdviceUpdate     = "update"
	BugAdviceRegression = "regression"
	BugAdviceNotPlanned = "not-planned"

	// Titles this close are the same bug: filing waits for --new.
	BugDuplicateSimilarity = 0.5
	// GitHub refuses longer new-issue URLs; the body is shortened to fit.
	maxIssueUrlLength = 7000
)

type BugIssue struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	State       string `json:"state"`
	StateReason string `json:"statereason,omitempty"`
	Url         string `json:"url"`
	CreatedAt   string `json:"createdat"`
	ClosedAt    string `json:"closedat,omitempty"`
}

type BugMatch struct {
	BugIssue
	Advice     string  `json:"advice"`
	Similarity float64 `json:"similarity"`
	Says       string  `json:"says"`
}

type BugEnvironment struct {
	Version   string `json:"version"`
	BuildTime string `json:"buildtime"`
	Os        string `json:"os"`
	Arch      string `json:"arch"`
}

type BugReport struct {
	Title    string `json:"title"`
	What     string `json:"what"`
	Expected string `json:"expected,omitempty"`
	Steps    string `json:"steps,omitempty"`
	// The issue this report says is back.
	Regression int `json:"regression,omitempty"`
}

type bugRedaction struct {
	pattern     *regexp.Regexp
	replacement string
}

// Most specific first, so a narrower redaction wins when a line matches several (from plan-feedback-bug.js).
var bugRedactions = []bugRedaction{
	{regexp.MustCompile(`\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`), "<jwt>"},
	{regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{30,}\b`), "<github-token>"},
	{regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}\b`), "<github-token>"},
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`), "<api-key>"},
	{regexp.MustCompile(`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b`), "<stripe-key>"},
	{regexp.MustCompile(`\bxox[abpors]-[A-Za-z0-9-]{10,}\b`), "<slack-token>"},
	{regexp.MustCompile(`\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{10,}`), "Bearer <redacted>"},
	{regexp.MustCompile(`\b[Bb]asic\s+[A-Za-z0-9+/=]{10,}`), "Basic <redacted>"},
	{regexp.MustCompile(`(?i)(--(?:token|password|secret|api[-_]?key|auth|access[-_]?token|refresh[-_]?token)[=\s])[^\s&"']+`), "${1}<redacted>"},
	{regexp.MustCompile(`\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_?KEY|AUTH|PRIVATE_?KEY))\s*[:=]\s*["']?[^"'\s]+["']?`), "${1}=<redacted>"},
	{regexp.MustCompile(`(?i)([?&](?:token|password|secret|api[-_]?key|auth|access[-_]?token|refresh[-_]?token)=)[^&\s]+`), "${1}<redacted>"},
	{regexp.MustCompile(`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`), "<email>"},
	{regexp.MustCompile(`/Users/[^/\s:"']+`), "/Users/<user>"},
	{regexp.MustCompile(`/home/[^/\s:"']+`), "/home/<user>"},
	{regexp.MustCompile(`(?i)C:\\Users\\[^\\\s:"']+`), `C:\Users\<user>`},
}

// RedactBugText removes what must never leave the user's machine: tokens, keys, passwords, e-mails, home paths.
func RedactBugText(text string) string {
	for _, r := range bugRedactions {
		text = r.pattern.ReplaceAllString(text, r.replacement)
	}
	return text
}

// ParseBuildTime reads wavebase.BuildTime (YYYYMMDDHHMM, the build machine's local time, see Taskfile.yml); a dev
// build has none.
func ParseBuildTime(value string) (time.Time, bool) {
	t, err := time.ParseInLocation("200601021504", value, time.Local)
	return t, err == nil
}

var bugStopWords = map[string]bool{
	"a": true, "an": true, "the": true, "is": true, "are": true, "in": true, "on": true, "of": true, "to": true,
	"and": true, "or": true, "when": true, "with": true, "for": true, "it": true, "not": true, "does": true,
	"doesn": true, "t": true, "can": true, "cannot": true, "at": true, "by": true, "from": true, "be": true,
}

func bugWords(text string) map[string]bool {
	words := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len(w) > 1 && !bugStopWords[w] {
			words[w] = true
		}
	}
	return words
}

// TitleSimilarity is the share of meaningful words two titles have in common (0 to 1).
func TitleSimilarity(a string, b string) float64 {
	wa, wb := bugWords(a), bugWords(b)
	if len(wa) == 0 || len(wb) == 0 {
		return 0
	}
	common := 0
	for w := range wa {
		if wb[w] {
			common++
		}
	}
	return float64(common) / float64(len(wa)+len(wb)-common)
}

// BugAdvice says what to do with an existing issue: add the case to an open one; update when it was fixed after this
// build; file a regression when it was fixed before this build and the bug is back.
func BugAdvice(issue BugIssue, buildTime time.Time, haveBuildTime bool) (string, string) {
	if strings.EqualFold(issue.State, "open") {
		return BugAdviceComment, fmt.Sprintf("Open: add your case with `molten bug comment %d`.", issue.Number)
	}
	if strings.EqualFold(issue.StateReason, "not_planned") {
		return BugAdviceNotPlanned, "Closed as not planned: the developers chose not to change this."
	}
	closed, err := time.Parse(time.RFC3339, issue.ClosedAt)
	if err == nil && haveBuildTime && closed.After(buildTime) {
		return BugAdviceUpdate, fmt.Sprintf("Fixed on %s, after this build: update MoltenTerm.", closed.Format("2006-01-02"))
	}
	return BugAdviceRegression, fmt.Sprintf("Fixed before this build: if it happens again, report a regression with `--regression %d`.", issue.Number)
}

// MatchBugIssues advises on each issue found for a title, the closest first.
func MatchBugIssues(title string, issues []BugIssue, buildTime time.Time, haveBuildTime bool) []BugMatch {
	matches := make([]BugMatch, 0, len(issues))
	for _, issue := range issues {
		advice, says := BugAdvice(issue, buildTime, haveBuildTime)
		matches = append(matches, BugMatch{BugIssue: issue, Advice: advice, Says: says, Similarity: TitleSimilarity(title, issue.Title)})
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].Similarity > matches[j].Similarity })
	return matches
}

// OpenDuplicates are the open issues close enough to the title to be the same bug.
func OpenDuplicates(matches []BugMatch) []BugMatch {
	var rtn []BugMatch
	for _, m := range matches {
		if m.Advice == BugAdviceComment && m.Similarity >= BugDuplicateSimilarity {
			rtn = append(rtn, m)
		}
	}
	return rtn
}

func environmentLines(env BugEnvironment) string {
	build := env.BuildTime
	if t, ok := ParseBuildTime(build); ok {
		build = t.Format("2006-01-02 15:04")
	}
	return fmt.Sprintf("- MoltenTerm %s (built %s)\n- %s %s", env.Version, build, env.Os, env.Arch)
}

// BugReportBody is the issue body, redacted.
func BugReportBody(report BugReport, env BugEnvironment) string {
	var b strings.Builder
	b.WriteString("## What happened\n\n" + strings.TrimSpace(report.What) + "\n")
	if strings.TrimSpace(report.Expected) != "" {
		b.WriteString("\n## Expected\n\n" + strings.TrimSpace(report.Expected) + "\n")
	}
	if strings.TrimSpace(report.Steps) != "" {
		b.WriteString("\n## Steps to reproduce\n\n" + strings.TrimSpace(report.Steps) + "\n")
	}
	if report.Regression > 0 {
		fmt.Fprintf(&b, "\n## Regression\n\nThis looks like #%d again, which was fixed before this build.\n", report.Regression)
	}
	b.WriteString("\n## Environment\n\n" + environmentLines(env) + "\n")
	b.WriteString("\n_Reported by a coding agent from MoltenTerm (`molten bug report`), with the user's approval._\n")
	return RedactBugText(b.String())
}

// BugCommentBody is a case added to an existing issue, redacted.
func BugCommentBody(what string, env BugEnvironment) string {
	body := "Seen again:\n\n" + strings.TrimSpace(what) + "\n\n" + environmentLines(env) +
		"\n\n_Added by a coding agent from MoltenTerm (`molten bug comment`), with the user's approval._\n"
	return RedactBugText(body)
}

// NewIssueUrl is the repository's new-issue page, prefilled, for a user without gh; the body is shortened to fit.
func NewIssueUrl(repo string, title string, body string, labels []string) string {
	link := func(body string) string {
		q := url.Values{}
		q.Set("title", title)
		q.Set("body", body)
		q.Set("labels", strings.Join(labels, ","))
		return "https://github.com/" + repo + "/issues/new?" + q.Encode()
	}
	full := link(body)
	if len(full) <= maxIssueUrlLength {
		return full
	}
	const cut = "\n\n_(shortened to fit the link: add the rest here)_"
	runes := []rune(body)
	for len(runes) > 0 {
		runes = runes[:len(runes)*9/10]
		if u := link(string(runes) + cut); len(u) <= maxIssueUrlLength {
			return u
		}
	}
	return link(cut)
}
