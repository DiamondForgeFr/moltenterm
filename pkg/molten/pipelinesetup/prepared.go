// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What the prepared pipeline proposes beyond the steps (#1104, FR-MC-038 step 3), whichever provider drafted it: a
// check on each manual step a file can prove (#1095), and the project's formatter as versions.format when package.json
// has a format script. The developer drops either at step 3 (Options.NoCheck, Options.NoFormat).

const (
	DefaultChangelogHeading = "## [{version}]"

	maxChangelogScanBytes = 256 << 10
)

// A changelog's version heading as its file writes it: "## [1.2.0] - 2026-10-01", "## v1.2.0", "### 1.2.0 (date)".
var changelogHeadingRegex = regexp.MustCompile(`^(#{1,4}\s+)(\[?)(v?)[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?(\]?)`)

// changelogHeading: the text a changelog holds once a version's section is written, in that file's own form; the
// Keep a Changelog form when the file shows none.
func changelogHeading(dir string, rel string) string {
	path := filepath.Join(dir, filepath.FromSlash(rel))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxChangelogScanBytes {
		return DefaultChangelogHeading
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return DefaultChangelogHeading
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		m := changelogHeadingRegex.FindStringSubmatch(strings.TrimRight(scanner.Text(), "\r"))
		if m == nil {
			continue
		}
		hashes := strings.TrimRight(m[1], " \t") + " "
		if m[2] == "[" && m[4] == "]" {
			return hashes + "[" + m[3] + "{version}]"
		}
		return hashes + m[3] + "{version}"
	}
	return DefaultChangelogHeading
}

// changelogOf: the changelog a manual step writes, the longest known path its title or instructions name.
func changelogOf(step molten.PipelineStep, paths []string) string {
	best := ""
	for _, path := range paths {
		if path == "" || len(path) <= len(best) {
			continue
		}
		if strings.Contains(step.Title, path) || strings.Contains(step.Manual, path) {
			best = path
		}
	}
	return best
}

// labelCheck: the first label bumped by hand, its line with the version as {version}.
func labelCheck(f Facts, o Options) *molten.PipelineStepCheck {
	for _, c := range o.Labels {
		if c.Pattern != "" {
			continue
		}
		for _, l := range f.Labels {
			if l.Path != c.Path || l.Line != c.Line || l.Version == "" {
				continue
			}
			version := strings.TrimPrefix(l.Version, "v")
			text := strings.TrimSpace(l.Text)
			if !strings.Contains(text, version) {
				return nil
			}
			return &molten.PipelineStepCheck{Path: l.Path, Contains: strings.Replace(text, version, "{version}", 1)}
		}
	}
	return nil
}

// checkOf proposes what proves a manual step done; nil when no file can tell.
func checkOf(dir string, f Facts, o Options, step molten.PipelineStep) *molten.PipelineStepCheck {
	if step.Id == "bump-labels" {
		return labelCheck(f, o)
	}
	paths := append([]string{}, o.Changelogs...)
	for _, c := range f.Changelogs {
		paths = append(paths, c.Path)
	}
	path := changelogOf(step, paths)
	if path == "" {
		return nil
	}
	return &molten.PipelineStepCheck{Path: path, Contains: changelogHeading(dir, path)}
}

func proposeChannelChecks(dir string, f Facts, o Options, steps []molten.PipelineStep) {
	for i := range steps {
		s := &steps[i]
		if !s.IsManual() || s.Check != nil || hasChannel(o.NoCheck, s.Id) {
			continue
		}
		s.Check = checkOf(dir, f, o, *s)
	}
}

// ProposeChecks adds a check to each manual step of the proposal that has none, unless the developer dropped it.
func ProposeChecks(dir string, f Facts, o Options, r *molten.PipelineRelease) {
	if r == nil {
		return
	}
	proposeChannelChecks(dir, f, o, r.Rc)
	proposeChannelChecks(dir, f, o, r.Public)
}

type packageScripts struct {
	Scripts map[string]string `json:"scripts"`
}

// FormatCommandOf: the project's own format script, run by its package manager with the release's files appended;
// "" without one.
func FormatCommandOf(dir string) string {
	var pkg packageScripts
	if !readJson(filepath.Join(dir, "package.json"), &pkg) || strings.TrimSpace(pkg.Scripts["format"]) == "" {
		return ""
	}
	switch {
	case fileExists(filepath.Join(dir, "pnpm-lock.yaml")):
		return "pnpm run format"
	case fileExists(filepath.Join(dir, "yarn.lock")):
		return "yarn run format"
	case fileExists(filepath.Join(dir, "bun.lock")) || fileExists(filepath.Join(dir, "bun.lockb")):
		return "bun run format"
	}
	// npm hands the arguments after -- to the script.
	return "npm run format --"
}

func copyVersionsOf(v *molten.PipelineVersions) *molten.PipelineVersions {
	if v == nil {
		return &molten.PipelineVersions{}
	}
	data, _ := json.Marshal(v)
	var rtn molten.PipelineVersions
	json.Unmarshal(data, &rtn)
	return &rtn
}

// ProposeFormat sets versions.format to the project's format script when neither the committed pipeline nor the
// proposal declares a formatter.
func ProposeFormat(dir string, o Options, current *molten.Pipeline, p *Proposal) {
	if o.NoFormat {
		return
	}
	if p.Versions != nil && strings.TrimSpace(p.Versions.Format) != "" {
		return
	}
	if current != nil && current.Versions != nil && strings.TrimSpace(current.Versions.Format) != "" {
		return
	}
	command := FormatCommandOf(dir)
	if command == "" {
		return
	}
	if p.Versions == nil {
		var declared *molten.PipelineVersions
		if current != nil {
			declared = current.Versions
		}
		p.Versions = copyVersionsOf(declared)
	}
	p.Versions.Format = command
}
