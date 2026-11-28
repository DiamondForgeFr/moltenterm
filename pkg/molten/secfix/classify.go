// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"regexp"
	"strings"
)

// What a check is to the scan (FR-REV-036 AC1 to AC3).
const (
	ClassNone      = "none"
	ClassDeclared  = "declared"
	ClassConfirmed = "confirmed"
	// A name that looks like a scan: it is offered to the developer once and acted on only after the answer.
	ClassCandidate = "candidate"
)

// ScannerWords are the names a scan usually has; a match is only a reason to look at the check's failed log.
var ScannerWords = []string{"audit", "vuln", "security", "dependenc", "osv", "govulncheck", "snyk", "trivy"}

// Check is a check of a pull request as GitHub shows it.
type Check struct {
	Name     string
	Workflow string
	Local    bool
	Failed   bool
	RunId    int64
	JobId    int64
}

// Policy is what MoltenTerm knows of a project's scan: its declaration, and the answers the developer gave once.
type Policy struct {
	Declaration *Declaration
	Confirmed   []string
	Dismissed   []string
}

// Classify says what a check is: the project's scan (declared, or confirmed by the developer), a candidate to offer, or
// nothing. Only a failed check can be one, and a local CI status never is.
func (p Policy) Classify(check Check) string {
	if !check.Failed || check.Local || isLocalCiName(check.Name) {
		return ClassNone
	}
	if p.Declaration != nil {
		for _, pattern := range p.Declaration.Checks {
			if matchCheck(pattern, check) {
				return ClassDeclared
			}
		}
	}
	for _, name := range p.Confirmed {
		if matchCheck(name, check) {
			return ClassConfirmed
		}
	}
	for _, name := range p.Dismissed {
		if matchCheck(name, check) {
			return ClassNone
		}
	}
	// A project that names its scan has taken charge of it: nothing else is guessed.
	if p.Declaration != nil && len(p.Declaration.Checks) > 0 {
		return ClassNone
	}
	if looksLikeScan(check) {
		return ClassCandidate
	}
	return ClassNone
}

// isLocalCiName: a check the local CI reports, by `molten ci run`'s status name or a name that says so ("AI testing /
// Local CI").
func isLocalCiName(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "local-") || strings.Contains(lower, "local ci") || strings.Contains(lower, "local-ci")
}

func looksLikeScan(check Check) bool {
	text := strings.ToLower(check.Name + " " + check.Workflow)
	for _, word := range ScannerWords {
		if strings.Contains(text, word) {
			return true
		}
	}
	return false
}

var spaceRe = regexp.MustCompile(`\s+`)

func normalizeName(name string) string {
	return strings.ToLower(strings.TrimSpace(spaceRe.ReplaceAllString(name, " ")))
}

// matchCheck tells whether a declared or confirmed name is this check: its name, or "workflow / name"; `*` stands for any
// text.
func matchCheck(pattern string, check Check) bool {
	pattern = normalizeName(pattern)
	if pattern == "" {
		return false
	}
	names := []string{normalizeName(check.Name)}
	if check.Workflow != "" {
		names = append(names, normalizeName(check.Workflow+" / "+check.Name))
	}
	for _, name := range names {
		if matchWildcard(pattern, name) {
			return true
		}
	}
	return false
}

func matchWildcard(pattern string, name string) bool {
	if !strings.Contains(pattern, "*") {
		return pattern == name
	}
	parts := strings.Split(pattern, "*")
	for i, part := range parts {
		parts[i] = regexp.QuoteMeta(part)
	}
	re, err := regexp.Compile("^" + strings.Join(parts, ".*") + "$")
	return err == nil && re.MatchString(name)
}
