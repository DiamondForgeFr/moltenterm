// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"regexp"
	"strings"
)

// The changelogs a release writes by hand (versions.changelogs): which manual step writes which one, and in which
// language, shared by the pipeline setup that drafts the steps and the release panel that checks them (#1142).

var changelogLangSuffixRegex = regexp.MustCompile(`(?i)\.([a-z]{2})\.md$`)
var changelogLangDirRegex = regexp.MustCompile(`^[a-z]{2}$`)

// ChangelogLang reads a changelog's language from its path: CHANGELOG.fr.md, docs/fr/changelog.md; "en" otherwise.
func ChangelogLang(path string) string {
	if m := changelogLangSuffixRegex.FindStringSubmatch(path); m != nil {
		return strings.ToLower(m[1])
	}
	if parts := strings.Split(path, "/"); len(parts) == 3 && changelogLangDirRegex.MatchString(parts[1]) {
		return parts[1]
	}
	return "en"
}

// ChangelogOfStep is the changelog a manual step writes: its check's file when it is one of the paths, else the longest
// path its title or instructions name; "" for a step that writes none.
func ChangelogOfStep(step PipelineStep, paths []string) string {
	if !step.IsManual() {
		return ""
	}
	best := ""
	for _, path := range paths {
		if path == "" {
			continue
		}
		if step.Check != nil && step.Check.Path == path {
			return path
		}
		if len(path) <= len(best) {
			continue
		}
		if strings.Contains(step.Title, path) || strings.Contains(step.Manual, path) {
			best = path
		}
	}
	return best
}

// DeclaredChangelogs: the pipeline's versions.changelogs.
func DeclaredChangelogs(p *Pipeline) []string {
	if p == nil || p.Versions == nil {
		return nil
	}
	return p.Versions.Changelogs
}
