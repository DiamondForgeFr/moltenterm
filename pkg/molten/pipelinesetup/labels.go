// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bufio"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// Version labels outside the version files (#1046): a README's "**v1.0.1**", a docs nav group, an example
// "version" in a guide, "Current version: 1.0.0-beta" in an agents file. The setup proposes each as a text entry of
// versions.files; one whose line no pattern can match once becomes a manual step of the cut.

const (
	maxLabelFiles      = 3000
	maxLabelFileBytes  = 256 << 10
	maxLabels          = 20
	maxLabelLineLength = 60
	// A line naming "version" may be a sentence's start, not a long prose paragraph.
	maxVersionLineLength = 100
	maxLabelTextLength   = 160
	maxLabelDepth        = 8
)

type VersionLabel struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	// The line as it reads (trimmed), and the version it holds.
	Text    string `json:"text"`
	Version string `json:"version"`
	// The text entry's pattern; empty when no pattern of the line matches it exactly once (a manual step then).
	Pattern string `json:"pattern"`
}

var labelVersionRegex = regexp.MustCompile(`v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?`)

// A line that names its version: "version" right before it ("Current version: 1.0.0-beta", "version": "1.0.1").
var versionWordRegex = regexp.MustCompile(`(?i)\bversion\b["'` + "`" + `]?\s*[:=]?\s*["'` + "`" + `]?v?[0-9]+\.[0-9]+\.[0-9]+`)

var labelTextExts = map[string]bool{".md": true, ".mdx": true, ".ts": true, ".mts": true, ".js": true, ".mjs": true,
	".cjs": true, ".json": true, ".yml": true, ".yaml": true, ".vue": true, ".txt": true}

var labelSkipDirs = map[string]bool{"node_modules": true, ".git": true, "dist": true, "build": true, "cache": true,
	".cache": true, "coverage": true, "releases": true}

func isChangelogName(name string) bool {
	return strings.HasPrefix(strings.ToLower(name), "changelog")
}

// labelFiles lists the files a label may be in: the top-level Markdown files and the text files under docs/.
func labelFiles(dir string) []string {
	var rtn []string
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			name := e.Name()
			if e.Type().IsRegular() && strings.EqualFold(filepath.Ext(name), ".md") && !isChangelogName(name) {
				rtn = append(rtn, name)
			}
		}
	}
	docs := filepath.Join(dir, "docs")
	filepath.WalkDir(docs, func(path string, d fs.DirEntry, err error) error {
		if err != nil || len(rtn) >= maxLabelFiles {
			return filepath.SkipDir
		}
		rel, _ := filepath.Rel(dir, path)
		if d.IsDir() {
			if path != docs && (labelSkipDirs[d.Name()] || strings.Count(rel, string(filepath.Separator)) >= maxLabelDepth) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() && labelTextExts[strings.ToLower(filepath.Ext(path))] && !isChangelogName(d.Name()) {
			rtn = append(rtn, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(rtn)
	return rtn
}

// labelOf reads one line as a label: the version it holds, and the text around it.
func labelOf(line string, current string) (string, string, string, bool) {
	trimmed := strings.TrimSpace(line)
	if word := versionWordRegex.FindStringIndex(trimmed); word != nil && len(trimmed) <= maxVersionLineLength {
		loc := labelVersionRegex.FindStringIndex(trimmed[word[0]:])
		return splitLabel(trimmed, word[0]+loc[0], word[0]+loc[1])
	}
	if current == "" || len(trimmed) > maxLabelLineLength {
		return "", "", "", false
	}
	for _, loc := range labelVersionRegex.FindAllStringIndex(trimmed, -1) {
		if strings.TrimPrefix(trimmed[loc[0]:loc[1]], "v") == current {
			return splitLabel(trimmed, loc[0], loc[1])
		}
	}
	return "", "", "", false
}

// splitLabel keeps a "v" before the version in the text before it: the label's prefix, not the version.
func splitLabel(line string, start int, end int) (string, string, string, bool) {
	if line[start] == 'v' {
		start++
	}
	return line[:start], line[start:end], line[end:], true
}

// DetectLabels finds the version labels of the project: lines holding the current version, short enough to be a
// label, or naming it after the word "version". Changelogs, notes and the declared files are history, not labels.
func DetectLabels(dir string, current string, skip map[string]bool) []VersionLabel {
	rtn := []VersionLabel{}
	for _, rel := range labelFiles(dir) {
		if skip[rel] {
			continue
		}
		full := filepath.Join(dir, filepath.FromSlash(rel))
		info, err := os.Stat(full)
		if err != nil || info.Size() > maxLabelFileBytes {
			continue
		}
		data, err := os.ReadFile(full)
		if err != nil || bytes.IndexByte(data, 0) >= 0 {
			continue
		}
		scanner := bufio.NewScanner(bytes.NewReader(data))
		scanner.Buffer(make([]byte, 0, 64<<10), maxLabelFileBytes)
		for n := 1; scanner.Scan(); n++ {
			before, version, after, ok := labelOf(scanner.Text(), current)
			if !ok {
				continue
			}
			label := VersionLabel{Path: rel, Line: n, Version: version, Text: strings.TrimSpace(scanner.Text())}
			if len(label.Text) > maxLabelTextLength {
				label.Text = label.Text[:maxLabelTextLength] + "…"
			}
			label.Pattern = uniquePattern(dir, rel, before, after)
			rtn = append(rtn, label)
			if len(rtn) >= maxLabels {
				return rtn
			}
		}
	}
	return rtn
}

// uniquePattern is the line's own text around {version}, kept only when it matches the file exactly once; else the
// same anchored to a whole line.
func uniquePattern(dir string, rel string, before string, after string) string {
	pattern := versions.TextLabelPattern(before, after)
	if versions.CheckFile(dir, versions.VersionFile{Path: rel, Format: versions.FileFormatText, Pattern: pattern}) == nil {
		return pattern
	}
	anchored := `(?m)^\s*` + pattern + `\s*$`
	if versions.CheckFile(dir, versions.VersionFile{Path: rel, Format: versions.FileFormatText, Pattern: anchored}) == nil {
		return anchored
	}
	return ""
}

// LabelChoice is a label the developer kept.
type LabelChoice struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`
	Pattern string `json:"pattern,omitempty"`
}
